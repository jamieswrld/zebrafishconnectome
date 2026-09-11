/**
 * Coordinate handling.
 *
 * Three distinct spaces exist, and they must never be conflated:
 *
 *   1. SOURCE VOXEL SPACE  Integer voxel indices exactly as published by the
 *                          dataset (Fish1 `pt_position`, at 16 x 16 x 30 nm).
 *                          This is the citable coordinate. It is stored
 *                          verbatim and is NEVER rewritten by this app.
 *
 *   2. PHYSICAL SPACE      Anisotropy removed: micrometres. Derived from (1)
 *                          by multiplying with the dataset voxel size.
 *                          This is the space in which distances are meaningful.
 *
 *   3. WORLD SPACE         What the renderer draws: physical space recentred on
 *                          the dataset centroid and uniformly scaled so the
 *                          brain fits a predictable camera volume.
 *                          This is a *presentation* transform only. It is
 *                          uniform and invertible, so any world coordinate can
 *                          be mapped back to physical and source coordinates.
 *
 * Rule: the render transform must be uniform (one scalar scale) and it must be
 * invertible. A non-uniform or lossy transform would silently distort
 * morphology and any distance measured on screen.
 */

export type Vec3 = readonly [number, number, number];

/** Description of a dataset native voxel grid. */
export interface VoxelSpace {
  /** Physical size of one voxel along x, y, z, in nanometres. */
  readonly voxelSizeNm: Vec3;
  /** Axis order of the published coordinate triples. */
  readonly axisOrder: 'xyz';
  /** Inclusive min / exclusive max of the published volume, in voxels. */
  readonly boundsVoxel?: { readonly min: Vec3; readonly max: Vec3 };
  /**
   * Human-readable anatomical meaning of +x/+y/+z, when the dataset documents
   * it. Left undefined when unknown - we do not guess anatomical orientation,
   * because mislabelling dorsal/ventral silently inverts scientific claims.
   */
  readonly anatomicalAxes?: AnatomicalAxes;
}

export interface AnatomicalAxes {
  /** What increasing X means, e.g. right or anterior. */
  readonly xPositive: AnatomicalDirection;
  readonly yPositive: AnatomicalDirection;
  readonly zPositive: AnatomicalDirection;
  /** How the orientation was established. */
  readonly source: 'dataset-documentation' | 'atlas-registration' | 'assumed';
}

export type AnatomicalDirection =
  'anterior' | 'posterior' | 'dorsal' | 'ventral' | 'left' | 'right';

export const OPPOSITE_DIRECTION: Record<AnatomicalDirection, AnatomicalDirection> = {
  anterior: 'posterior',
  posterior: 'anterior',
  dorsal: 'ventral',
  ventral: 'dorsal',
  left: 'right',
  right: 'left',
};

/** Uniform, invertible source -> world presentation transform. */
export interface RenderTransform {
  /** Centroid of the population in micrometres, subtracted before scaling. */
  readonly centerUm: Vec3;
  /** Single uniform scale factor applied after centring (world units / um). */
  readonly scale: number;
}

export const NM_PER_UM = 1000;

export function voxelToMicrometres(voxel: Vec3, space: VoxelSpace): Vec3 {
  const [sx, sy, sz] = space.voxelSizeNm;
  return [
    (voxel[0] * sx) / NM_PER_UM,
    (voxel[1] * sy) / NM_PER_UM,
    (voxel[2] * sz) / NM_PER_UM,
  ];
}

export function micrometresToVoxel(um: Vec3, space: VoxelSpace): Vec3 {
  const [sx, sy, sz] = space.voxelSizeNm;
  return [(um[0] * NM_PER_UM) / sx, (um[1] * NM_PER_UM) / sy, (um[2] * NM_PER_UM) / sz];
}

export function micrometresToWorld(um: Vec3, t: RenderTransform): Vec3 {
  return [
    (um[0] - t.centerUm[0]) * t.scale,
    (um[1] - t.centerUm[1]) * t.scale,
    (um[2] - t.centerUm[2]) * t.scale,
  ];
}

export function worldToMicrometres(world: Vec3, t: RenderTransform): Vec3 {
  return [
    world[0] / t.scale + t.centerUm[0],
    world[1] / t.scale + t.centerUm[1],
    world[2] / t.scale + t.centerUm[2],
  ];
}

export function voxelToWorld(voxel: Vec3, space: VoxelSpace, t: RenderTransform): Vec3 {
  return micrometresToWorld(voxelToMicrometres(voxel, space), t);
}

export function worldToVoxel(world: Vec3, space: VoxelSpace, t: RenderTransform): Vec3 {
  return micrometresToVoxel(worldToMicrometres(world, t), space);
}

/**
 * Derives a presentation transform that centres a population and scales its
 * largest extent to `targetExtent` world units.
 *
 * Operates on a Float32Array of interleaved xyz micrometre values so it can run
 * over the whole population without allocating per-neuron objects.
 */
export function computeRenderTransform(
  positionsUm: Float32Array,
  count: number,
  targetExtent = 2,
): RenderTransform {
  if (count <= 0) return { centerUm: [0, 0, 0], scale: 1 };

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < count; i++) {
    const x = positionsUm[i * 3];
    const y = positionsUm[i * 3 + 1];
    const z = positionsUm[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  if (!Number.isFinite(minX)) return { centerUm: [0, 0, 0], scale: 1 };

  const centerUm: Vec3 = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  // Uniform scale: preserves aspect ratio, so on-screen distances stay
  // proportional to real micrometres.
  const scale = extent > 0 ? targetExtent / extent : 1;
  return { centerUm, scale };
}

/** Axis-aligned bounds in an unspecified space; used for LOD and framing. */
export interface Bounds3 {
  min: Vec3;
  max: Vec3;
}

export function boundsCenter(b: Bounds3): Vec3 {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

export function boundsRadius(b: Bounds3): number {
  const dx = b.max[0] - b.min[0];
  const dy = b.max[1] - b.min[1];
  const dz = b.max[2] - b.min[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz) / 2;
}

/** Computes bounds over an interleaved xyz Float32Array. */
export function computeBounds(positions: Float32Array, count: number): Bounds3 {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}
