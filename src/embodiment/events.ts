import type { EvidenceProvenance } from '@/core/provenance';
import type { AgentEvent, AgentEventType } from './types';

/**
 * Append-only event log: the organism's black-box recorder.
 *
 * Every sensory input, state change, proposal, decision and motor command can
 * be written here, which is what makes the eventual autonomous behaviour
 * auditable rather than mysterious. Transparency is a product feature, not a
 * debugging aid.
 *
 * Storage is a fixed-capacity ring buffer. A simulation that runs for hours
 * must not accumulate unbounded memory, and the UI only ever shows a recent
 * window; durable history is a persistence concern (see AgentMemory).
 */

const DEFAULT_CAPACITY = 2000;

export type EventListener = (event: AgentEvent) => void;

export class AgentEventBus {
  private buffer: AgentEvent[] = [];
  private listeners = new Set<EventListener>();
  private sequence = 0;
  private droppedCount = 0;

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  /**
   * Records an event. Returns it so callers can correlate, e.g. a capability
   * request with the result that eventually references its id.
   */
  emit(init: {
    type: AgentEventType;
    summary: string;
    timestamp: number;
    provenance?: EvidenceProvenance;
    payload?: unknown;
  }): AgentEvent {
    const event: AgentEvent = {
      id: `e${++this.sequence}`,
      timestamp: init.timestamp,
      wallClock: Date.now(),
      type: init.type,
      provenance: init.provenance ?? 'simulated',
      summary: init.summary,
      payload: init.payload ?? null,
    };

    this.buffer.push(event);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
      this.droppedCount++;
    }

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A misbehaving listener must never break the simulation loop.
      }
    }
    return event;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Most recent events, newest last. */
  recent(limit = 50): readonly AgentEvent[] {
    return this.buffer.slice(Math.max(this.buffer.length - limit, 0));
  }

  byType(type: AgentEventType, limit = 50): readonly AgentEvent[] {
    const out: AgentEvent[] = [];
    for (let i = this.buffer.length - 1; i >= 0 && out.length < limit; i--) {
      if (this.buffer[i].type === type) out.push(this.buffer[i]);
    }
    return out.reverse();
  }

  size(): number {
    return this.buffer.length;
  }

  /** How many events have been evicted by the ring buffer. */
  dropped(): number {
    return this.droppedCount;
  }

  total(): number {
    return this.sequence;
  }

  clear(): void {
    this.buffer = [];
    this.sequence = 0;
    this.droppedCount = 0;
  }

  /**
   * Serialises the log. Stable field order so a recorded run can be diffed
   * between builds.
   */
  serialize(): string {
    return JSON.stringify(
      this.buffer.map((e) => ({
        id: e.id,
        timestamp: e.timestamp,
        wallClock: e.wallClock,
        type: e.type,
        provenance: e.provenance,
        summary: e.summary,
        payload: e.payload,
      })),
    );
  }
}
