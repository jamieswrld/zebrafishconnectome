import { describe, expect, it } from 'vitest';
import { decodeNeuronIndex, encodeNeuronIndex } from '@/core/binary';
import {
  buildLoreIdLookup,
  computeVisibilityMask,
  countByCellType,
  defaultFilterState,
} from '@/core/filters';
import { CELL_TYPE_CODE, NEURON_FLAG, type NeuronIndex } from '@/core/types';

/**
 * Filtering drives what the user believes they are looking at, so an off-by-one
 * in the mask is a scientific error, not a cosmetic one.
 */

function buildIndex(): NeuronIndex {
  const count = 6;
  const positionsVoxel = new Int32Array(count * 3);
  const loreIds = new Uint32Array(count);
  const cellTypes = new Uint8Array(count);
  const regionIds = new Uint16Array(count);
  const flags = new Uint8Array(count);

  const types = [
    CELL_TYPE_CODE.excitatory,
    CELL_TYPE_CODE.excitatory,
    CELL_TYPE_CODE.inhibitory,
    CELL_TYPE_CODE.unknown,
    CELL_TYPE_CODE.unknown,
    CELL_TYPE_CODE.modulatory,
  ];

  for (let i = 0; i < count; i++) {
    positionsVoxel[i * 3] = i * 100;
    positionsVoxel[i * 3 + 1] = i * 50;
    positionsVoxel[i * 3 + 2] = i * 10;
    loreIds[i] = 1000 + i;
    cellTypes[i] = types[i];
    regionIds[i] = i < 3 ? 0 : 1;
    flags[i] =
      (types[i] !== CELL_TYPE_CODE.unknown ? NEURON_FLAG.ANNOTATED : 0) |
      (i % 2 === 0 ? NEURON_FLAG.HAS_SKELETON : 0) |
      (i === 5 ? NEURON_FLAG.PROOFREAD : 0);
  }

  return decodeNeuronIndex(
    encodeNeuronIndex({
      datasetId: 'test',
      origin: 'development-sample',
      count,
      version: { materializationVersion: null, label: 'test' },
      voxelSpace: { voxelSizeNm: [16, 16, 30], axisOrder: 'xyz' },
      positionProvenance: 'simulated',
      regions: [],
      positionsVoxel,
      loreIds,
      cellTypes,
      regionIds,
      flags,
    }),
  );
}

describe('visibility mask', () => {
  const index = buildIndex();

  it('shows everything by default', () => {
    const result = computeVisibilityMask(index, defaultFilterState());
    expect(result.visibleCount).toBe(6);
    expect(Array.from(result.mask)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('filters by cell type', () => {
    const result = computeVisibilityMask(index, {
      ...defaultFilterState(),
      cellTypes: new Set(['excitatory']),
    });
    expect(result.visibleCount).toBe(2);
    expect(Array.from(result.mask)).toEqual([1, 1, 0, 0, 0, 0]);
  });

  it('hides everything when no cell type is selected', () => {
    const result = computeVisibilityMask(index, {
      ...defaultFilterState(),
      cellTypes: new Set(),
    });
    expect(result.visibleCount).toBe(0);
  });

  it('treats unknown as its own category, not as a wildcard', () => {
    // "unknown" means unannotated. It must not silently match annotated cells.
    const result = computeVisibilityMask(index, {
      ...defaultFilterState(),
      cellTypes: new Set(['unknown']),
    });
    expect(result.visibleCount).toBe(2);
    expect(Array.from(result.mask)).toEqual([0, 0, 0, 1, 1, 0]);
  });

  it('applies flag predicates conjunctively', () => {
    const result = computeVisibilityMask(index, {
      ...defaultFilterState(),
      onlyAnnotated: true,
      onlyWithSkeleton: true,
    });
    // Annotated: 0,1,2,5. Skeleton: 0,2,4. Both: 0,2.
    expect(Array.from(result.mask)).toEqual([1, 0, 1, 0, 0, 0]);
  });

  it('filters by region', () => {
    const result = computeVisibilityMask(index, {
      ...defaultFilterState(),
      regions: new Set([1]),
    });
    expect(Array.from(result.mask)).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('intersects an index restriction with the other predicates', () => {
    const result = computeVisibilityMask(index, {
      ...defaultFilterState(),
      cellTypes: new Set(['excitatory']),
      restrictToIndices: new Set([1, 2, 3]),
    });
    // Only index 1 is both excitatory and in the restriction.
    expect(Array.from(result.mask)).toEqual([0, 1, 0, 0, 0, 0]);
    expect(result.visibleCount).toBe(1);
  });

  it('reuses a caller-supplied buffer without leaving stale bits', () => {
    const scratch = new Uint8Array(6).fill(1);
    const result = computeVisibilityMask(
      index,
      { ...defaultFilterState(), cellTypes: new Set(['inhibitory']) },
      scratch,
    );
    expect(result.mask).toBe(scratch);
    expect(Array.from(scratch)).toEqual([0, 0, 1, 0, 0, 0]);
  });

  it('reports a measurable elapsed time', () => {
    const result = computeVisibilityMask(index, defaultFilterState());
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe('population summaries', () => {
  const index = buildIndex();

  it('counts by cell type', () => {
    const counts = countByCellType(index);
    expect(counts.excitatory).toBe(2);
    expect(counts.inhibitory).toBe(1);
    expect(counts.unknown).toBe(2);
    expect(counts.modulatory).toBe(1);
    expect(counts['non-neuronal']).toBe(0);
  });

  it('builds an O(1) lore ID lookup', () => {
    const lookup = buildLoreIdLookup(index);
    expect(lookup.get(1000)).toBe(0);
    expect(lookup.get(1005)).toBe(5);
    expect(lookup.get(9999)).toBeUndefined();
    expect(lookup.size).toBe(6);
  });
});
