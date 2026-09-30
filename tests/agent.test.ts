import { describe, expect, it } from 'vitest';

import { SiteAgent } from '@/agent/agent';
import {
  AGENT_CAPABILITIES,
  AgentWorkspace,
  SITE_PUBLISH_CAPABILITY,
  SOCIAL_COMPOSE_CAPABILITY,
  type Draft,
} from '@/agent/capabilities';
import { CapabilityGateway } from '@/embodiment/capabilities';
import { AgentEventBus } from '@/embodiment/events';

/**
 * Tests for the site agent.
 *
 * The important ones are negative: an agent that can act is only acceptable if
 * the things it cannot do are actually impossible, not merely undocumented.
 */

function makeAgent() {
  const events = new AgentEventBus();
  const gateway = new CapabilityGateway(events);
  const workspace = new AgentWorkspace();
  const agent = new SiteAgent({
    gateway,
    events,
    workspace,
    source: { observe: () => ({ ok: true }) },
  });
  return { agent, gateway, workspace, events };
}

/** A snapshot shaped like the experiment's, with a decision present. */
function snapshotWithDecision(time = 4.2) {
  return {
    runtime: {
      simulationTime: time,
      body: { distanceTravelled: 12.5, boutState: 'turn-bout' },
    },
    evidence: { coherence: 0.8 },
    populations: {
      decisionVariable: 0.21,
      threshold: 0.15,
      populations: [
        { id: 'I', label: 'Class I', left: 0.08, right: 0.19, neuronCount: 492 },
        { id: 'SPN_turning', label: 'SPN', left: 0.05, right: 0.2, neuronCount: 56 },
      ],
    },
    intent: {
      time,
      action: 'turn_right' as const,
      confidence: 0.4,
      evidence: { decisionVariable: 0.21, threshold: 0.15, latency: 1.27 },
    },
    connectomeCoupled: true,
  } as never;
}

describe('agent capability surface', () => {
  it('registers only the four site capabilities', () => {
    const { gateway } = makeAgent();
    const ids = gateway
      .list()
      .map((c) => c.definition.id)
      .sort();
    expect(ids).toEqual(['site.draft', 'site.publish', 'site.read', 'social.compose']);
  });

  it('has no capability that reaches the network, filesystem or a shell', () => {
    for (const capability of AGENT_CAPABILITIES) {
      expect(capability.id).not.toMatch(
        /http|fetch|net|file|fs|shell|exec|post|send|publish_to/i,
      );
      expect(capability.description).not.toMatch(/\bapi key\b|credential|token/i);
    }
  });

  it('caps anything that changes what the site says at APPROVAL', () => {
    // A configuration change must not be able to promote this to unattended.
    expect(SITE_PUBLISH_CAPABILITY.maxMode).toBe('approval');
    expect(SITE_PUBLISH_CAPABILITY.requiresApproval).toBe(true);
  });

  it('does not gate composing, because composing has no external effect', () => {
    // The risk worth gating is sending, and sending does not exist here.
    expect(SOCIAL_COMPOSE_CAPABILITY.requiresApproval).toBe(false);
    expect(SOCIAL_COMPOSE_CAPABILITY.description).toMatch(/no code that can post/i);
  });

  it('refuses a capability it was never given', async () => {
    const { gateway } = makeAgent();
    const result = await gateway.request(
      {
        capabilityId: 'social.post',
        action: 'post',
        arguments: {},
        reason: 'Trying to post directly.',
      },
      0,
    );
    expect(result.status).toBe('denied');
    expect(result.reason).toMatch(/unknown capability/i);
  });

  it('refuses any request carrying a credential-shaped field', async () => {
    const { gateway } = makeAgent();
    const result = await gateway.request(
      {
        capabilityId: 'site.draft',
        action: 'write',
        arguments: { title: 'x', body: 'y', apiKey: 'sk-live-123' },
        reason: 'Attempting to smuggle a secret.',
      },
      0,
    );
    expect(result.status).toBe('denied');
    expect(result.reason).toMatch(/credential/i);
  });
});

describe('the agent cannot act alone', () => {
  it('queues a publish instead of performing it', async () => {
    const { agent, gateway, workspace } = makeAgent();
    agent.start(0);
    await agent.tick(1, snapshotWithDecision());

    // It wrote something, but nothing is on the site.
    expect(workspace.all().length).toBeGreaterThan(0);
    expect(workspace.publishedDrafts().length).toBe(0);
    // And it is waiting.
    expect(gateway.pending().length).toBe(1);
    expect(gateway.pending()[0].definition.id).toBe('site.publish');
  });

  it('publishes only once a human approves', async () => {
    const { agent, gateway, workspace } = makeAgent();
    agent.start(0);
    await agent.tick(1, snapshotWithDecision());

    const requestId = gateway.pending()[0].request.id;
    const result = await gateway.approve(requestId, 2);
    expect(result?.status).toBe('executed');
    expect(workspace.publishedDrafts().length).toBe(1);
    expect(gateway.pending().length).toBe(0);
  });

  it('publishes nothing when a human denies', async () => {
    const { agent, gateway, workspace } = makeAgent();
    agent.start(0);
    await agent.tick(1, snapshotWithDecision());

    const requestId = gateway.pending()[0].request.id;
    expect(gateway.deny(requestId, 'No.', 2)).toBe(true);
    expect(workspace.publishedDrafts().length).toBe(0);
    expect(gateway.pending().length).toBe(0);
  });

  it('cannot approve its own request', async () => {
    const { agent, gateway } = makeAgent();
    agent.start(0);
    await agent.tick(1, snapshotWithDecision());
    // The agent holds no reference to approve(); the only path is the gateway,
    // keyed by an id the gateway issued. Nothing on the agent exposes it.
    expect((agent as unknown as Record<string, unknown>).approve).toBeUndefined();
    expect(gateway.pending().length).toBe(1);
  });

  it('composes a post and queues it rather than sending it', async () => {
    const { agent, gateway, workspace } = makeAgent();
    agent.start(0);
    await agent.composePost(1, snapshotWithDecision(), 'instagram');

    const social = workspace.all().find((d: Draft) => d.kind === 'social');
    expect(social).toBeDefined();
    expect(social!.platform).toBe('instagram');
    // Written, and never published by anything in this application.
    expect(social!.published).toBe(false);
    expect(workspace.publishedDrafts().length).toBe(0);
    // No send was queued either, because no capability can send.
    expect(gateway.list().some((c) => /post|send/i.test(c.definition.id))).toBe(false);
  });
});

describe('agent behaviour', () => {
  it('takes no turn while stopped', async () => {
    const { agent, workspace } = makeAgent();
    await agent.tick(1, snapshotWithDecision());
    expect(workspace.all().length).toBe(0);
  });

  it('rate-limits itself to one turn per interval', async () => {
    const { agent } = makeAgent();
    agent.start(0);
    await agent.tick(1, snapshotWithDecision());
    const after = agent.history().length;
    // Immediately again: too soon, so nothing new happens.
    await agent.tick(1.2, snapshotWithDecision());
    expect(agent.history().length).toBe(after);
  });

  it('writes only values the run actually produced', async () => {
    const { agent, workspace } = makeAgent();
    agent.start(0);
    await agent.tick(1, snapshotWithDecision(4.2));
    const note = workspace.all()[0];
    expect(note.body).toContain('0.2100');
    expect(note.body).toContain('1.270');
    // And it never presents simulation as measurement.
    expect(note.body).toMatch(/Neural activity simulated/i);
    expect(note.body).not.toMatch(/\bthought|felt|wanted|decided to feel/i);
  });

  it('records every step it takes, with the capability it used', async () => {
    const { agent } = makeAgent();
    agent.start(0);
    await agent.tick(1, snapshotWithDecision());
    const used = agent
      .history()
      .map((s) => s.capabilityId)
      .filter(Boolean);
    expect(used).toContain('site.read');
    expect(used).toContain('site.draft');
    expect(used).toContain('site.publish');
  });

  it('clears its workspace and queue on reset', async () => {
    const { agent, gateway, workspace } = makeAgent();
    agent.start(0);
    await agent.tick(1, snapshotWithDecision());
    agent.reset();
    expect(workspace.all().length).toBe(0);
    expect(gateway.pending().length).toBe(0);
    expect(agent.history().length).toBe(0);
  });
});
