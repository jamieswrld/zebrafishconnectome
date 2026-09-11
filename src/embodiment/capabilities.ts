import type { AgentEventBus } from './events';

/**
 * Capability gateway: the boundary through which the organism could one day
 * act outside its tank.
 *
 * NOTHING IN THIS BUILD GRANTS EXTERNAL ACCESS.
 *
 * There is no network client here, no shell, no filesystem, no credentials, and
 * the only registered capability is a sandboxed no-op. What exists is the
 * architecture that makes external agency governable if it is ever enabled:
 *
 *   POLICY -> CapabilityRequest -> GATEWAY (permission check, rate limit,
 *             audit) -> server-side executor -> result
 *
 * Three rules are enforced structurally rather than by convention:
 *
 *  1. The policy can only request capabilities that were explicitly registered.
 *     An unknown id is denied; there is no "allow everything" switch.
 *  2. Permissions are PER CAPABILITY, not global. Raising one to AUTONOMOUS
 *     says nothing about any other.
 *  3. Secrets never reach the requester. Arguments and results crossing this
 *     boundary are scrubbed, and a credential-shaped value is rejected outright
 *     rather than forwarded. The fish never holds an API key.
 */

export type PermissionMode =
  /** No external actions at all. The only mode this build ships. */
  | 'observe'
  /** Only against isolated simulations or test services. */
  | 'sandbox'
  /** The organism proposes; a human approves each one. */
  | 'approval'
  /** Explicitly allowlisted low-risk capabilities may execute unattended. */
  | 'autonomous';

export const PERMISSION_MODES: Record<PermissionMode, { label: string; description: string }> =
  {
    observe: {
      label: 'OBSERVE',
      description: 'No external actions are possible. Requests are logged and denied.',
    },
    sandbox: {
      label: 'SANDBOX',
      description: 'Actions may run only against isolated simulated services.',
    },
    approval: {
      label: 'APPROVAL',
      description: 'Each action must be approved by a human before it executes.',
    },
    autonomous: {
      label: 'AUTONOMOUS',
      description: 'Allowlisted low-risk capabilities execute without prompting.',
    },
  };

export type CapabilityRisk = 'none' | 'low' | 'medium' | 'high';

export interface CapabilityDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly risk: CapabilityRisk;
  readonly requiresApproval: boolean;
  /** Highest permission mode at which this capability may ever run. */
  readonly maxMode: PermissionMode;
  /** Maximum executions per minute. */
  readonly rateLimitPerMinute: number;
}

export interface CapabilityRequest {
  readonly id: string;
  readonly capabilityId: string;
  readonly action: string;
  readonly arguments: unknown;
  /** Why the policy wants this. Recorded for audit. */
  readonly reason: string;
  readonly requestedAt: number;
}

export type CapabilityStatus =
  'approved' | 'denied' | 'executed' | 'failed' | 'rate-limited' | 'pending-approval';

export interface CapabilityResult {
  readonly requestId: string;
  readonly status: CapabilityStatus;
  readonly reason: string;
  readonly result?: unknown;
}

export interface CapabilityExecutor {
  /** Runs the action. Implemented server-side for anything with real effect. */
  execute(request: CapabilityRequest): Promise<unknown>;
}

/** Keys that must never cross the gateway in either direction. */
const FORBIDDEN_KEY = /(token|secret|password|api[-_]?key|authorization|cookie|credential)/i;

/**
 * Recursively rejects credential-shaped content.
 *
 * Defence in depth: the policy should never have a secret to leak, but if one
 * ever reached a request payload, forwarding it would be the single worst
 * failure this subsystem could have.
 */
export function containsSecretLikeField(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => containsSecretLikeField(v, depth + 1));
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key)) return true;
    if (containsSecretLikeField(child, depth + 1)) return true;
  }
  return false;
}

interface RegisteredCapability {
  readonly definition: CapabilityDefinition;
  readonly executor: CapabilityExecutor | null;
  mode: PermissionMode;
  recentExecutions: number[];
}

export class CapabilityGateway {
  private capabilities = new Map<string, RegisteredCapability>();
  private sequence = 0;

  constructor(private readonly events: AgentEventBus) {}

  register(
    definition: CapabilityDefinition,
    executor: CapabilityExecutor | null = null,
    mode: PermissionMode = 'observe',
  ): void {
    this.capabilities.set(definition.id, {
      definition,
      executor,
      // A capability can never start above its own ceiling.
      mode: this.clampMode(mode, definition.maxMode),
      recentExecutions: [],
    });
  }

  private clampMode(requested: PermissionMode, ceiling: PermissionMode): PermissionMode {
    const order: PermissionMode[] = ['observe', 'sandbox', 'approval', 'autonomous'];
    return order.indexOf(requested) > order.indexOf(ceiling) ? ceiling : requested;
  }

  /** Changes one capability's permission. There is deliberately no bulk setter. */
  setMode(capabilityId: string, mode: PermissionMode): boolean {
    const entry = this.capabilities.get(capabilityId);
    if (!entry) return false;
    entry.mode = this.clampMode(mode, entry.definition.maxMode);
    return true;
  }

  list(): Array<{ definition: CapabilityDefinition; mode: PermissionMode }> {
    return [...this.capabilities.values()].map((c) => ({
      definition: c.definition,
      mode: c.mode,
    }));
  }

  nextRequestId(): string {
    return `cap-${++this.sequence}`;
  }

  /**
   * Evaluates a request without executing it. Pure, so it is directly testable
   * and so the UI can preview what would happen.
   */
  evaluate(request: CapabilityRequest, now: number): CapabilityResult {
    const entry = this.capabilities.get(request.capabilityId);

    if (!entry) {
      return {
        requestId: request.id,
        status: 'denied',
        reason: `Unknown capability "${request.capabilityId}". Only explicitly registered capabilities can be requested.`,
      };
    }

    if (containsSecretLikeField(request.arguments)) {
      return {
        requestId: request.id,
        status: 'denied',
        reason:
          'Request arguments contain a credential-shaped field. Secrets never cross this boundary.',
      };
    }

    if (entry.mode === 'observe') {
      return {
        requestId: request.id,
        status: 'denied',
        reason: `Capability "${entry.definition.id}" is in OBSERVE mode: external actions are disabled.`,
      };
    }

    const windowStart = now - 60;
    const recent = entry.recentExecutions.filter((t) => t >= windowStart);
    if (recent.length >= entry.definition.rateLimitPerMinute) {
      return {
        requestId: request.id,
        status: 'rate-limited',
        reason: `Rate limit reached (${entry.definition.rateLimitPerMinute}/min).`,
      };
    }

    if (entry.mode === 'approval' || entry.definition.requiresApproval) {
      return {
        requestId: request.id,
        status: 'pending-approval',
        reason: 'Waiting for human approval.',
      };
    }

    return {
      requestId: request.id,
      status: 'approved',
      reason: 'Allowlisted and within limits.',
    };
  }

  /**
   * Requests a capability. Always logs, whatever the outcome.
   * Execution only happens for an `approved` verdict with a registered executor.
   */
  async request(
    init: Omit<CapabilityRequest, 'id' | 'requestedAt'>,
    now: number,
  ): Promise<CapabilityResult> {
    const request: CapabilityRequest = {
      ...init,
      id: this.nextRequestId(),
      requestedAt: now,
    };

    this.events.emit({
      type: 'external_action_requested',
      timestamp: now,
      summary: `${request.capabilityId}.${request.action} requested: ${request.reason}`,
      payload: { request },
    });

    const verdict = this.evaluate(request, now);

    if (verdict.status !== 'approved') {
      this.events.emit({
        type: 'external_action_denied',
        timestamp: now,
        summary: `${request.capabilityId}.${request.action} ${verdict.status}: ${verdict.reason}`,
        payload: { verdict },
      });
      return verdict;
    }

    const entry = this.capabilities.get(request.capabilityId)!;
    this.events.emit({
      type: 'external_action_approved',
      timestamp: now,
      summary: `${request.capabilityId}.${request.action} approved`,
      payload: { verdict },
    });

    if (!entry.executor) {
      return {
        requestId: request.id,
        status: 'failed',
        reason: 'No executor is bound to this capability in this build.',
      };
    }

    try {
      const result = await entry.executor.execute(request);
      entry.recentExecutions.push(now);
      this.events.emit({
        type: 'external_action_executed',
        timestamp: now,
        summary: `${request.capabilityId}.${request.action} executed`,
        payload: { requestId: request.id },
      });
      return { requestId: request.id, status: 'executed', reason: 'Completed.', result };
    } catch (e) {
      return {
        requestId: request.id,
        status: 'failed',
        reason: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

/**
 * The only capability this build registers.
 *
 * It performs no I/O whatsoever: it exists so the gateway, the permission
 * model, the audit trail and the tests have something real to operate on, while
 * the application ships with genuinely zero external reach.
 */
export const SANDBOX_ECHO_CAPABILITY: CapabilityDefinition = {
  id: 'sandbox.echo',
  name: 'Sandbox echo',
  description:
    'Returns its own arguments. No network, filesystem or system access. Exists to exercise the gateway.',
  risk: 'none',
  requiresApproval: false,
  maxMode: 'sandbox',
  rateLimitPerMinute: 30,
};

export const SANDBOX_ECHO_EXECUTOR: CapabilityExecutor = {
  async execute(request) {
    return { echoed: request.arguments };
  },
};

/**
 * Capabilities that are DESIGNED FOR but deliberately NOT registered.
 * Listed so the UI can show what the architecture anticipates while being
 * unambiguous that none of it is reachable today.
 */
export const PLANNED_CAPABILITIES: readonly CapabilityDefinition[] = [
  {
    id: 'web.search',
    name: 'Search the web',
    description:
      'Issue a search query through a server-side proxy and read summarised results.',
    risk: 'medium',
    requiresApproval: true,
    maxMode: 'approval',
    rateLimitPerMinute: 4,
  },
  {
    id: 'feed.post',
    name: 'Post to the public activity feed',
    description: 'Append a line to the organism public activity feed.',
    risk: 'medium',
    requiresApproval: true,
    maxMode: 'approval',
    rateLimitPerMinute: 2,
  },
  {
    id: 'experiment.run',
    name: 'Run a stimulus experiment',
    description: 'Start a predefined experiment in its own virtual environment.',
    risk: 'low',
    requiresApproval: false,
    maxMode: 'sandbox',
    rateLimitPerMinute: 6,
  },
];
