import type { EvidenceProvenance } from '@/core/provenance';
import type { Vec3f } from '@/renderer/math';

/**
 * Memory — INTERFACES ONLY.
 *
 * Nothing in this build writes or reads memories. These types exist so that
 * persistence and learning have a defined seam, and so the eventual
 * implementation is not forced to retrofit provenance and salience onto an
 * ad-hoc blob.
 *
 * Deliberately not implemented yet: a vector database is a large commitment and
 * there is nothing to retrieve until the organism has experiences worth
 * recalling.
 */

export type MemoryKind = 'episodic' | 'spatial' | 'associative' | 'preference';

export interface AgentMemory {
  readonly id: string;
  readonly createdAt: number;
  readonly kind: MemoryKind;
  /** 0..1 importance, used for retention and retrieval ranking. */
  readonly salience: number;
  readonly source: EvidenceProvenance;
  readonly data: unknown;
}

/** Something that happened, with enough context to be replayed. */
export interface EpisodicMemory extends AgentMemory {
  readonly kind: 'episodic';
  readonly data: {
    readonly summary: string;
    readonly simulationTime: number;
    readonly eventIds: readonly string[];
  };
}

/** Where something is. The substrate for any future navigation behaviour. */
export interface SpatialMemory extends AgentMemory {
  readonly kind: 'spatial';
  readonly data: {
    readonly label: string;
    readonly position: Vec3f;
    readonly confidence: number;
  };
}

/** Stimulus -> consequence. The substrate for any future learning. */
export interface AssociativeMemory extends AgentMemory {
  readonly kind: 'associative';
  readonly data: {
    readonly stimulus: string;
    readonly consequence: string;
    /** Signed association strength; negative means aversive. */
    readonly strength: number;
    readonly observations: number;
  };
}

export interface MemoryQuery {
  readonly kind?: MemoryKind;
  readonly minSalience?: number;
  readonly limit?: number;
  readonly nearPosition?: Vec3f;
  readonly radius?: number;
}

/**
 * Storage contract. An in-memory implementation is enough to begin with; the
 * interface is what allows a persistent store to be substituted later without
 * touching the policy.
 */
export interface MemoryStore {
  write(memory: AgentMemory): void;
  query(query: MemoryQuery): readonly AgentMemory[];
  /** Reduces salience over time so unimportant memories fall out. */
  decay(dt: number): void;
  size(): number;
}

/**
 * Persistent identity across sessions.
 *
 * Architected for, not populated. Counters must only ever reflect simulation
 * that actually ran; showing an invented age or action count would be exactly
 * the kind of fabrication this project refuses.
 */
export interface OrganismIdentity {
  readonly id: string;
  readonly label: string;
  /** Wall-clock milliseconds this organism has existed across all sessions. */
  readonly ageMs: number;
  /** Simulation seconds actually stepped. */
  readonly simulatedSeconds: number;
  readonly actionsTaken: number;
  readonly distanceTravelledMm: number;
  readonly sessions: number;
}

export function emptyIdentity(id: string, label: string): OrganismIdentity {
  return {
    id,
    label,
    ageMs: 0,
    simulatedSeconds: 0,
    actionsTaken: 0,
    distanceTravelledMm: 0,
    sessions: 0,
  };
}
