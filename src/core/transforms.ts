import {
  identity,
  invert,
  mat4,
  multiply,
  transformAffine,
  type Mat4,
  type Vec3f,
} from '@/renderer/math';
import { weakestProvenance, type EvidenceProvenance } from './provenance';
import {
  REGISTRATION_METHOD_INFO,
  type CoordinateSpaceId,
  type RegistrationMethod,
  type SpatialTransform,
  type TransformChain,
} from './spaces';
import type { AnatomicalDirection } from './coords';

/**
 * Building and composing the transforms that place measured Fish1 neurons
 * inside a body, and the body inside a world.
 *
 * Measured coordinates are never modified. Every position the user sees outside
 * `fish1-source` is produced by composing explicit matrices that can be
 * inverted to recover the published voxel coordinate exactly.
 */

/* -------------------------------------------------------------------------- */
/* What we actually know about the Fish1 volume                               */
/* -------------------------------------------------------------------------- */

/**
 * Full extent of the published Fish1 EM volume.
 *
 * Read from the public precomputed metadata rather than assumed:
 *   https://storage.googleapis.com/fish1-public/clahe_231218/info
 *     mip0  size [280000, 65000, 8689] @ 8 x 8 x 30 nm
 *     mip1  size [140000, 32500, 8689] @ 16 x 16 x 30 nm
 *   => 2240 x 520 x 260.7 um
 *
 * These are two scales of one pyramid, and the mip0 bounds are what identify
 * the grid the released soma coordinates actually use: they reach y = 49,799,
 * which fits 65,000 but not 32,500. The release prose says 16 x 16 x 30 nm for
 * `somas.pt_position`; the data says 8 x 8 x 30. See FISH1_VOXEL_SPACE in
 * datasets/fish1/constants.ts for the full argument.
 */
export const FISH1_VOLUME_EXTENT_UM: Vec3f = [2240, 520, 260.7];

export interface Fish1AxisInterpretation {
  readonly axis: 'x' | 'y' | 'z';
  /** What increasing values along this axis correspond to. */
  readonly positiveDirection: AnatomicalDirection;
  readonly extentUm: number;
  readonly evidence: string;
  readonly confidence: 'strong' | 'moderate' | 'assumed';
}

/**
 * Anatomical interpretation of the Fish1 axes.
 *
 * The release does not state this, so it is DERIVED, and the evidence is
 * recorded next to each axis so a reader can disagree with it. The application
 * therefore still shows no dorsal/ventral labels on raw Fish1 coordinates; this
 * interpretation exists only to place a reference body around the data, and the
 * resulting registration is labelled approximate throughout.
 */
export const FISH1_AXES: readonly Fish1AxisInterpretation[] = [
  {
    axis: 'x',
    positiveDirection: 'posterior',
    extentUm: 2240,
    evidence:
      'Longest volume axis at 2240 um, consistent with "brain and anterior spinal cord" of a 7 dpf larva. Sign from the released subset: soma density is positively skewed along +x, i.e. a sparse tail of cells extends toward higher x, as expected moving from dense brain into spinal cord.',
    confidence: 'moderate',
  },
  {
    axis: 'y',
    positiveDirection: 'left',
    extentUm: 520,
    evidence:
      'Volume extent 520 um matches larval head width. Left/right assignment itself is arbitrary without a documented handedness and is NOT relied on for anything scientific.',
    confidence: 'assumed',
  },
  {
    axis: 'z',
    positiveDirection: 'dorsal',
    extentUm: 260.7,
    evidence:
      'Thinnest volume axis at 260.7 um, matching larval brain dorsoventral depth, and the serial-section axis (30 nm sections).',
    confidence: 'moderate',
  },
];

/* -------------------------------------------------------------------------- */
/* Body rest space convention                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Body rest space, in micrometres:
 *   +X anterior (toward the snout)
 *   +Y dorsal
 *   +Z the animal's left
 *   origin between the eyes, at the centre of the head
 *
 * +Y dorsal is chosen because the renderer camera treats +Y as up, so a fish at
 * rest appears upright with no extra transform.
 */
export const BODY_AXES = {
  xPositive: 'anterior' as AnatomicalDirection,
  yPositive: 'dorsal' as AnatomicalDirection,
  zPositive: 'left' as AnatomicalDirection,
};

/** Total length of the reference larva, micrometres (7 dpf ~ 4 mm). */
export const BODY_LENGTH_UM = 4000;

/**
 * Where the centroid of the Fish1 population sits in body rest space.
 *
 * Chosen so the released region (164 um rostrocaudal) lies inside the RIGID
 * head bone, which spans from the snout back to HEAD_END_U. Brain tissue must
 * not be deformed by the swimming rig.
 */
export const BRAIN_ANCHOR_UM: Vec3f = [-55, 28, 0];

export function createTransform(init: {
  sourceSpace: CoordinateSpaceId;
  targetSpace: CoordinateSpaceId;
  matrix: Mat4;
  method: RegistrationMethod;
  notes?: string;
  errorEstimateUm?: number | null;
}): SpatialTransform {
  const inverse = mat4();
  if (!invert(inverse, init.matrix)) {
    throw new Error(
      `Transform ${init.sourceSpace} -> ${init.targetSpace} is singular and cannot be inverted.`,
    );
  }
  return {
    sourceSpace: init.sourceSpace,
    targetSpace: init.targetSpace,
    matrix: init.matrix,
    inverse,
    method: init.method,
    provenance: REGISTRATION_METHOD_INFO[init.method].provenance,
    notes: init.notes,
    errorEstimateUm: init.errorEstimateUm ?? null,
  };
}

/**
 * Fish1 physical (micrometres) -> body rest space.
 *
 * A RIGID transform only: an axis permutation with one sign flip (determinant
 * +1, so handedness is preserved) plus a translation. There is deliberately no
 * scaling — both spaces are micrometres and both describe a 7 dpf larva, so
 * scaling would distort real measured distances to make the picture tidier.
 *
 * Axis mapping, from FISH1_AXES and BODY_AXES:
 *   fish +x (posterior)   -> body -x   (because body +x is anterior)
 *   fish +y (mediolateral)-> body +z
 *   fish +z (dorsal)      -> body +y
 *
 * @param centroidUm Centroid of the loaded Fish1 population, in micrometres.
 */
export function fish1PhysicalToBodyRest(centroidUm: Vec3f): SpatialTransform {
  const m = mat4();
  identity(m);

  // Column-major: column i is the image of the source basis vector i.
  // fish x -> (-1, 0, 0)
  m[0] = -1;
  m[1] = 0;
  m[2] = 0;
  // fish y -> (0, 0, 1)
  m[4] = 0;
  m[5] = 0;
  m[6] = 1;
  // fish z -> (0, 1, 0)
  m[8] = 0;
  m[9] = 1;
  m[10] = 0;

  // Translation places the population centroid at the brain anchor.
  m[12] = BRAIN_ANCHOR_UM[0] + centroidUm[0];
  m[13] = BRAIN_ANCHOR_UM[1] - centroidUm[2];
  m[14] = BRAIN_ANCHOR_UM[2] - centroidUm[1];

  return createTransform({
    sourceSpace: 'fish1-physical',
    targetSpace: 'body-rest',
    matrix: m,
    method: 'manual-approximate',
    notes:
      'Rigid axis permutation derived from the published volume aspect ratio, plus a translation that centres the loaded population at the reference brain anchor. This is a presentation alignment so the body and the neurons share a frame. It is NOT an anatomical registration: no landmark correspondences were fitted and no atlas was used.',
    errorEstimateUm: null,
  });
}

/** Fish1 source voxels -> micrometres. Exact, lossless, invertible. */
export function fish1SourceToPhysical(voxelSizeNm: Vec3f): SpatialTransform {
  const m = mat4();
  identity(m);
  m[0] = voxelSizeNm[0] / 1000;
  m[5] = voxelSizeNm[1] / 1000;
  m[10] = voxelSizeNm[2] / 1000;
  return createTransform({
    sourceSpace: 'fish1-source',
    targetSpace: 'fish1-physical',
    matrix: m,
    method: 'unit-conversion',
    notes: `Scales published voxel indices by the dataset voxel size (${voxelSizeNm.join(' x ')} nm).`,
    errorEstimateUm: 0,
  });
}

/**
 * Body rest -> world, from the organism's position and heading.
 *
 * World units are millimetres, body units micrometres, hence the 1/1000 scale.
 */
export function bodyRestToWorld(positionMm: Vec3f, headingRadians: number): SpatialTransform {
  const m = mat4();
  const s = 0.001;
  const c = Math.cos(headingRadians);
  const sn = Math.sin(headingRadians);
  // Yaw about +Y (dorsoventral), which is how a fish turns.
  m[0] = c * s;
  m[1] = 0;
  m[2] = -sn * s;
  m[3] = 0;
  m[4] = 0;
  m[5] = s;
  m[6] = 0;
  m[7] = 0;
  m[8] = sn * s;
  m[9] = 0;
  m[10] = c * s;
  m[11] = 0;
  m[12] = positionMm[0];
  m[13] = positionMm[1];
  m[14] = positionMm[2];
  m[15] = 1;

  return createTransform({
    sourceSpace: 'body-rest',
    targetSpace: 'world',
    matrix: m,
    method: 'rig-pose',
    notes: 'Rigid placement of the organism in the tank from the locomotion model.',
    errorEstimateUm: null,
  });
}

/* -------------------------------------------------------------------------- */
/* Composition                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Composes a chain of transforms into a single matrix.
 *
 * Chain provenance is the WEAKEST link: an exact unit conversion followed by an
 * approximate alignment yields an approximate result, and the UI must say so.
 */
export function composeChain(steps: readonly SpatialTransform[]): TransformChain {
  if (steps.length === 0) {
    const m = mat4();
    return {
      steps,
      matrix: m,
      inverse: mat4(),
      provenance: 'derived',
      approximate: false,
      errorEstimateUm: 0,
    };
  }

  for (let i = 1; i < steps.length; i++) {
    if (steps[i].sourceSpace !== steps[i - 1].targetSpace) {
      throw new Error(
        `Transform chain is discontinuous: ${steps[i - 1].targetSpace} -> ${steps[i].sourceSpace}.`,
      );
    }
  }

  const matrix = mat4();
  identity(matrix);
  for (const step of steps) {
    // Later steps apply on the left: M = Sn * ... * S1.
    multiply(matrix, step.matrix, matrix);
  }

  const inverse = mat4();
  if (!invert(inverse, matrix)) {
    throw new Error('Composed transform chain is singular.');
  }

  const provenance: EvidenceProvenance = weakestProvenance(steps.map((s) => s.provenance));
  const approximate = steps.some(
    (s) => s.method === 'manual-approximate' || s.errorEstimateUm === null,
  );
  const errors = steps.map((s) => s.errorEstimateUm);
  const errorEstimateUm = errors.some((e) => e === null)
    ? null
    : errors.reduce((sum: number, e) => sum + (e ?? 0), 0);

  return { steps, matrix, inverse, provenance, approximate, errorEstimateUm };
}

export function applyChain(chain: TransformChain, point: Vec3f): Vec3f {
  return transformAffine(chain.matrix, point);
}

export function applyChainInverse(chain: TransformChain, point: Vec3f): Vec3f {
  return transformAffine(chain.inverse, point);
}

/**
 * A registered position together with everything needed to judge it.
 * The inspector renders exactly this shape.
 */
export interface RegisteredPosition {
  readonly sourceVoxel: Vec3f;
  readonly physicalUm: Vec3f;
  readonly bodyRestUm: Vec3f;
  readonly space: CoordinateSpaceId;
  readonly method: RegistrationMethod;
  readonly provenance: EvidenceProvenance;
  readonly approximate: boolean;
  readonly errorEstimateUm: number | null;
}
