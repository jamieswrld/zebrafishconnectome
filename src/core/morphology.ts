import { computeSmoothNormals, type MeshGeometry } from './mesh';

/**
 * Real traced neuron morphology.
 *
 * Decodes the MOR1 container written by `pipeline/fish1/hmi/build_morphology.py`
 * from the published Fish1 hindbrain reconstructions. Every vertex here is a
 * point on the reconstructed surface of an actual neuron, and the segment ids
 * are the same stable cell ids whose measured connectivity drives the
 * simulation — so the shape you see belongs to the cell that is firing.
 *
 * PROVENANCE: MEASURED, decimated. The release publishes levels of detail 0-3;
 * this is level 3, roughly 1,100 vertices per cell rather than 138,000. It is a
 * faithful but coarse surface, and the UI says so rather than implying the
 * viewer is showing the full reconstruction.
 *
 * Positions arrive quantised to 16 bits inside a per-class bounding box, which
 * at this level of detail is far finer than the reconstruction's own precision
 * and halves the artefact. They decode into the SAME source voxel grid the soma
 * positions use, so morphology and soma share one space with no second
 * transform to get wrong.
 */

export interface MorphologyCell {
  readonly loreId: number;
  readonly firstIndex: number;
  readonly indexCount: number;
  readonly firstVertex: number;
  readonly vertexCount: number;
}

export interface MorphologyClass {
  readonly className: string;
  readonly lod: number;
  readonly cellCount: number;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly cells: readonly MorphologyCell[];
  /** Positions in source voxels, xyz interleaved. */
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly citation: string;
  readonly source: string;
  readonly note: string;
}

export interface MorphologyManifest {
  readonly dataset: string;
  readonly version: string;
  readonly lod: number;
  readonly totals: {
    readonly cells: number;
    readonly vertices: number;
    readonly triangles: number;
    readonly bytes: number;
  };
  readonly classes: Readonly<
    Record<
      string,
      {
        readonly file: string;
        readonly cells: number;
        readonly vertices: number;
        readonly triangles: number;
        readonly bytes: number;
      }
    >
  >;
  readonly citation: string;
  readonly source: string;
  readonly note: string;
}

export class MorphologyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MorphologyFormatError';
  }
}

const MAGIC = 0x4d4f5231; // 'MOR1'

function align8(value: number): number {
  const remainder = value % 8;
  return remainder === 0 ? value : value + (8 - remainder);
}

export function decodeMorphology(buffer: ArrayBuffer): MorphologyClass {
  if (buffer.byteLength < 8) {
    throw new MorphologyFormatError('Buffer is too small to be a MOR1 container.');
  }
  const view = new DataView(buffer);
  if (view.getUint32(0, false) !== MAGIC) {
    throw new MorphologyFormatError('Not a MOR1 container: bad magic.');
  }
  const descriptorLength = view.getUint32(4, true);
  if (8 + descriptorLength > buffer.byteLength) {
    throw new MorphologyFormatError('Descriptor length exceeds the buffer.');
  }
  const descriptor = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 8, descriptorLength)),
  ) as Record<string, unknown>;

  const vertexCount = descriptor.vertexCount as number;
  const lanes = descriptor.lanes as { name: string; type: string; count: number }[];
  const quantization = descriptor.quantization as {
    min: [number, number, number];
    extent: [number, number, number];
  };

  let offset = align8(8 + descriptorLength);
  let quantised: Uint16Array | null = null;
  let indices: Uint32Array | null = null;

  for (const lane of lanes) {
    const bytes = lane.count * (lane.type === 'u16' ? 2 : 4);
    if (offset + bytes > buffer.byteLength) {
      throw new MorphologyFormatError(`Lane "${lane.name}" runs past the end of the buffer.`);
    }
    const slice = buffer.slice(offset, offset + bytes);
    if (lane.name === 'position') quantised = new Uint16Array(slice);
    else if (lane.name === 'index') indices = new Uint32Array(slice);
    offset = align8(offset + bytes);
  }

  if (!quantised || !indices) throw new MorphologyFormatError('Missing a required lane.');
  if (quantised.length !== vertexCount * 3) {
    throw new MorphologyFormatError('Position lane does not match the vertex count.');
  }

  // Dequantise into source voxels.
  const positions = new Float32Array(vertexCount * 3);
  const { min, extent } = quantization;
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3] = min[0] + (quantised[i * 3] / 65535) * extent[0];
    positions[i * 3 + 1] = min[1] + (quantised[i * 3 + 1] / 65535) * extent[1];
    positions[i * 3 + 2] = min[2] + (quantised[i * 3 + 2] / 65535) * extent[2];
  }

  // Validated on read, not merely on write: a truncated file must fail loudly
  // rather than draw a neuron with wrong geometry.
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= vertexCount) {
      throw new MorphologyFormatError(`Index ${i} references a vertex outside the mesh.`);
    }
  }

  return {
    className: descriptor.class as string,
    lod: descriptor.lod as number,
    cellCount: descriptor.cellCount as number,
    vertexCount,
    triangleCount: descriptor.triangleCount as number,
    cells: descriptor.cells as MorphologyCell[],
    positions,
    indices,
    citation: descriptor.citation as string,
    source: descriptor.source as string,
    note: descriptor.note as string,
  };
}

/**
 * Turns a decoded class into renderer geometry.
 *
 * @param toRender Maps a source-voxel position into render space. The same
 *                 transform the soma use, passed in rather than recomputed, so
 *                 morphology and soma can never drift apart.
 */
export function morphologyGeometry(
  morphology: MorphologyClass,
  toRender: (x: number, y: number, z: number, out: Float32Array, at: number) => void,
): MeshGeometry {
  const { vertexCount, positions: source } = morphology;
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    toRender(source[i * 3], source[i * 3 + 1], source[i * 3 + 2], positions, i * 3);
  }

  const normals = computeSmoothNormals(positions, morphology.indices);

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertexCount; i++) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i * 3 + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }

  return {
    name: `hmi-morphology-${morphology.className}`,
    vertexCount,
    indexCount: morphology.indices.length,
    positions,
    normals,
    indices: morphology.indices,
    subMeshes: [
      {
        name: morphology.className,
        // Anatomical surface: translucent, so the soma inside stay visible.
        material: 'anatomical-surface',
        indexOffset: 0,
        indexCount: morphology.indices.length,
      },
    ],
    bones: [],
    boundsUm: { min, max },
    space: 'fish1-source',
    sourceAttribution: morphology.citation,
    license: 'Published open access with the Fish1 resource paper. Cite the paper for any use.',
  };
}

export const MORPHOLOGY_MANIFEST_URL = '/datasets/fish1-hmi/v1/morphology/manifest.json';

export async function loadMorphologyManifest(
  fetchImpl: typeof fetch = fetch,
): Promise<MorphologyManifest> {
  const response = await fetchImpl(MORPHOLOGY_MANIFEST_URL);
  if (!response.ok) {
    throw new MorphologyFormatError(`Morphology manifest returned ${response.status}.`);
  }
  return (await response.json()) as MorphologyManifest;
}

export async function loadMorphologyClass(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MorphologyClass> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new MorphologyFormatError(`Morphology class returned ${response.status}.`);
  }
  return decodeMorphology(await response.arrayBuffer());
}
