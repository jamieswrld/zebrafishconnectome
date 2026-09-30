import type { AgentEventBus } from '@/embodiment/events';
import type { CapabilityGateway, CapabilityResult } from '@/embodiment/capabilities';
import type { ExperimentSnapshot } from '@/embodiment/experiment';
import {
  AGENT_CAPABILITIES,
  AgentWorkspace,
  createAgentExecutors,
  type Draft,
  type ObservationSource,
} from './capabilities';

/**
 * The site agent.
 *
 * It watches the organism run and writes about what it sees. Every step goes
 * through the capability gateway, so the console can show the whole chain:
 * what it looked at, what it decided to write, what it wants published, and
 * what a person did about it.
 *
 * WHAT THIS IS NOT
 *
 * It is not a language model and there is no model in the loop. It is a small
 * rule-driven observer whose output is assembled from measured and simulated
 * values it can actually cite. That is a deliberate choice, not a limitation
 * of convenience: an LLM writing copy about a scientific simulation would
 * produce fluent sentences that nobody could trace to a number, which is the
 * one thing this project has spent three phases refusing to do.
 *
 * It also has no memory of anything outside this page, no network, and no way
 * to act on the world except by putting text in a queue for a person.
 */

export type AgentActivity = 'idle' | 'observing' | 'writing' | 'awaiting-approval' | 'stopped';

export interface AgentStep {
  readonly id: string;
  readonly at: number;
  readonly activity: AgentActivity;
  /** What the agent did, in one line, for the live console. */
  readonly summary: string;
  /** The capability it went through, if any. */
  readonly capabilityId?: string;
  readonly status?: CapabilityResult['status'];
  readonly detail?: string;
}

export interface AgentOptions {
  readonly gateway: CapabilityGateway;
  readonly events: AgentEventBus;
  readonly workspace: AgentWorkspace;
  readonly source: ObservationSource;
}

/** How often the agent takes a turn, in seconds of wall clock. */
const TURN_SECONDS = 6;
/** A run must have produced this many decisions before it is worth writing up. */
const MIN_DECISIONS_TO_REPORT = 1;

export class SiteAgent {
  readonly workspace: AgentWorkspace;

  private readonly gateway: CapabilityGateway;
  private readonly source: ObservationSource;
  private steps: AgentStep[] = [];
  private sequence = 0;
  private running = false;
  private nextTurnAt = 0;
  private activity: AgentActivity = 'stopped';
  private lastReportedDecision = -1;
  private busy = false;

  constructor(options: AgentOptions) {
    this.gateway = options.gateway;
    this.workspace = options.workspace;
    this.source = options.source;

    // Register every capability the agent can use, each with its own ceiling.
    // Nothing is registered that this build cannot honestly perform.
    const executors = createAgentExecutors(options.workspace, options.source);
    for (const definition of AGENT_CAPABILITIES) {
      const startingMode = definition.requiresApproval ? 'approval' : 'autonomous';
      this.gateway.register(definition, executors[definition.id], startingMode);
    }
  }

  /* ------------------------------------------------------------- control */

  start(now: number): void {
    this.running = true;
    this.activity = 'idle';
    this.nextTurnAt = now;
    this.note('idle', 'Agent started. Watching the organism.');
  }

  stop(): void {
    this.running = false;
    this.activity = 'stopped';
    this.note('stopped', 'Agent stopped. It takes no turns while stopped.');
  }

  isRunning(): boolean {
    return this.running;
  }

  currentActivity(): AgentActivity {
    return this.activity;
  }

  history(): readonly AgentStep[] {
    return this.steps;
  }

  reset(): void {
    this.steps = [];
    this.sequence = 0;
    this.lastReportedDecision = -1;
    this.workspace.clear();
    this.gateway.clearQueue();
    this.activity = this.running ? 'idle' : 'stopped';
  }

  /* ---------------------------------------------------------------- turn */

  /**
   * Gives the agent a turn if one is due.
   *
   * Called from the render loop, but rate-limited to its own cadence: an agent
   * that acted every frame would produce sixty observations a second and an
   * unreadable log.
   */
  async tick(now: number, snapshot: ExperimentSnapshot | null): Promise<void> {
    if (!this.running || this.busy || now < this.nextTurnAt) return;
    this.busy = true;
    this.nextTurnAt = now + TURN_SECONDS;
    try {
      await this.takeTurn(now, snapshot);
    } finally {
      this.busy = false;
    }
  }

  private async takeTurn(now: number, snapshot: ExperimentSnapshot | null): Promise<void> {
    /* 1. Look. */
    this.activity = 'observing';
    const read = await this.gateway.request(
      {
        capabilityId: 'site.read',
        action: 'observe',
        arguments: {},
        reason: 'Routine observation of the running organism.',
      },
      now,
    );
    const observation = read.result as Record<string, unknown> | undefined;
    if (!observation || !snapshot) {
      this.note('idle', 'Nothing to observe yet.', 'site.read', read.status);
      this.activity = 'idle';
      return;
    }

    this.note(
      'observing',
      `Observed the organism at ${snapshot.runtime.simulationTime.toFixed(1)} s.`,
      'site.read',
      read.status,
      describeObservation(snapshot),
    );

    /* 2. Decide whether there is anything worth writing. */
    const decisions = this.workspace.all();
    void decisions;
    const decisionCount = countDecisions(snapshot);
    if (
      decisionCount < MIN_DECISIONS_TO_REPORT ||
      decisionCount === this.lastReportedDecision
    ) {
      this.activity = 'idle';
      return;
    }
    this.lastReportedDecision = decisionCount;

    /* 3. Write it down. */
    this.activity = 'writing';
    const note = composeNote(snapshot);
    const draft = await this.gateway.request(
      {
        capabilityId: 'site.draft',
        action: 'write',
        arguments: {
          kind: 'note',
          title: note.title,
          body: note.body,
          observedAt: snapshot.runtime.simulationTime,
        },
        reason: 'The circuit reached a decision worth recording.',
      },
      now,
    );
    const written = draft.result as Draft | undefined;
    this.note('writing', `Wrote "${note.title}".`, 'site.draft', draft.status);

    /* 4. Ask to publish it. This is where a person is required. */
    if (written) {
      const publish = await this.gateway.request(
        {
          capabilityId: 'site.publish',
          action: 'publish',
          arguments: { draftId: written.id, title: note.title, body: note.body },
          reason: 'Publishing the observation to the page log.',
        },
        now,
      );
      this.note(
        'awaiting-approval',
        `Asked to publish "${note.title}".`,
        'site.publish',
        publish.status,
        publish.reason,
      );
      this.activity = publish.status === 'pending-approval' ? 'awaiting-approval' : 'idle';
      return;
    }

    this.activity = 'idle';
  }

  /** Composes a post for a platform and queues it. Never sends. */
  async composePost(now: number, snapshot: ExperimentSnapshot | null, platform: string) {
    if (!snapshot) return null;
    const post = composePost(snapshot, platform);
    const result = await this.gateway.request(
      {
        capabilityId: 'social.compose',
        action: 'compose',
        arguments: {
          kind: 'social',
          platform,
          title: post.title,
          body: post.body,
          observedAt: snapshot.runtime.simulationTime,
        },
        reason: `Drafting a ${platform} post about the current run. Composing only.`,
      },
      now,
    );
    this.note(
      'writing',
      `Composed a ${platform} post. It will not be sent by this application.`,
      'social.compose',
      result.status,
      result.reason,
    );
    return result;
  }

  private note(
    activity: AgentActivity,
    summary: string,
    capabilityId?: string,
    status?: CapabilityResult['status'],
    detail?: string,
  ): void {
    this.steps.unshift({
      id: `step-${++this.sequence}`,
      at: Date.now(),
      activity,
      summary,
      capabilityId,
      status,
      detail,
    });
    if (this.steps.length > 80) this.steps.length = 80;
  }
}

/* -------------------------------------------------------------------------- */
/* What the agent writes                                                      */
/* -------------------------------------------------------------------------- */

function countDecisions(snapshot: ExperimentSnapshot): number {
  return snapshot.intent ? 1 : 0;
}

function describeObservation(snapshot: ExperimentSnapshot): string {
  const populations = snapshot.populations;
  if (!populations) return 'No neural state yet.';
  return (
    `decision variable ${populations.decisionVariable.toFixed(3)}, ` +
    `coupling ${snapshot.connectomeCoupled ? 'on' : 'off'}, ` +
    `${snapshot.runtime.body.distanceTravelled.toFixed(1)} mm swum`
  );
}

/**
 * Builds a note entirely out of values the run actually produced.
 *
 * Every number here is one the console can show alongside it. Nothing is
 * characterised, embellished, or described as something the animal experienced.
 */
function composeNote(snapshot: ExperimentSnapshot): { title: string; body: string } {
  const intent = snapshot.intent;
  const populations = snapshot.populations;
  const direction = intent?.action === 'turn_right' ? 'right' : 'left';

  const title = intent
    ? `Turn ${direction} at ${intent.time.toFixed(2)} s`
    : `Observation at ${snapshot.runtime.simulationTime.toFixed(1)} s`;

  const lines: string[] = [];
  if (intent) {
    lines.push(
      `The Fish1 HMI simulation selected a ${direction} turn ${intent.evidence.latency.toFixed(3)} s after evidence began accumulating.`,
      `Decision variable ${intent.evidence.decisionVariable.toFixed(4)} against a threshold of ${intent.evidence.threshold.toFixed(2)}.`,
    );
  }
  if (populations) {
    const classI = populations.populations.find((p) => p.id === 'I');
    const readout = populations.populations.find((p) => p.id === 'SPN_turning');
    if (classI) {
      lines.push(
        `Class I population rate: left ${classI.left.toFixed(3)}, right ${classI.right.toFixed(3)}.`,
      );
    }
    if (readout) {
      lines.push(
        `SPN_turning readout: left ${readout.left.toFixed(3)}, right ${readout.right.toFixed(3)}.`,
      );
    }
  }
  lines.push(
    `Stimulus: ${(snapshot.evidence.coherence * 100).toFixed(0)}% coherent motion.`,
    `Body: ${snapshot.runtime.body.distanceTravelled.toFixed(1)} mm swum, bout state ${snapshot.runtime.body.boutState}.`,
    '',
    'Connectivity measured. Neural activity simulated. Body movement simulated.',
  );

  return { title, body: lines.join('\n') };
}

function composePost(
  snapshot: ExperimentSnapshot,
  platform: string,
): { title: string; body: string } {
  const intent = snapshot.intent;
  const direction = intent?.action === 'turn_right' ? 'right' : 'left';
  const body = intent
    ? [
        `A connectome-constrained simulation of 865 reconstructed Fish1 neurons just decided to turn ${direction}.`,
        '',
        `Evidence accumulated for ${intent.evidence.latency.toFixed(2)} s before the readout crossed threshold.`,
        'Connectivity: measured, 1,235 traced synaptic pairs.',
        'Activity: simulated. The dataset contains no recordings.',
      ].join('\n')
    : 'A connectome-constrained simulation of 865 reconstructed Fish1 neurons, running live.';
  return { title: `Draft for ${platform}`, body };
}
