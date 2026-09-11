import { CELL_TYPE_CODE, NEURON_FLAG, type CellPolarity, type NeuronIndex } from './types';

/**
 * Population filtering.
 *
 * Runs as a single pass over TypedArrays producing a Uint8 mask that is handed
 * straight to the GPU state lane. Nothing is rebuilt, re-sorted, or re-allocated
 * per change, and no JavaScript object is created per neuron.
 *
 * This stays on the main thread deliberately. A full pass over 200,000 neurons
 * is a few hundred microseconds - well inside one frame - so moving it to a
 * worker would add message latency and a buffer copy for no benefit. The
 * genuinely expensive work (population generation, graph traversal) is what
 * runs in workers. See docs/ARCHITECTURE.md.
 */

export interface FilterState {
  /** Cell polarities to show. An empty set shows nothing. */
  readonly cellTypes: ReadonlySet<CellPolarity>;
  /** Region indices to show, or null for all regions. */
  readonly regions: ReadonlySet<number> | null;
  readonly onlyAnnotated: boolean;
  readonly onlyProofread: boolean;
  readonly onlyWithSkeleton: boolean;
  /**
   * When set, only these neuron indices are shown, intersected with the other
   * predicates. Used by "isolate selection" and local-circuit mode.
   */
  readonly restrictToIndices: ReadonlySet<number> | null;
}

export const ALL_CELL_TYPES: readonly CellPolarity[] = [
  'excitatory',
  'inhibitory',
  'modulatory',
  'unknown',
  'non-neuronal',
];

export function defaultFilterState(): FilterState {
  return {
    cellTypes: new Set(ALL_CELL_TYPES),
    regions: null,
    onlyAnnotated: false,
    onlyProofread: false,
    onlyWithSkeleton: false,
    restrictToIndices: null,
  };
}

export interface FilterResult {
  readonly mask: Uint8Array;
  readonly visibleCount: number;
  readonly elapsedMs: number;
}

/**
 * @param out Optional reusable output buffer, to avoid per-keystroke allocation
 *            of a 200 kB array.
 */
export function computeVisibilityMask(
  index: NeuronIndex,
  filter: FilterState,
  out?: Uint8Array,
): FilterResult {
  const t0 = performance.now();
  const { count } = index;
  const mask = out && out.length >= count ? out : new Uint8Array(count);

  // Cell-type membership is resolved once into a small lookup, so the inner
  // loop does an array index rather than a Set lookup per neuron.
  const typeAllowed = new Uint8Array(8);
  for (const t of filter.cellTypes) typeAllowed[CELL_TYPE_CODE[t]] = 1;

  const requiredFlags =
    (filter.onlyAnnotated ? NEURON_FLAG.ANNOTATED : 0) |
    (filter.onlyProofread ? NEURON_FLAG.PROOFREAD : 0) |
    (filter.onlyWithSkeleton ? NEURON_FLAG.HAS_SKELETON : 0);

  const regions = filter.regions;
  const restrict = filter.restrictToIndices;

  let visible = 0;
  for (let i = 0; i < count; i++) {
    let pass = typeAllowed[index.cellTypes[i]] === 1;
    if (pass && requiredFlags !== 0) {
      pass = (index.flags[i] & requiredFlags) === requiredFlags;
    }
    if (pass && regions) {
      pass = regions.has(index.regionIds[i]);
    }
    if (pass && restrict) {
      pass = restrict.has(i);
    }
    mask[i] = pass ? 1 : 0;
    if (pass) visible++;
  }

  return { mask, visibleCount: visible, elapsedMs: performance.now() - t0 };
}

/** Counts neurons per polarity. Used for the filter panel readout. */
export function countByCellType(index: NeuronIndex): Record<CellPolarity, number> {
  const counts: Record<CellPolarity, number> = {
    excitatory: 0,
    inhibitory: 0,
    modulatory: 0,
    'non-neuronal': 0,
    unknown: 0,
  };
  const byCode: CellPolarity[] = [
    'unknown',
    'excitatory',
    'inhibitory',
    'modulatory',
    'non-neuronal',
  ];
  for (let i = 0; i < index.count; i++) {
    const key = byCode[index.cellTypes[i]] ?? 'unknown';
    counts[key]++;
  }
  return counts;
}

export function countByRegion(index: NeuronIndex): Map<number, number> {
  const counts = new Map<number, number>();
  for (let i = 0; i < index.count; i++) {
    const r = index.regionIds[i];
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  return counts;
}

/**
 * Builds a lore ID -> array index lookup.
 *
 * A Map of 180k entries costs roughly 10 MB, which is acceptable once, and
 * makes identifier search and URL restoration O(1). Built lazily on first use.
 */
export function buildLoreIdLookup(index: NeuronIndex): Map<number, number> {
  const lookup = new Map<number, number>();
  for (let i = 0; i < index.count; i++) lookup.set(index.loreIds[i], i);
  return lookup;
}
