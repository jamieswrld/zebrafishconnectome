import type {
  CapabilityDefinition,
  CapabilityExecutor,
  CapabilityRequest,
} from '@/embodiment/capabilities';

/**
 * What the site agent is allowed to do.
 *
 * The agent observes the running organism and writes about it. That is a real
 * capability — it reads live state and produces content that can end up on the
 * site — so it goes through the same gateway as anything else, with the same
 * audit trail.
 *
 * WHAT IS DELIBERATELY ABSENT
 *
 * There is no network access, no filesystem access, no shell, and no
 * credential of any kind anywhere in this module. In particular there is no
 * capability that posts to an external platform. The agent can COMPOSE a post
 * and put it in the queue; a person publishes it, from their own account, with
 * their own hands.
 *
 * That is not squeamishness about autonomy. Automated account creation and
 * unattended posting breach the terms of every major platform, they require
 * handing an agent real credentials, and they act on real people under the
 * operator's name. Composing-and-queueing gets the same work done and leaves
 * the accountable act with the accountable party.
 *
 * Everything here writes to an in-memory store owned by the page. Nothing
 * survives a reload, and nothing leaves the browser.
 */

/* -------------------------------------------------------------------------- */
/* The store the agent writes into                                            */
/* -------------------------------------------------------------------------- */

export type DraftKind = 'note' | 'page' | 'social';

export interface Draft {
  readonly id: string;
  readonly kind: DraftKind;
  readonly title: string;
  readonly body: string;
  readonly createdAt: number;
  /** Simulation time the observation was taken at. */
  readonly observedAt: number;
  readonly published: boolean;
  /** Which platform a social draft is written for. Never posted automatically. */
  readonly platform?: string;
}

/**
 * The agent's workspace.
 *
 * A plain in-memory store rather than a database or the filesystem, because the
 * agent's write access should be exactly as large as the feature needs and not
 * one byte larger.
 */
export class AgentWorkspace {
  private drafts: Draft[] = [];
  private sequence = 0;

  create(init: Omit<Draft, 'id' | 'createdAt' | 'published'>): Draft {
    const draft: Draft = {
      ...init,
      id: `draft-${++this.sequence}`,
      createdAt: Date.now(),
      published: false,
    };
    this.drafts.unshift(draft);
    // Bounded: an agent left running for hours must not grow memory forever.
    if (this.drafts.length > 60) this.drafts.length = 60;
    return draft;
  }

  publish(id: string): Draft | null {
    const index = this.drafts.findIndex((d) => d.id === id);
    if (index < 0) return null;
    const published = { ...this.drafts[index], published: true };
    this.drafts[index] = published;
    return published;
  }

  all(): readonly Draft[] {
    return this.drafts;
  }

  publishedDrafts(): readonly Draft[] {
    return this.drafts.filter((d) => d.published);
  }

  clear(): void {
    this.drafts = [];
    this.sequence = 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Capability definitions                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Reading the organism's own state.
 *
 * No approval, because it touches nothing outside the page and produces no
 * effect a person would want to review. It is still logged, so the record of
 * what the agent looked at is complete.
 */
export const SITE_READ_CAPABILITY: CapabilityDefinition = {
  id: 'site.read',
  name: 'Read the organism',
  description:
    "Reads the running simulation's own state: population rates, decisions, stimulus and body. Local to the page; no network.",
  risk: 'none',
  requiresApproval: false,
  maxMode: 'autonomous',
  rateLimitPerMinute: 120,
};

/** Writing a draft into the agent's own workspace. Nothing is visible yet. */
export const SITE_DRAFT_CAPABILITY: CapabilityDefinition = {
  id: 'site.draft',
  name: 'Write a draft',
  description:
    "Writes a note into the agent's workspace. Drafts are not on the site and are not visible to anyone but the operator.",
  risk: 'low',
  requiresApproval: false,
  maxMode: 'autonomous',
  rateLimitPerMinute: 20,
};

/**
 * Putting a draft on the site.
 *
 * Requires approval, because this is the point at which something the agent
 * wrote becomes something the site says.
 */
export const SITE_PUBLISH_CAPABILITY: CapabilityDefinition = {
  id: 'site.publish',
  name: 'Publish to the site',
  description:
    'Moves a draft into the published log on this page. Always requires a human decision.',
  risk: 'medium',
  requiresApproval: true,
  maxMode: 'approval',
  rateLimitPerMinute: 6,
};

/**
 * Composing a post for an external platform.
 *
 * Composes only, into the local workspace. It needs no approval for the same
 * reason site.draft does not: writing text that nobody but the operator can see
 * has no external effect. Gating it would be security theatre with a real cost,
 * because you would have to approve a draft before you were allowed to read it.
 *
 * The risk that would justify a gate - actually posting - is not mitigated
 * here, it is absent: there is no executor in this codebase that sends anything
 * to any platform, and no capability that could acquire one.
 */
export const SOCIAL_COMPOSE_CAPABILITY: CapabilityDefinition = {
  id: 'social.compose',
  name: 'Compose a post (never sends)',
  description:
    'Drafts text for an external platform into the local workspace. This build contains no code that can post anything anywhere; a person copies it out and posts it themselves.',
  risk: 'low',
  requiresApproval: false,
  maxMode: 'autonomous',
  rateLimitPerMinute: 4,
};

export const AGENT_CAPABILITIES: readonly CapabilityDefinition[] = [
  SITE_READ_CAPABILITY,
  SITE_DRAFT_CAPABILITY,
  SITE_PUBLISH_CAPABILITY,
  SOCIAL_COMPOSE_CAPABILITY,
];

/* -------------------------------------------------------------------------- */
/* Executors                                                                  */
/* -------------------------------------------------------------------------- */

export interface ObservationSource {
  /** A snapshot of whatever the agent is allowed to see. */
  observe(): Record<string, unknown>;
}

export function createAgentExecutors(
  workspace: AgentWorkspace,
  source: ObservationSource,
): Record<string, CapabilityExecutor> {
  return {
    'site.read': {
      async execute() {
        return source.observe();
      },
    },
    'site.draft': {
      async execute(request: CapabilityRequest) {
        const args = (request.arguments ?? {}) as Partial<Draft>;
        return workspace.create({
          kind: (args.kind as DraftKind) ?? 'note',
          title: args.title ?? 'Untitled',
          body: args.body ?? '',
          observedAt: args.observedAt ?? 0,
          platform: args.platform,
        });
      },
    },
    'site.publish': {
      async execute(request: CapabilityRequest) {
        const args = (request.arguments ?? {}) as { draftId?: string };
        if (!args.draftId) throw new Error('No draft id was supplied.');
        const published = workspace.publish(args.draftId);
        if (!published) throw new Error(`Draft ${args.draftId} no longer exists.`);
        return published;
      },
    },
    'social.compose': {
      async execute(request: CapabilityRequest) {
        const args = (request.arguments ?? {}) as Partial<Draft>;
        // Composes. Does not send. There is no send.
        return workspace.create({
          kind: 'social',
          title: args.title ?? 'Post',
          body: args.body ?? '',
          observedAt: args.observedAt ?? 0,
          platform: args.platform ?? 'unspecified',
        });
      },
    },
  };
}
