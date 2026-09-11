import { CELL_TYPE_CODE, NEURON_FLAG, type BrainRegion } from '@/core/types';
import type { VoxelSpace } from '@/core/coords';

/**
 * Deterministic synthetic population generator.
 *
 * PURPOSE: to stress the renderer and to give the application a schema-complete
 * dataset when no real export is present. THIS IS NOT BIOLOGY. Nothing produced
 * here is a measurement, and every surface that shows it is badged
 * DEVELOPMENT SAMPLE or SYNTHETIC BENCHMARK.
 *
 * It is shaped like a larval zebrafish brain only so that the rendering,
 * culling and LOD behaviour is exercised under a realistic spatial
 * distribution - a uniform cube would hide exactly the density problems we
 * need to measure.
 *
 * Determinism matters: the same seed and count always produce byte-identical
 * output, so a benchmark number is reproducible and a regression is real.
 */

/** mulberry32: small, fast, and reproducible across engines. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, giving cluster interiors a plausible density falloff. */
function gaussian(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Synthetic voxel space. Deliberately mirrors the Fish1 grid (16 x 16 x 30 nm)
 * so the binary format, the coordinate transforms and the pipeline are all
 * exercised on the same numbers the real export will use.
 */
export const SYNTHETIC_VOXEL_SPACE: VoxelSpace = {
  voxelSizeNm: [16, 16, 30],
  axisOrder: 'xyz',
  anatomicalAxes: {
    // Defined by this generator, not inferred from data.
    xPositive: 'posterior',
    yPositive: 'right',
    zPositive: 'dorsal',
    source: 'dataset-documentation',
  },
};

interface SyntheticStructure {
  readonly id: string;
  readonly name: string;
  readonly acronym: string;
  /** Centre in micrometres: [rostrocaudal, mediolateral, dorsoventral]. */
  readonly center: readonly [number, number, number];
  readonly radii: readonly [number, number, number];
  /** Share of the total population. Normalised across all structures. */
  readonly share: number;
  /** Mirrored across the midline into left and right copies. */
  readonly bilateral: boolean;
  /** Mediolateral offset of each copy from the midline, micrometres. */
  readonly lateralOffset: number;
  /** Probability of excitatory / inhibitory / unannotated identity. */
  readonly polarity: readonly [number, number, number];
}

/**
 * Approximate larval zebrafish brain layout, in micrometres, roughly 700 um
 * rostrocaudal. Proportions are eyeballed from published larval atlases purely
 * to get a realistic spatial distribution; they are not registered to any
 * atlas and carry no anatomical authority.
 */
const STRUCTURES: readonly SyntheticStructure[] = [
  {
    id: 'tel',
    name: 'Telencephalon (synthetic)',
    acronym: 'TEL',
    center: [80, 0, 30],
    radii: [45, 26, 26],
    share: 0.1,
    bilateral: true,
    lateralOffset: 28,
    polarity: [0.45, 0.3, 0.25],
  },
  {
    id: 'hab',
    name: 'Habenula (synthetic)',
    acronym: 'HB',
    center: [150, 0, 55],
    radii: [22, 14, 14],
    share: 0.035,
    bilateral: true,
    lateralOffset: 18,
    polarity: [0.55, 0.2, 0.25],
  },
  {
    id: 'pt',
    name: 'Pretectum (synthetic)',
    acronym: 'PT',
    center: [195, 0, 20],
    radii: [26, 20, 20],
    share: 0.05,
    bilateral: true,
    lateralOffset: 34,
    polarity: [0.4, 0.35, 0.25],
  },
  {
    id: 'th',
    name: 'Thalamus (synthetic)',
    acronym: 'TH',
    center: [190, 0, -15],
    radii: [30, 18, 18],
    share: 0.05,
    bilateral: true,
    lateralOffset: 20,
    polarity: [0.4, 0.35, 0.25],
  },
  {
    id: 'tec',
    name: 'Optic tectum (synthetic)',
    acronym: 'TeO',
    center: [255, 0, 40],
    radii: [62, 34, 38],
    share: 0.245,
    bilateral: true,
    lateralOffset: 52,
    polarity: [0.45, 0.35, 0.2],
  },
  {
    id: 'teg',
    name: 'Tegmentum (synthetic)',
    acronym: 'TEG',
    center: [270, 0, -30],
    radii: [42, 26, 22],
    share: 0.07,
    bilateral: true,
    lateralOffset: 22,
    polarity: [0.45, 0.3, 0.25],
  },
  {
    id: 'cb',
    name: 'Cerebellum (synthetic)',
    acronym: 'CB',
    center: [345, 0, 40],
    radii: [30, 40, 22],
    share: 0.08,
    bilateral: false,
    lateralOffset: 0,
    polarity: [0.55, 0.25, 0.2],
  },
  {
    id: 'hind',
    name: 'Hindbrain (synthetic)',
    acronym: 'HIND',
    center: [440, 0, 0],
    radii: [105, 42, 32],
    share: 0.3,
    bilateral: false,
    lateralOffset: 0,
    polarity: [0.35, 0.4, 0.25],
  },
  {
    id: 'sc',
    name: 'Anterior spinal cord (synthetic)',
    acronym: 'SC',
    center: [610, 0, -5],
    radii: [80, 16, 14],
    share: 0.07,
    bilateral: false,
    lateralOffset: 0,
    polarity: [0.35, 0.4, 0.25],
  },
];

export const SYNTHETIC_REGIONS: readonly BrainRegion[] = STRUCTURES.map((s) => ({
  id: s.id,
  name: s.name,
  acronym: s.acronym,
  assignmentProvenance: 'derived',
  assignmentMethod: 'Synthetic generator ground truth. Not an anatomical claim.',
}));

export interface SyntheticPopulation {
  readonly count: number;
  readonly positionsVoxel: Int32Array;
  readonly loreIds: Uint32Array;
  readonly cellTypes: Uint8Array;
  readonly regionIds: Uint16Array;
  readonly flags: Uint8Array;
  readonly regions: readonly BrainRegion[];
  readonly voxelSpace: VoxelSpace;
  readonly seed: number;
}

export interface GenerateOptions {
  readonly count: number;
  readonly seed?: number;
  /** First lore ID; subsequent neurons increment. */
  readonly firstLoreId?: number;
}

export function generateSyntheticPopulation(options: GenerateOptions): SyntheticPopulation {
  const count = Math.max(0, Math.floor(options.count));
  const seed = options.seed ?? 20250610;
  const firstLoreId = options.firstLoreId ?? 100000;
  const rand = mulberry32(seed);

  const positionsVoxel = new Int32Array(count * 3);
  const loreIds = new Uint32Array(count);
  const cellTypes = new Uint8Array(count);
  const regionIds = new Uint16Array(count);
  const flags = new Uint8Array(count);

  // Expand bilateral structures into concrete placement targets.
  interface Target {
    structure: SyntheticStructure;
    regionIndex: number;
    lateralSign: number;
    weight: number;
  }
  const targets: Target[] = [];
  let totalWeight = 0;
  STRUCTURES.forEach((s, regionIndex) => {
    const copies = s.bilateral ? [-1, 1] : [0];
    for (const sign of copies) {
      const weight = s.share / copies.length;
      targets.push({ structure: s, regionIndex, lateralSign: sign, weight });
      totalWeight += weight;
    }
  });

  // Cumulative distribution for O(log n) structure selection per neuron.
  const cumulative = new Float64Array(targets.length);
  let acc = 0;
  for (let i = 0; i < targets.length; i++) {
    acc += targets[i].weight / totalWeight;
    cumulative[i] = acc;
  }
  cumulative[targets.length - 1] = 1;

  const [vx, vy, vz] = SYNTHETIC_VOXEL_SPACE.voxelSizeNm;
  // Offset so all voxel coordinates are positive, as in a real EM volume.
  const originUm: [number, number, number] = [40, 240, 160];

  for (let i = 0; i < count; i++) {
    const r = rand();
    let lo = 0;
    let hi = targets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (r <= cumulative[mid]) hi = mid;
      else lo = mid + 1;
    }
    const target = targets[lo];
    const s = target.structure;

    // Gaussian core clipped to the structure envelope, so clusters have soft
    // edges rather than hard ellipsoid boundaries.
    const gx = gaussian(rand) * 0.36;
    const gy = gaussian(rand) * 0.36;
    const gz = gaussian(rand) * 0.36;

    const um: [number, number, number] = [
      s.center[0] + gx * s.radii[0] + originUm[0],
      s.center[1] + target.lateralSign * s.lateralOffset + gy * s.radii[1] + originUm[1],
      s.center[2] + gz * s.radii[2] + originUm[2],
    ];

    positionsVoxel[i * 3] = Math.round((um[0] * 1000) / vx);
    positionsVoxel[i * 3 + 1] = Math.round((um[1] * 1000) / vy);
    positionsVoxel[i * 3 + 2] = Math.round((um[2] * 1000) / vz);

    loreIds[i] = firstLoreId + i;
    regionIds[i] = target.regionIndex;

    const p = rand();
    const [pe, pi] = s.polarity;
    if (p < pe) cellTypes[i] = CELL_TYPE_CODE.excitatory;
    else if (p < pe + pi) cellTypes[i] = CELL_TYPE_CODE.inhibitory;
    else cellTypes[i] = CELL_TYPE_CODE.unknown;

    let f = 0;
    if (cellTypes[i] !== CELL_TYPE_CODE.unknown) f |= NEURON_FLAG.ANNOTATED;
    // A minority carry a skeleton, mirroring a partially proofread dataset.
    if (rand() < 0.12) f |= NEURON_FLAG.HAS_SKELETON;
    if (rand() < 0.03) f |= NEURON_FLAG.PROOFREAD;
    flags[i] = f;
  }

  return {
    count,
    positionsVoxel,
    loreIds,
    cellTypes,
    regionIds,
    flags,
    regions: SYNTHETIC_REGIONS,
    voxelSpace: SYNTHETIC_VOXEL_SPACE,
    seed,
  };
}

/**
 * Deterministic synthetic connectivity for a single neuron.
 *
 * Derived from a hash of the neuron index, so it is stable across reloads
 * without storing an edge list. Partner selection is spatially biased: nearby
 * indices are more likely, which produces locally clustered circuits because
 * the generator emits spatially coherent runs of indices.
 *
 * This exists so that circuit tracing, edge rendering and traversal limits can
 * be exercised end to end. It models nothing biological.
 */
export function syntheticPartners(
  neuronIndex: number,
  populationCount: number,
  direction: 'incoming' | 'outgoing',
  maxPartners = 24,
): Array<{ index: number; synapseCount: number }> {
  const salt = direction === 'incoming' ? 0x9e3779b9 : 0x85ebca6b;
  const rand = mulberry32((neuronIndex ^ salt) >>> 0);
  const n = 6 + Math.floor(rand() * (maxPartners - 6));
  const partners: Array<{ index: number; synapseCount: number }> = [];
  const seen = new Set<number>();

  for (let i = 0; i < n; i++) {
    // Mostly local, with a long-range tail.
    const local = rand() < 0.72;
    const spread = local ? populationCount * 0.01 : populationCount * 0.5;
    const offset = Math.round(gaussian(rand) * spread);
    let idx = neuronIndex + offset;
    idx = ((idx % populationCount) + populationCount) % populationCount;
    if (idx === neuronIndex || seen.has(idx)) continue;
    seen.add(idx);
    // Heavy-tailed synapse counts, as seen in real connectomes.
    const synapseCount = 1 + Math.floor(Math.pow(rand(), 2.4) * 60);
    partners.push({ index: idx, synapseCount });
  }
  partners.sort((a, b) => b.synapseCount - a.synapseCount);
  return partners;
}
