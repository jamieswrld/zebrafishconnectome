import { describe, expect, it } from 'vitest';
import {
  SYNTHETIC_REGIONS,
  SYNTHETIC_VOXEL_SPACE,
  generateSyntheticPopulation,
  syntheticPartners,
} from '@/datasets/synthetic/generator';
import { decodeNeuronIndex, encodeNeuronIndex } from '@/core/binary';
import { CELL_TYPE_CODE } from '@/core/types';
import { voxelToMicrometres } from '@/core/coords';

/**
 * The synthetic generator underpins every benchmark number we report. If it is
 * not deterministic, those numbers are not comparable between runs and the
 * whole benchmark is decorative.
 */

describe('synthetic population', () => {
  it('is deterministic for a given seed and count', () => {
    const a = generateSyntheticPopulation({ count: 5000, seed: 42 });
    const b = generateSyntheticPopulation({ count: 5000, seed: 42 });
    expect(Array.from(a.positionsVoxel)).toEqual(Array.from(b.positionsVoxel));
    expect(Array.from(a.cellTypes)).toEqual(Array.from(b.cellTypes));
    expect(Array.from(a.regionIds)).toEqual(Array.from(b.regionIds));
  });

  it('differs between seeds', () => {
    const a = generateSyntheticPopulation({ count: 2000, seed: 1 });
    const b = generateSyntheticPopulation({ count: 2000, seed: 2 });
    expect(Array.from(a.positionsVoxel)).not.toEqual(Array.from(b.positionsVoxel));
  });

  it('produces the requested count and consistent lane lengths', () => {
    const p = generateSyntheticPopulation({ count: 1234, seed: 7 });
    expect(p.count).toBe(1234);
    expect(p.positionsVoxel.length).toBe(1234 * 3);
    expect(p.loreIds.length).toBe(1234);
    expect(p.cellTypes.length).toBe(1234);
    expect(p.regionIds.length).toBe(1234);
    expect(p.flags.length).toBe(1234);
  });

  it('assigns unique sequential lore IDs', () => {
    const p = generateSyntheticPopulation({ count: 500, seed: 3, firstLoreId: 90000 });
    expect(p.loreIds[0]).toBe(90000);
    expect(p.loreIds[499]).toBe(90499);
    expect(new Set(p.loreIds).size).toBe(500);
  });

  it('produces only valid cell-type codes', () => {
    const p = generateSyntheticPopulation({ count: 3000, seed: 11 });
    const valid = new Set<number>(Object.values(CELL_TYPE_CODE));
    for (const code of p.cellTypes) expect(valid.has(code)).toBe(true);
  });

  it('assigns every neuron to a known region', () => {
    const p = generateSyntheticPopulation({ count: 2000, seed: 5 });
    for (const region of p.regionIds) {
      expect(region).toBeLessThan(SYNTHETIC_REGIONS.length);
    }
  });

  it('spans a physical extent plausible for a larval zebrafish brain', () => {
    const p = generateSyntheticPopulation({ count: 20000, seed: 9 });
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.count; i++) {
      const um = voxelToMicrometres(
        [p.positionsVoxel[i * 3], p.positionsVoxel[i * 3 + 1], p.positionsVoxel[i * 3 + 2]],
        SYNTHETIC_VOXEL_SPACE,
      );
      min = min.map((v, j) => Math.min(v, um[j]));
      max = max.map((v, j) => Math.max(v, um[j]));
    }
    const rostrocaudal = max[0] - min[0];
    // Hundreds of micrometres, not millimetres or nanometres.
    expect(rostrocaudal).toBeGreaterThan(300);
    expect(rostrocaudal).toBeLessThan(1500);
  });

  it('produces only non-negative voxel coordinates, as a real EM volume does', () => {
    const p = generateSyntheticPopulation({ count: 10000, seed: 13 });
    for (const v of p.positionsVoxel) expect(v).toBeGreaterThanOrEqual(0);
  });

  it('survives a round trip through the binary container', () => {
    const p = generateSyntheticPopulation({ count: 800, seed: 21 });
    const index = decodeNeuronIndex(
      encodeNeuronIndex({
        datasetId: 'dev-sample',
        origin: 'development-sample',
        count: p.count,
        version: { materializationVersion: null, label: 'synthetic' },
        voxelSpace: p.voxelSpace,
        positionProvenance: 'simulated',
        regions: p.regions,
        positionsVoxel: p.positionsVoxel,
        loreIds: p.loreIds,
        cellTypes: p.cellTypes,
        regionIds: p.regionIds,
        flags: p.flags,
      }),
    );
    expect(index.count).toBe(800);
    // Generated data must never be labelled as measured.
    expect(index.positionProvenance).toBe('simulated');
    expect(index.origin).toBe('development-sample');
    expect(Array.from(index.positionsVoxel)).toEqual(Array.from(p.positionsVoxel));
  });

  it('handles a zero-size request', () => {
    const p = generateSyntheticPopulation({ count: 0, seed: 1 });
    expect(p.count).toBe(0);
    expect(p.positionsVoxel.length).toBe(0);
  });
});

describe('synthetic connectivity', () => {
  it('is deterministic per neuron and direction', () => {
    const a = syntheticPartners(500, 10000, 'outgoing');
    const b = syntheticPartners(500, 10000, 'outgoing');
    expect(a).toEqual(b);
  });

  it('differs between directions', () => {
    const out = syntheticPartners(500, 10000, 'outgoing');
    const inc = syntheticPartners(500, 10000, 'incoming');
    expect(out).not.toEqual(inc);
  });

  it('never returns the neuron itself or duplicates', () => {
    const partners = syntheticPartners(123, 5000, 'outgoing');
    const indices = partners.map((p) => p.index);
    expect(indices).not.toContain(123);
    expect(new Set(indices).size).toBe(indices.length);
  });

  it('keeps partner indices inside the population', () => {
    for (const seedIndex of [0, 1, 4999]) {
      for (const p of syntheticPartners(seedIndex, 5000, 'incoming')) {
        expect(p.index).toBeGreaterThanOrEqual(0);
        expect(p.index).toBeLessThan(5000);
      }
    }
  });

  it('returns partners ranked by synapse count', () => {
    const partners = syntheticPartners(77, 8000, 'outgoing');
    const counts = partners.map((p) => p.synapseCount);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    for (const c of counts) expect(c).toBeGreaterThanOrEqual(1);
  });
});
