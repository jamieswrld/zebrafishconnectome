import { decodeMesh, type MeshGeometry } from '@/core/mesh';
import { DataError } from '@/core/errors';
import {
  composeChain,
  fish1PhysicalToBodyRest,
  fish1SourceToPhysical,
} from '@/core/transforms';
import type { TransformChain } from '@/core/spaces';
import type { NeuronIndex } from '@/core/types';
import {
  identity,
  mat4,
  multiply,
  transformAffine,
  type Mat4,
  type Vec3f,
} from '@/renderer/math';

/**
 * Placing the reference body around the measured connectome.
 *
 * The neurons were already mapped into render space by
 * `NeuronIndex.renderTransform` (centre, then uniform scale). For the body to
 * appear around them rather than beside them, it has to travel the same route
 * BACKWARDS from body space:
 *
 *   body-rest --(registration inverse)--> fish1-physical --(render)--> render
 *
 * Composing it this way, rather than hand-placing the body in render space,
 * means the single registration matrix is the only thing that defines where the
 * animal sits relative to its neurons — and it can be inspected, inverted, and
 * replaced by a real atlas registration without touching the renderer.
 */

export interface BodyManifest {
  readonly asset: string;
  readonly version: string;
  readonly provenance: string;
  readonly attribution: string;
  readonly license: string;
  readonly space: string;
  readonly units: string;
  readonly bodyLengthUm: number;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly boneCount: number;
  readonly bytes: number;
  readonly eyes: ReadonlyArray<{
    readonly side: 'left' | 'right';
    readonly centreUm: readonly [number, number, number];
    readonly radiusUm: number;
    readonly forward: readonly [number, number, number];
    readonly fieldOfViewDeg: number;
  }>;
  readonly files: { readonly mesh: string };
}

export interface LoadedBody {
  readonly geometry: MeshGeometry;
  readonly manifest: BodyManifest;
  readonly bytes: number;
}

/** Fetches the prebuilt body artifact. Lazy: only the organism views call it. */
export async function loadReferenceBody(signal?: AbortSignal): Promise<LoadedBody> {
  let manifest: BodyManifest;
  try {
    const response = await fetch('/body/manifest.json', { signal });
    if (!response.ok) {
      throw new DataError({
        code: 'not_found',
        message: `Body manifest request failed with HTTP ${response.status}.`,
        detail: 'Run "npm run build:body" to generate the reference body artifact.',
      });
    }
    manifest = (await response.json()) as BodyManifest;
  } catch (e) {
    if (e instanceof DataError) throw e;
    throw new DataError({
      code: 'upstream_unavailable',
      message: 'Could not fetch the body manifest.',
      cause: e,
    });
  }

  const meshResponse = await fetch(manifest.files.mesh, { signal });
  if (!meshResponse.ok) {
    throw new DataError({
      code: 'not_found',
      message: `Body mesh request failed with HTTP ${meshResponse.status}.`,
    });
  }
  const buffer = await meshResponse.arrayBuffer();
  const geometry = decodeMesh(buffer);

  if (geometry.vertexCount !== manifest.vertexCount) {
    throw new DataError({
      code: 'version_mismatch',
      message: `Body manifest promises ${manifest.vertexCount} vertices but the mesh contains ${geometry.vertexCount}.`,
    });
  }

  return { geometry, manifest, bytes: buffer.byteLength };
}

/** Centroid of a loaded population, in micrometres. */
export function populationCentroidUm(index: NeuronIndex): Vec3f {
  if (index.count === 0) return [0, 0, 0];
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < index.count; i++) {
    x += index.positionsUm[i * 3];
    y += index.positionsUm[i * 3 + 1];
    z += index.positionsUm[i * 3 + 2];
  }
  return [x / index.count, y / index.count, z / index.count];
}

export interface BodyPlacement {
  /** body-rest -> render space. Hand this straight to the renderer. */
  readonly modelMatrix: Mat4;
  /** fish1-source -> body-rest, for the inspector's registered position. */
  readonly registration: TransformChain;
  /** Render-space bounds of the whole animal, for camera framing. */
  readonly boundsRender: { min: Vec3f; max: Vec3f };
}

/**
 * Builds the body's render-space transform from the loaded population.
 *
 * @param index    The loaded neuron population (supplies renderTransform).
 * @param geometry The body mesh (supplies rest-space bounds).
 */
export function computeBodyPlacement(
  index: NeuronIndex,
  geometry: MeshGeometry,
): BodyPlacement {
  const centroid = populationCentroidUm(index);
  const toBody = fish1PhysicalToBodyRest(centroid);

  // body-rest -> fish1-physical
  const bodyToPhysical = mat4();
  bodyToPhysical.set(toBody.inverse);

  // fish1-physical -> render: translate by -centre, then uniform scale.
  const { centerUm, scale } = index.renderTransform;
  const physicalToRender = mat4();
  identity(physicalToRender);
  physicalToRender[0] = scale;
  physicalToRender[5] = scale;
  physicalToRender[10] = scale;
  physicalToRender[12] = -centerUm[0] * scale;
  physicalToRender[13] = -centerUm[1] * scale;
  physicalToRender[14] = -centerUm[2] * scale;

  const modelMatrix = mat4();
  multiply(modelMatrix, physicalToRender, bodyToPhysical);

  // Transform the mesh's rest-space AABB corners into render space. Rotating a
  // box means the corners must be transformed individually, not the extremes.
  const { min, max } = geometry.boundsUm;
  let rMin: Vec3f = [Infinity, Infinity, Infinity];
  let rMax: Vec3f = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const p: Vec3f = [
      corner & 1 ? max[0] : min[0],
      corner & 2 ? max[1] : min[1],
      corner & 4 ? max[2] : min[2],
    ];
    const t = transformAffine(modelMatrix, p);
    for (let a = 0; a < 3; a++) {
      if (t[a] < rMin[a]) rMin[a] = t[a];
      if (t[a] > rMax[a]) rMax[a] = t[a];
    }
  }

  const registration = composeChain([
    fish1SourceToPhysical(index.voxelSpace.voxelSizeNm as unknown as Vec3f),
    toBody,
  ]);

  return { modelMatrix, registration, boundsRender: { min: rMin, max: rMax } };
}

/** Render-space bounds of the loaded neuron population, for the BRAIN preset. */
export function neuronBoundsRender(index: NeuronIndex): { min: Vec3f; max: Vec3f } {
  const { centerUm, scale } = index.renderTransform;
  let min: Vec3f = [Infinity, Infinity, Infinity];
  let max: Vec3f = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < index.count; i++) {
    for (let a = 0; a < 3; a++) {
      const v = (index.positionsUm[i * 3 + a] - centerUm[a]) * scale;
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}
