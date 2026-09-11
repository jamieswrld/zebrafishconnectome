import { describe, expect, it } from 'vitest';
import {
  computeBounds,
  computeRenderTransform,
  micrometresToWorld,
  micrometresToVoxel,
  voxelToMicrometres,
  voxelToWorld,
  worldToMicrometres,
  worldToVoxel,
  type VoxelSpace,
} from '@/core/coords';

/**
 * Coordinate handling is where a viewer can quietly become scientifically
 * wrong. These tests pin the two properties that matter: the transform chain is
 * invertible, and the render transform is uniform so distances stay
 * proportional.
 */

const fish1Space: VoxelSpace = { voxelSizeNm: [16, 16, 30], axisOrder: 'xyz' };

describe('voxel <-> micrometre', () => {
  it('applies anisotropic voxel sizes per axis', () => {
    // The z axis is 30 nm while x and y are 16 nm; conflating them would
    // squash the brain along z.
    expect(voxelToMicrometres([1000, 1000, 1000], fish1Space)).toEqual([16, 16, 30]);
  });

  it('round-trips exactly', () => {
    const voxel: [number, number, number] = [75765, 38366, 6682];
    const um = voxelToMicrometres(voxel, fish1Space);
    const back = micrometresToVoxel(um, fish1Space);
    expect(back[0]).toBeCloseTo(voxel[0], 6);
    expect(back[1]).toBeCloseTo(voxel[1], 6);
    expect(back[2]).toBeCloseTo(voxel[2], 6);
  });

  it('places a real Fish1 example at a plausible physical scale', () => {
    // The coordinate from the official notebook example.
    const um = voxelToMicrometres([75765, 38366, 6682], fish1Space);
    expect(um[0]).toBeCloseTo(1212.24, 2);
    expect(um[1]).toBeCloseTo(613.856, 3);
    expect(um[2]).toBeCloseTo(200.46, 2);
  });
});

describe('render transform', () => {
  const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 4, 0, 0, 0, 2]);

  it('centres the population', () => {
    const t = computeRenderTransform(positions, 4, 2);
    expect(t.centerUm[0]).toBeCloseTo(5, 5);
    expect(t.centerUm[1]).toBeCloseTo(2, 5);
    expect(t.centerUm[2]).toBeCloseTo(1, 5);
  });

  it('scales the largest extent to the target', () => {
    const t = computeRenderTransform(positions, 4, 2);
    // Largest extent is 10 um along x, mapped to 2 world units.
    expect(t.scale).toBeCloseTo(0.2, 6);
  });

  it('is uniform, so it cannot distort morphology', () => {
    const t = computeRenderTransform(positions, 4, 2);
    const a = micrometresToWorld([0, 0, 0], t);
    const alongX = micrometresToWorld([1, 0, 0], t);
    const alongY = micrometresToWorld([0, 1, 0], t);
    const alongZ = micrometresToWorld([0, 0, 1], t);
    const dx = Math.abs(alongX[0] - a[0]);
    const dy = Math.abs(alongY[1] - a[1]);
    const dz = Math.abs(alongZ[2] - a[2]);
    expect(dy).toBeCloseTo(dx, 9);
    expect(dz).toBeCloseTo(dx, 9);
  });

  it('is invertible back to source voxel coordinates', () => {
    const t = computeRenderTransform(positions, 4, 2);
    const voxel: [number, number, number] = [75765, 38366, 6682];
    const world = voxelToWorld(voxel, fish1Space, t);
    const back = worldToVoxel(world, fish1Space, t);
    expect(back[0]).toBeCloseTo(voxel[0], 3);
    expect(back[1]).toBeCloseTo(voxel[1], 3);
    expect(back[2]).toBeCloseTo(voxel[2], 3);
  });

  it('round-trips micrometres through world space', () => {
    const t = computeRenderTransform(positions, 4, 2);
    const um: [number, number, number] = [123.5, -44.25, 8];
    const back = worldToMicrometres(micrometresToWorld(um, t), t);
    expect(back[0]).toBeCloseTo(um[0], 4);
    expect(back[1]).toBeCloseTo(um[1], 4);
    expect(back[2]).toBeCloseTo(um[2], 4);
  });

  it('degrades safely on an empty or degenerate population', () => {
    expect(computeRenderTransform(new Float32Array(0), 0).scale).toBe(1);
    // All points coincident: no extent to scale, so scale stays 1 rather than
    // becoming Infinity.
    const single = new Float32Array([5, 5, 5, 5, 5, 5]);
    expect(computeRenderTransform(single, 2).scale).toBe(1);
  });

  it('ignores non-finite positions instead of poisoning the bounds', () => {
    const dirty = new Float32Array([0, 0, 0, NaN, NaN, NaN, 10, 10, 10]);
    const t = computeRenderTransform(dirty, 3, 2);
    expect(Number.isFinite(t.scale)).toBe(true);
    expect(t.centerUm[0]).toBeCloseTo(5, 5);
  });
});

describe('computeBounds', () => {
  it('returns the axis-aligned extent', () => {
    const bounds = computeBounds(new Float32Array([1, 2, 3, -4, 8, 0]), 2);
    expect(bounds.min).toEqual([-4, 2, 0]);
    expect(bounds.max).toEqual([1, 8, 3]);
  });

  it('returns a zero box for an empty population', () => {
    const bounds = computeBounds(new Float32Array(0), 0);
    expect(bounds.min).toEqual([0, 0, 0]);
    expect(bounds.max).toEqual([0, 0, 0]);
  });
});
