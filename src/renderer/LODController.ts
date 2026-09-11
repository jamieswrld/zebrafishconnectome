/**
 * Level-of-detail controller.
 *
 * LOD here is a *scale of inquiry*, not just a mesh-detail slider. Each level
 * declares which layers are allowed to draw, which keeps the promise that the
 * whole-brain view never attempts 30M synapses or 180k skeletons.
 *
 * Transitions are continuous - the camera keeps flying and the point cloud
 * keeps rendering. Changing scale must never feel like navigating to a
 * different page.
 */

export type LodLevel = 'whole-brain' | 'region' | 'local-circuit' | 'single-neuron';

export const LOD_ORDER: readonly LodLevel[] = [
  'whole-brain',
  'region',
  'local-circuit',
  'single-neuron',
];

export interface LodPolicy {
  readonly level: LodLevel;
  readonly label: string;
  /** Soma radius in world units at this scale. */
  readonly somaRadius: number;
  readonly minPointPx: number;
  readonly maxPointPx: number;
  /** Individual synapse positions may be drawn. */
  readonly allowSynapsePoints: boolean;
  /** Full morphology may be drawn. */
  readonly allowSkeletons: boolean;
  /** Aggregate pathway bundles rather than individual edges. */
  readonly prefersAggregateConnectivity: boolean;
  readonly description: string;
}

export const LOD_POLICIES: Record<LodLevel, LodPolicy> = {
  'whole-brain': {
    level: 'whole-brain',
    label: 'WHOLE BRAIN',
    somaRadius: 0.0032,
    minPointPx: 1.0,
    maxPointPx: 6,
    allowSynapsePoints: false,
    allowSkeletons: false,
    prefersAggregateConnectivity: true,
    description: 'All soma. Individual synapses and skeletons are not drawn at this scale.',
  },
  region: {
    level: 'region',
    label: 'REGION',
    somaRadius: 0.0042,
    minPointPx: 1.2,
    maxPointPx: 14,
    allowSynapsePoints: false,
    allowSkeletons: false,
    prefersAggregateConnectivity: true,
    description: 'Population scale. Selected connectivity is drawn; morphology is not.',
  },
  'local-circuit': {
    level: 'local-circuit',
    label: 'LOCAL CIRCUIT',
    somaRadius: 0.0055,
    minPointPx: 1.5,
    maxPointPx: 40,
    allowSynapsePoints: true,
    allowSkeletons: true,
    prefersAggregateConnectivity: false,
    description:
      'Selected cell and its partners. Skeletons and synapse sites may be requested.',
  },
  'single-neuron': {
    level: 'single-neuron',
    label: 'SINGLE NEURON',
    somaRadius: 0.007,
    minPointPx: 2,
    maxPointPx: 90,
    allowSynapsePoints: true,
    allowSkeletons: true,
    prefersAggregateConnectivity: false,
    description: 'One cell. Full morphology and synaptic sites.',
  },
};

/**
 * Distance thresholds as a fraction of the scene radius. Chosen so the
 * whole-brain level covers the default framing and the transition to local
 * scales happens only once a user has deliberately zoomed in.
 */
const THRESHOLDS: ReadonlyArray<{ maxRatio: number; level: LodLevel }> = [
  { maxRatio: 0.12, level: 'single-neuron' },
  { maxRatio: 0.35, level: 'local-circuit' },
  { maxRatio: 0.8, level: 'region' },
  { maxRatio: Infinity, level: 'whole-brain' },
];

export class LODController {
  private sceneRadius = 1;
  private currentLevel: LodLevel = 'whole-brain';
  /** When set, overrides distance-based selection (e.g. isolate mode). */
  private forcedLevel: LodLevel | null = null;

  setSceneRadius(radius: number): void {
    this.sceneRadius = Math.max(radius, 1e-6);
  }

  force(level: LodLevel | null): void {
    this.forcedLevel = level;
  }

  /**
   * @param cameraDistance Orbit distance in world units.
   * @returns true when the level changed this update.
   */
  update(cameraDistance: number): boolean {
    const next = this.forcedLevel ?? this.levelForDistance(cameraDistance);
    if (next === this.currentLevel) return false;
    this.currentLevel = next;
    return true;
  }

  private levelForDistance(distance: number): LodLevel {
    const ratio = distance / this.sceneRadius;
    for (const t of THRESHOLDS) {
      if (ratio <= t.maxRatio) return t.level;
    }
    return 'whole-brain';
  }

  level(): LodLevel {
    return this.currentLevel;
  }

  policy(): LodPolicy {
    return LOD_POLICIES[this.currentLevel];
  }

  /**
   * Soma radius interpolated across the level boundary so the transition is
   * smooth rather than a visible pop.
   */
  interpolatedSomaRadius(cameraDistance: number): number {
    const ratio = cameraDistance / this.sceneRadius;
    const policy = this.policy();
    if (this.forcedLevel) return policy.somaRadius;
    // Blend between the enclosing thresholds on a log scale, which matches how
    // the orbit distance changes under multiplicative zoom.
    const t = Math.min(Math.max((Math.log(ratio) + 2.5) / 3.5, 0), 1);
    const near = LOD_POLICIES['single-neuron'].somaRadius;
    const far = LOD_POLICIES['whole-brain'].somaRadius;
    return near + (far - near) * t;
  }
}
