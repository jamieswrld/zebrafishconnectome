import { computeSmoothNormals, type BoneDescriptor, type SubMesh } from '@/core/mesh';
import { BODY_LENGTH_UM } from '@/core/transforms';

/**
 * Procedural reference model of a larval zebrafish, ~7 dpf.
 *
 * PROVENANCE: MODELED REFERENCE ANATOMY.
 *
 * This is NOT the Fish1 specimen and not a scan of any animal. It is a
 * biologically proportioned reference surface built from published larval
 * morphometrics, used to give the measured connectome a plausible body.
 *
 * Why modelled rather than sourced: no openly redistributable whole-body 6-7 dpf
 * surface mesh was found. mapZebrain publishes brain regions under CC-BY-NC 4.0
 * (a NonCommercial term that would encumber this whole project, and it covers
 * the brain only, not an external body surface); FishExplorer documents
 * registration workflows rather than shipping body geometry. Rather than block
 * on an asset, the body is generated here and labelled honestly. See
 * docs/EMBODIMENT.md.
 *
 * Anatomical features that matter for looking like a LARVA rather than a small
 * adult zebrafish:
 *   - very large eyes relative to head (~165 um diameter at 7 dpf)
 *   - a single CONTINUOUS median fin fold, not separate dorsal/anal fins
 *   - a laterally compressed trunk tapering to a narrow caudal peduncle
 *   - a ventral yolk-sac extension still present behind the head
 *   - blunt snout, small mouth, no adult barbels or body depth
 */

/** Body rest space: +X anterior, +Y dorsal, +Z the animal's left. Micrometres. */
export const SNOUT_X_UM = 250;

/** Distance from the snout, 0 at the tip, BODY_LENGTH_UM at the tail tip. */
type Station = number;

interface ProfileSample {
  /** Distance from snout. */
  readonly u: Station;
  /** Half-width of the body core, mediolateral. */
  readonly halfWidth: number;
  /** Distance from the body axis to the dorsal surface. */
  readonly dorsal: number;
  /** Distance from the body axis to the ventral surface (yolk included). */
  readonly ventral: number;
  /**
   * Lateral compression, 0..1. Higher values pinch the cross-section toward a
   * blade near the dorsal/ventral extremes, which is what produces a fin fold
   * rather than a tube.
   */
  readonly compression: number;
  /** Vertical offset of the body axis, for the slight head-up larval posture. */
  readonly axisY: number;
}

/**
 * Body profile control points, in micrometres from the snout.
 * Values are eyeballed from published larval morphometrics to get a credible
 * silhouette; they are a reference shape, not a measurement of any individual.
 */
const PROFILE: readonly ProfileSample[] = [
  { u: 0, halfWidth: 18, dorsal: 30, ventral: 26, compression: 0.15, axisY: 8 },
  { u: 40, halfWidth: 74, dorsal: 76, ventral: 60, compression: 0.12, axisY: 8 },
  { u: 100, halfWidth: 124, dorsal: 118, ventral: 100, compression: 0.1, axisY: 6 },
  { u: 170, halfWidth: 148, dorsal: 138, ventral: 122, compression: 0.1, axisY: 4 },
  { u: 260, halfWidth: 152, dorsal: 146, ventral: 134, compression: 0.12, axisY: 0 },
  { u: 360, halfWidth: 144, dorsal: 144, ventral: 162, compression: 0.14, axisY: -4 },
  // Yolk-sac extension: a distinctly larval ventral bulge behind the head.
  { u: 480, halfWidth: 128, dorsal: 136, ventral: 208, compression: 0.16, axisY: -8 },
  { u: 620, halfWidth: 112, dorsal: 128, ventral: 198, compression: 0.18, axisY: -8 },
  { u: 780, halfWidth: 94, dorsal: 118, ventral: 158, compression: 0.22, axisY: -6 },
  { u: 950, halfWidth: 78, dorsal: 108, ventral: 122, compression: 0.26, axisY: -4 },
  { u: 1150, halfWidth: 64, dorsal: 100, ventral: 102, compression: 0.3, axisY: -2 },
  // Median fin fold begins: dorsal/ventral extent grows while width collapses.
  { u: 1450, halfWidth: 50, dorsal: 98, ventral: 98, compression: 0.42, axisY: 0 },
  { u: 1800, halfWidth: 40, dorsal: 100, ventral: 98, compression: 0.52, axisY: 0 },
  { u: 2200, halfWidth: 32, dorsal: 104, ventral: 100, compression: 0.6, axisY: 0 },
  { u: 2600, halfWidth: 26, dorsal: 106, ventral: 102, compression: 0.66, axisY: 0 },
  { u: 3000, halfWidth: 20, dorsal: 108, ventral: 104, compression: 0.72, axisY: 0 },
  { u: 3350, halfWidth: 14, dorsal: 112, ventral: 108, compression: 0.78, axisY: 0 },
  { u: 3650, halfWidth: 10, dorsal: 122, ventral: 116, compression: 0.84, axisY: 0 },
  { u: 3850, halfWidth: 7, dorsal: 132, ventral: 124, compression: 0.88, axisY: 0 },
  { u: 4000, halfWidth: 3, dorsal: 96, ventral: 90, compression: 0.92, axisY: 0 },
];

function sampleProfile(u: number): ProfileSample {
  if (u <= PROFILE[0].u) return PROFILE[0];
  const last = PROFILE[PROFILE.length - 1];
  if (u >= last.u) return last;

  let i = 0;
  while (i < PROFILE.length - 1 && PROFILE[i + 1].u < u) i++;
  const a = PROFILE[i];
  const b = PROFILE[i + 1];
  const raw = (u - a.u) / (b.u - a.u);
  // Smoothstep between control points so the hull has no visible facets.
  const t = raw * raw * (3 - 2 * raw);
  const mix = (p: number, q: number) => p + (q - p) * t;
  return {
    u,
    halfWidth: mix(a.halfWidth, b.halfWidth),
    dorsal: mix(a.dorsal, b.dorsal),
    ventral: mix(a.ventral, b.ventral),
    compression: mix(a.compression, b.compression),
    axisY: mix(a.axisY, b.axisY),
  };
}

export interface LarvaModelOptions {
  /** Rings along the body. More stations = smoother silhouette. */
  readonly stations?: number;
  /** Vertices per ring. */
  readonly ringSegments?: number;
  /** Longitude/latitude divisions for each eye. */
  readonly eyeSegments?: number;
  readonly spineBones?: number;
}

export interface LarvaModel {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly boneIndices: Uint8Array;
  readonly boneWeights: Uint8Array;
  readonly subMeshes: SubMesh[];
  readonly bones: BoneDescriptor[];
  readonly eyes: readonly EyeDescriptor[];
  readonly vertexCount: number;
  readonly triangleCount: number;
}

export interface EyeDescriptor {
  readonly side: 'left' | 'right';
  /** Centre in body rest space, micrometres. */
  readonly centreUm: readonly [number, number, number];
  readonly radiusUm: number;
  /** Outward optical axis in body rest space. */
  readonly forward: readonly [number, number, number];
  /** Approximate monocular field of view, degrees. */
  readonly fieldOfViewDeg: number;
}

const EYE_U = 150;
const EYE_RADIUS_UM = 84;
const EYE_LATERAL_UM = 126;
const EYE_DORSAL_UM = 22;

/**
 * Larval zebrafish eyes point laterally and slightly forward, giving a wide
 * panoramic field with a modest binocular overlap ahead of the snout.
 */
export const EYES: readonly EyeDescriptor[] = [
  {
    side: 'left',
    centreUm: [SNOUT_X_UM - EYE_U, EYE_DORSAL_UM, EYE_LATERAL_UM],
    radiusUm: EYE_RADIUS_UM,
    forward: [0.42, 0.05, 0.91],
    fieldOfViewDeg: 163,
  },
  {
    side: 'right',
    centreUm: [SNOUT_X_UM - EYE_U, EYE_DORSAL_UM, -EYE_LATERAL_UM],
    radiusUm: EYE_RADIUS_UM,
    forward: [0.42, 0.05, -0.91],
    fieldOfViewDeg: 163,
  },
];

/** The head stays rigid; only tissue behind this station is deformed by swimming. */
export const HEAD_END_U = 420;

/**
 * Builds the rig: one rigid head bone followed by a chain of spine bones.
 * Segment lengths grow slightly toward the tail so the posterior bends more per
 * bone, which is what produces a larval tail beat rather than a stiff paddle.
 */
export function buildRig(spineBones: number): BoneDescriptor[] {
  const bones: BoneDescriptor[] = [
    {
      name: 'head',
      parent: -1,
      headUm: [SNOUT_X_UM, 0, 0],
      tailUm: [SNOUT_X_UM - HEAD_END_U, 0, 0],
    },
  ];

  const spineSpan = BODY_LENGTH_UM - HEAD_END_U;
  let u = HEAD_END_U;
  for (let i = 0; i < spineBones; i++) {
    // Geometric-ish growth: posterior segments are longer.
    const frac = (i + 1) / spineBones;
    const nextU = HEAD_END_U + spineSpan * (frac * frac * 0.45 + frac * 0.55);
    bones.push({
      name: `spine_${String(i).padStart(2, '0')}`,
      parent: i,
      headUm: [SNOUT_X_UM - u, 0, 0],
      tailUm: [SNOUT_X_UM - nextU, 0, 0],
    });
    u = nextU;
  }
  return bones;
}

/** Maps a station to the two bones that influence it, with a smooth blend. */
function skinWeights(
  u: number,
  bones: readonly BoneDescriptor[],
): { indices: [number, number]; weights: [number, number] } {
  // The head is rigid: everything anterior of HEAD_END_U binds fully to bone 0.
  if (u <= HEAD_END_U) return { indices: [0, 0], weights: [1, 0] };

  // Bone i (i >= 1) spans [headU, tailU] measured from the snout.
  for (let i = 1; i < bones.length; i++) {
    const startU = SNOUT_X_UM - bones[i].headUm[0];
    const endU = SNOUT_X_UM - bones[i].tailUm[0];
    if (u <= endU || i === bones.length - 1) {
      const span = Math.max(endU - startU, 1e-6);
      const t = Math.min(Math.max((u - startU) / span, 0), 1);
      // Blend into the NEXT bone over the second half of this segment, so the
      // surface bends continuously instead of creasing at joints.
      if (i + 1 < bones.length && t > 0.5) {
        const blend = (t - 0.5) * 2 * 0.5;
        return { indices: [i, i + 1], weights: [1 - blend, blend] };
      }
      if (i > 1 && t < 0.5) {
        const blend = (0.5 - t) * 2 * 0.5;
        return { indices: [i, i - 1], weights: [1 - blend, blend] };
      }
      return { indices: [i, i], weights: [1, 0] };
    }
  }
  return { indices: [bones.length - 1, bones.length - 1], weights: [1, 0] };
}

/**
 * Generates the complete larval body: lofted trunk plus two eye spheres.
 * Deterministic — the same options always produce byte-identical geometry.
 */
export function buildLarvaModel(options: LarvaModelOptions = {}): LarvaModel {
  const stations = options.stations ?? 116;
  const ring = options.ringSegments ?? 22;
  const eyeSegments = options.eyeSegments ?? 18;
  const spineBones = options.spineBones ?? 9;

  const bones = buildRig(spineBones);

  const positions: number[] = [];
  const indices: number[] = [];
  const boneIdx: number[] = [];
  const boneWt: number[] = [];

  /* ------------------------------------------------------------------ body */
  const bodyStart = 0;
  for (let s = 0; s < stations; s++) {
    // Bias sampling toward the head, where curvature is highest.
    const t = s / (stations - 1);
    const u = Math.pow(t, 1.25) * BODY_LENGTH_UM;
    const p = sampleProfile(u);
    const x = SNOUT_X_UM - u;
    const skin = skinWeights(u, bones);

    for (let r = 0; r < ring; r++) {
      const theta = (r / ring) * Math.PI * 2;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);

      const vertical = sinT >= 0 ? p.dorsal : p.ventral;
      // Pinch the width toward the dorsal/ventral extremes. At high compression
      // this turns the cross-section into a blade: the median fin fold.
      const widthFalloff = 1 - p.compression * Math.pow(Math.abs(sinT), 0.75);

      positions.push(x, p.axisY + vertical * sinT, p.halfWidth * cosT * widthFalloff);
      boneIdx.push(skin.indices[0], skin.indices[1], 0, 0);
      boneWt.push(Math.round(skin.weights[0] * 255), Math.round(skin.weights[1] * 255), 0, 0);
    }
  }

  for (let s = 0; s < stations - 1; s++) {
    for (let r = 0; r < ring; r++) {
      const r1 = (r + 1) % ring;
      const a = bodyStart + s * ring + r;
      const b = bodyStart + s * ring + r1;
      const c = bodyStart + (s + 1) * ring + r;
      const d = bodyStart + (s + 1) * ring + r1;
      indices.push(a, c, b, b, c, d);
    }
  }

  // Close the snout and the tail tip with fans.
  const snoutCentre = positions.length / 3;
  positions.push(SNOUT_X_UM + 10, sampleProfile(0).axisY, 0);
  boneIdx.push(0, 0, 0, 0);
  boneWt.push(255, 0, 0, 0);
  for (let r = 0; r < ring; r++) {
    indices.push(snoutCentre, bodyStart + ((r + 1) % ring), bodyStart + r);
  }

  const tailCentre = positions.length / 3;
  const tailSkin = skinWeights(BODY_LENGTH_UM, bones);
  positions.push(SNOUT_X_UM - BODY_LENGTH_UM - 6, 0, 0);
  boneIdx.push(tailSkin.indices[0], tailSkin.indices[1], 0, 0);
  boneWt.push(
    Math.round(tailSkin.weights[0] * 255),
    Math.round(tailSkin.weights[1] * 255),
    0,
    0,
  );
  const lastRing = bodyStart + (stations - 1) * ring;
  for (let r = 0; r < ring; r++) {
    indices.push(tailCentre, lastRing + r, lastRing + ((r + 1) % ring));
  }

  const bodyIndexCount = indices.length;

  /* ------------------------------------------------------------------ eyes */
  const eyeIndexStart = indices.length;
  for (const eye of EYES) {
    const base = positions.length / 3;
    const rings = eyeSegments;
    const segs = eyeSegments;
    // Eyes ride on the rigid head bone, so they never deform when swimming.
    for (let i = 0; i <= rings; i++) {
      const phi = (i / rings) * Math.PI;
      for (let j = 0; j <= segs; j++) {
        const theta = (j / segs) * Math.PI * 2;
        // Slight lateral flattening, as larval eyes are not perfect spheres.
        positions.push(
          eye.centreUm[0] + eye.radiusUm * Math.sin(phi) * Math.cos(theta) * 0.94,
          eye.centreUm[1] + eye.radiusUm * Math.cos(phi),
          eye.centreUm[2] + eye.radiusUm * Math.sin(phi) * Math.sin(theta) * 0.88,
        );
        boneIdx.push(0, 0, 0, 0);
        boneWt.push(255, 0, 0, 0);
      }
    }
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < segs; j++) {
        const a = base + i * (segs + 1) + j;
        const b = a + segs + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }

  const positionsArray = new Float32Array(positions);
  const indicesArray = new Uint32Array(indices);
  const normals = computeSmoothNormals(positionsArray, indicesArray);

  const subMeshes: SubMesh[] = [
    { name: 'body', material: 'skin', indexOffset: 0, indexCount: bodyIndexCount },
    {
      name: 'eyes',
      material: 'eye',
      indexOffset: eyeIndexStart,
      indexCount: indices.length - eyeIndexStart,
    },
  ];

  return {
    positions: positionsArray,
    normals,
    indices: indicesArray,
    boneIndices: new Uint8Array(boneIdx),
    boneWeights: new Uint8Array(boneWt),
    subMeshes,
    bones,
    eyes: EYES,
    vertexCount: positionsArray.length / 3,
    triangleCount: indicesArray.length / 3,
  };
}

export const LARVA_ATTRIBUTION =
  'Modeled reference anatomy. Procedurally generated from published larval zebrafish morphometrics. NOT the Fish1 specimen and not a scan of any individual animal.';

export const LARVA_LICENSE =
  'Generated by this project; no third-party asset. Free to use with the rest of this repository.';
