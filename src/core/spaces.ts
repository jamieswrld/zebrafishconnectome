import type { EvidenceProvenance } from './provenance';
import type { Mat4 } from '@/renderer/math';

/**
 * Coordinate spaces and the transforms between them.
 *
 * Phase 2 puts the connectome inside a body, which means several coordinate
 * systems now coexist. The rule that governs all of them:
 *
 *   MEASURED FISH1 COORDINATES ARE IMMUTABLE.
 *
 * Nothing here ever rewrites a source position. A neuron's published voxel
 * coordinate is the citable fact; everything downstream is an explicit,
 * invertible, provenance-carrying transform applied on top of it. That is what
 * lets the inspector show both "source position" and "registered position" and
 * say honestly how one became the other.
 */

export type CoordinateSpaceId =
  /** Integer voxel indices exactly as Fish1 publishes them. The citable space. */
  | 'fish1-source'
  /** Fish1 voxels converted to micrometres. Anisotropy removed. */
  | 'fish1-physical'
  /** A shared anatomical reference frame (e.g. mapZebrain / FishExplorer). */
  | 'atlas'
  /** The body model in its rest pose, micrometres, origin at the body origin. */
  | 'body-rest'
  /** The body model after rig/pose deformation. */
  | 'body-pose'
  /** The simulated world (tank), millimetres. */
  | 'world'
  /** Renderer clip/view space. */
  | 'view';

export interface CoordinateSpace {
  readonly id: CoordinateSpaceId;
  readonly label: string;
  readonly units: 'voxel' | 'um' | 'mm' | 'normalized';
  readonly description: string;
}

export const COORDINATE_SPACES: Record<CoordinateSpaceId, CoordinateSpace> = {
  'fish1-source': {
    id: 'fish1-source',
    label: 'Fish1 source',
    units: 'voxel',
    description:
      'Published Fish1 voxel coordinates at 16 x 16 x 30 nm. Immutable and citable; never rewritten.',
  },
  'fish1-physical': {
    id: 'fish1-physical',
    label: 'Fish1 physical',
    units: 'um',
    description: 'Fish1 voxels scaled to micrometres. Distances are meaningful here.',
  },
  atlas: {
    id: 'atlas',
    label: 'Atlas reference',
    units: 'um',
    description:
      'Shared anatomical reference frame. Not populated in this build; reserved for a real atlas registration.',
  },
  'body-rest': {
    id: 'body-rest',
    label: 'Body rest',
    units: 'um',
    description: 'The reference body model in its undeformed rest pose.',
  },
  'body-pose': {
    id: 'body-pose',
    label: 'Body pose',
    units: 'um',
    description: 'The body after rig deformation (swimming). A per-frame visual transform.',
  },
  world: {
    id: 'world',
    label: 'World',
    units: 'mm',
    description: 'The simulated tank the organism swims in.',
  },
  view: {
    id: 'view',
    label: 'View',
    units: 'normalized',
    description: 'Camera clip space.',
  },
};

/**
 * How a transform between two spaces was obtained. This is the difference
 * between "we aligned this by eye so the UI could be built" and "this is a
 * computed anatomical registration", and the UI must never present the first
 * as the second.
 */
export type RegistrationMethod =
  /** Exact unit conversion. No assumptions, no error. */
  | 'unit-conversion'
  /** Hand-placed so development could proceed. Explicitly approximate. */
  | 'manual-approximate'
  /** Derived from landmark correspondences. */
  | 'landmark-affine'
  /** Computed by a registration algorithm against a reference volume. */
  | 'atlas-registration'
  /** Produced by the rig at runtime from the current pose. */
  | 'rig-pose';

export interface RegistrationMethodInfo {
  readonly label: string;
  readonly provenance: EvidenceProvenance;
  /** Shown wherever a position derived through this method is displayed. */
  readonly caveat: string;
}

export const REGISTRATION_METHOD_INFO: Record<RegistrationMethod, RegistrationMethodInfo> = {
  'unit-conversion': {
    label: 'Unit conversion',
    provenance: 'derived',
    caveat: 'Exact scaling between units. Introduces no positional error.',
  },
  'manual-approximate': {
    label: 'Approximate manual alignment',
    provenance: 'derived',
    caveat:
      'Hand-aligned so the body and the neurons occupy a sensible shared frame. This is NOT an anatomical registration and carries unquantified error.',
  },
  'landmark-affine': {
    label: 'Landmark affine',
    provenance: 'derived',
    caveat: 'Affine fit to landmark correspondences. Error depends on landmark accuracy.',
  },
  'atlas-registration': {
    label: 'Atlas registration',
    provenance: 'derived',
    caveat: 'Computed against a reference volume.',
  },
  'rig-pose': {
    label: 'Rig pose',
    provenance: 'simulated',
    caveat:
      'A per-frame visual deformation from the locomotion model. Purely presentational; it changes where a neuron is DRAWN, never what was measured.',
  },
};

/**
 * A directed transform between two coordinate spaces.
 *
 * `matrix` is column-major 4x4, matching the renderer and both shading
 * languages. `inverse` is stored rather than derived so that round-tripping a
 * position back to source coordinates is exact and cheap.
 */
export interface SpatialTransform {
  readonly sourceSpace: CoordinateSpaceId;
  readonly targetSpace: CoordinateSpaceId;
  readonly matrix: Mat4;
  readonly inverse: Mat4;
  readonly method: RegistrationMethod;
  readonly provenance: EvidenceProvenance;
  /** Free-text description of how this transform was established. */
  readonly notes?: string;
  /**
   * Estimated positional error in micrometres, when it can be quantified.
   * Deliberately `null` for approximate alignments: reporting a made-up number
   * would be worse than admitting the error is unknown.
   */
  readonly errorEstimateUm: number | null;
}

export interface TransformChain {
  readonly steps: readonly SpatialTransform[];
  readonly matrix: Mat4;
  readonly inverse: Mat4;
  /** Weakest provenance across the chain. */
  readonly provenance: EvidenceProvenance;
  /** True when any step is only approximate. */
  readonly approximate: boolean;
  readonly errorEstimateUm: number | null;
}
