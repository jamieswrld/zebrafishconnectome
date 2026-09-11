import { DataError } from './errors';

/**
 * Indexed triangle mesh geometry and its compact binary container (`MSH1`).
 *
 * The project renders through its own WebGPU/WebGL2 backends, so it needs its
 * own mesh primitive rather than pulling in a scene graph library. This is
 * deliberately the same shape of solution as the neuron index: a self-describing
 * lane-based container that the runtime can map to GPU buffers with no parsing
 * beyond a JSON header.
 *
 * glTF/GLB is fine as an AUTHORING format, but the runtime should never parse
 * it. `scripts/build-body.mjs` converts whatever we author into this format at
 * build time.
 *
 * Layout, identical in spirit to CLN1:
 *   [0..4)    magic "MSH1"
 *   [4..8)    uint32 LE JSON descriptor length
 *   [8..8+n)  UTF-8 JSON descriptor
 *   padding   to the next 8-byte boundary
 *   lanes     in descriptor order, each 8-byte aligned
 */

export const MESH_MAGIC = 'MSH1';
export const MESH_FORMAT_VERSION = 1;

export type MeshLaneType = 'float32' | 'uint32' | 'uint16' | 'uint8' | 'unorm8';

const BYTES_PER_ELEMENT: Record<MeshLaneType, number> = {
  float32: 4,
  uint32: 4,
  uint16: 2,
  uint8: 1,
  unorm8: 1,
};

export interface MeshLaneDescriptor {
  readonly name: string;
  readonly type: MeshLaneType;
  /** Values per element (3 for xyz, 4 for bone slots). */
  readonly components: number;
  /** Number of elements: vertexCount for attributes, indexCount for indices. */
  readonly count: number;
  readonly byteOffset: number;
  readonly byteLength: number;
}

/** One drawable range, so a single mesh can carry several materials. */
export interface SubMesh {
  readonly name: string;
  readonly material: MaterialId;
  readonly indexOffset: number;
  readonly indexCount: number;
}

export type MaterialId = 'skin' | 'eye' | 'anatomical-surface' | 'debug' | 'environment';

/** A rig bone. Bones deform skin; they are not an anatomical claim. */
export interface BoneDescriptor {
  readonly name: string;
  /** Index of the parent bone, or -1 for the root. */
  readonly parent: number;
  /** Rest-space head position (start of the bone), micrometres. */
  readonly headUm: readonly [number, number, number];
  /** Rest-space tail position (end of the bone), micrometres. */
  readonly tailUm: readonly [number, number, number];
}

export interface MeshDescriptor {
  readonly format: 'connectome-lab/mesh';
  readonly formatVersion: number;
  readonly name: string;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly lanes: readonly MeshLaneDescriptor[];
  readonly subMeshes: readonly SubMesh[];
  readonly bones: readonly BoneDescriptor[];
  readonly boundsUm: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  /** Coordinate space the vertices are expressed in. */
  readonly space: string;
  /** Where this geometry came from. Surfaced in the UI. */
  readonly sourceAttribution: string;
  readonly license: string;
}

export interface MeshGeometry {
  readonly name: string;
  readonly vertexCount: number;
  readonly indexCount: number;
  /** Interleaved xyz, length vertexCount * 3. */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
  readonly uvs?: Float32Array;
  /** Bone slot indices, 4 per vertex. */
  readonly boneIndices?: Uint8Array;
  /** Bone weights, 4 per vertex, normalised 0..255 summing to 255. */
  readonly boneWeights?: Uint8Array;
  readonly subMeshes: readonly SubMesh[];
  readonly bones: readonly BoneDescriptor[];
  readonly boundsUm: { min: [number, number, number]; max: [number, number, number] };
  readonly space: string;
  readonly sourceAttribution: string;
  readonly license: string;
}

function align8(n: number): number {
  return (n + 7) & ~7;
}

export interface EncodeMeshInput {
  name: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint16Array | Uint32Array;
  uvs?: Float32Array;
  boneIndices?: Uint8Array;
  boneWeights?: Uint8Array;
  subMeshes: readonly SubMesh[];
  bones?: readonly BoneDescriptor[];
  space: string;
  sourceAttribution: string;
  license: string;
}

export function encodeMesh(input: EncodeMeshInput): ArrayBuffer {
  const vertexCount = input.positions.length / 3;
  if (!Number.isInteger(vertexCount)) {
    throw new DataError({
      code: 'malformed_binary',
      message: `positions length ${input.positions.length} is not a multiple of 3.`,
    });
  }
  if (input.normals.length !== input.positions.length) {
    throw new DataError({
      code: 'malformed_binary',
      message: 'normals and positions must have the same length.',
    });
  }
  const indexCount = input.indices.length;
  if (indexCount % 3 !== 0) {
    throw new DataError({
      code: 'malformed_binary',
      message: `index count ${indexCount} is not a multiple of 3 (triangles only).`,
    });
  }

  // Every index must address a real vertex, or the GPU reads garbage.
  for (let i = 0; i < indexCount; i++) {
    if (input.indices[i] >= vertexCount) {
      throw new DataError({
        code: 'malformed_binary',
        message: `index ${input.indices[i]} at position ${i} exceeds vertex count ${vertexCount}.`,
      });
    }
  }

  const sources: Array<{
    name: string;
    type: MeshLaneType;
    components: number;
    count: number;
    bytes: Uint8Array;
  }> = [];

  const push = (
    name: string,
    type: MeshLaneType,
    components: number,
    count: number,
    array: ArrayBufferView | undefined,
  ) => {
    if (!array) return;
    const expected = count * components * BYTES_PER_ELEMENT[type];
    if (array.byteLength !== expected) {
      throw new DataError({
        code: 'malformed_binary',
        message: `Mesh lane "${name}" has ${array.byteLength} bytes, expected ${expected}.`,
      });
    }
    sources.push({
      name,
      type,
      components,
      count,
      bytes: new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
    });
  };

  push('positions', 'float32', 3, vertexCount, input.positions);
  push('normals', 'float32', 3, vertexCount, input.normals);
  push('uvs', 'float32', 2, vertexCount, input.uvs);
  push('boneIndices', 'uint8', 4, vertexCount, input.boneIndices);
  push('boneWeights', 'unorm8', 4, vertexCount, input.boneWeights);
  push(
    'indices',
    input.indices instanceof Uint16Array ? 'uint16' : 'uint32',
    1,
    indexCount,
    input.indices,
  );

  let min: [number, number, number] = [Infinity, Infinity, Infinity];
  let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertexCount; i++) {
    for (let a = 0; a < 3; a++) {
      const v = input.positions[i * 3 + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  if (vertexCount === 0) {
    min = [0, 0, 0];
    max = [0, 0, 0];
  }

  const build = (lanes: MeshLaneDescriptor[]): MeshDescriptor => ({
    format: 'connectome-lab/mesh',
    formatVersion: MESH_FORMAT_VERSION,
    name: input.name,
    vertexCount,
    indexCount,
    lanes,
    subMeshes: input.subMeshes,
    bones: input.bones ?? [],
    boundsUm: { min, max },
    space: input.space,
    sourceAttribution: input.sourceAttribution,
    license: input.license,
  });

  const encoder = new TextEncoder();
  const probe = encoder.encode(
    JSON.stringify(
      build(
        sources.map((s) => ({
          name: s.name,
          type: s.type,
          components: s.components,
          count: s.count,
          byteOffset: 9999999999,
          byteLength: 9999999999,
        })),
      ),
    ),
  );
  const dataStart = align8(8 + probe.byteLength);

  const lanes: MeshLaneDescriptor[] = [];
  let cursor = dataStart;
  for (const s of sources) {
    cursor = align8(cursor);
    lanes.push({
      name: s.name,
      type: s.type,
      components: s.components,
      count: s.count,
      byteOffset: cursor,
      byteLength: s.bytes.byteLength,
    });
    cursor += s.bytes.byteLength;
  }
  const total = align8(cursor);

  const json = encoder.encode(JSON.stringify(build(lanes)));
  if (8 + json.byteLength > dataStart) {
    throw new DataError({
      code: 'malformed_binary',
      message: 'Mesh descriptor grew between encoding passes.',
    });
  }

  const buffer = new ArrayBuffer(total);
  const bytes = new Uint8Array(buffer);
  new DataView(buffer).setUint32(4, json.byteLength, true);
  for (let i = 0; i < 4; i++) bytes[i] = MESH_MAGIC.charCodeAt(i);
  bytes.set(json, 8);
  for (const [i, lane] of lanes.entries()) bytes.set(sources[i].bytes, lane.byteOffset);
  return buffer;
}

export function decodeMesh(buffer: ArrayBuffer): MeshGeometry {
  if (buffer.byteLength < 8) {
    throw new DataError({
      code: 'malformed_binary',
      message: 'Mesh is shorter than its header.',
    });
  }
  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== MESH_MAGIC) {
    throw new DataError({
      code: 'malformed_binary',
      message: `Bad mesh magic "${magic}"; expected "${MESH_MAGIC}".`,
    });
  }

  const jsonLength = new DataView(buffer).getUint32(4, true);
  if (8 + jsonLength > buffer.byteLength) {
    throw new DataError({
      code: 'malformed_binary',
      message: 'Mesh descriptor length exceeds file size.',
    });
  }

  let descriptor: MeshDescriptor;
  try {
    descriptor = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jsonLength)));
  } catch (cause) {
    throw new DataError({
      code: 'malformed_binary',
      message: 'Mesh descriptor is not valid JSON.',
      cause,
    });
  }

  if (descriptor.format !== 'connectome-lab/mesh') {
    throw new DataError({
      code: 'malformed_binary',
      message: `Unknown mesh format "${descriptor.format}".`,
    });
  }
  if (descriptor.formatVersion !== MESH_FORMAT_VERSION) {
    throw new DataError({
      code: 'version_mismatch',
      message: `Mesh format v${descriptor.formatVersion} is not supported by this build (expects v${MESH_FORMAT_VERSION}).`,
    });
  }

  for (const lane of descriptor.lanes) {
    const expected = lane.count * lane.components * BYTES_PER_ELEMENT[lane.type];
    if (lane.byteLength !== expected) {
      throw new DataError({
        code: 'malformed_binary',
        message: `Mesh lane "${lane.name}" declares ${lane.byteLength} bytes, needs ${expected}.`,
      });
    }
    if (lane.byteOffset + lane.byteLength > buffer.byteLength) {
      throw new DataError({
        code: 'malformed_binary',
        message: `Mesh lane "${lane.name}" extends past the end of the file.`,
      });
    }
  }

  const lane = (name: string) => descriptor.lanes.find((l) => l.name === name);
  const view = <T>(
    name: string,
    ctor: new (b: ArrayBuffer, o: number, l: number) => T,
  ): T | undefined => {
    const l = lane(name);
    if (!l) return undefined;
    return new ctor(buffer, l.byteOffset, l.count * l.components);
  };

  const positions = view('positions', Float32Array);
  const normals = view('normals', Float32Array);
  const indexLane = lane('indices');
  if (!positions || !normals || !indexLane) {
    throw new DataError({
      code: 'malformed_binary',
      message: 'Mesh is missing positions, normals or indices.',
    });
  }
  const indices =
    indexLane.type === 'uint16'
      ? new Uint16Array(buffer, indexLane.byteOffset, indexLane.count)
      : new Uint32Array(buffer, indexLane.byteOffset, indexLane.count);

  // Re-validate index range on read: a truncated or tampered file that still
  // passes the length checks must not be handed to the GPU.
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= descriptor.vertexCount) {
      throw new DataError({
        code: 'malformed_binary',
        message: `Mesh index ${indices[i]} exceeds vertex count ${descriptor.vertexCount}.`,
      });
    }
  }

  return {
    name: descriptor.name,
    vertexCount: descriptor.vertexCount,
    indexCount: descriptor.indexCount,
    positions,
    normals,
    indices,
    uvs: view('uvs', Float32Array),
    boneIndices: view('boneIndices', Uint8Array),
    boneWeights: view('boneWeights', Uint8Array),
    subMeshes: descriptor.subMeshes,
    bones: descriptor.bones ?? [],
    boundsUm: {
      min: [...descriptor.boundsUm.min] as [number, number, number],
      max: [...descriptor.boundsUm.max] as [number, number, number],
    },
    space: descriptor.space,
    sourceAttribution: descriptor.sourceAttribution,
    license: descriptor.license,
  };
}

/** Recomputes smooth vertex normals by area-weighted face accumulation. */
export function computeSmoothNormals(
  positions: Float32Array,
  indices: Uint16Array | Uint32Array,
): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;

    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];

    // Cross product magnitude is twice the triangle area, so accumulating the
    // un-normalised normal weights large faces more, which is what we want.
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;

    for (const base of [a, b, c]) {
      normals[base] += nx;
      normals[base + 1] += ny;
      normals[base + 2] += nz;
    }
  }

  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (len > 1e-12) {
      normals[i] /= len;
      normals[i + 1] /= len;
      normals[i + 2] /= len;
    } else {
      normals[i + 1] = 1;
    }
  }
  return normals;
}

export function meshTriangleCount(mesh: Pick<MeshGeometry, 'indexCount'>): number {
  return mesh.indexCount / 3;
}

export function meshByteSize(mesh: MeshGeometry): number {
  return (
    mesh.positions.byteLength +
    mesh.normals.byteLength +
    mesh.indices.byteLength +
    (mesh.uvs?.byteLength ?? 0) +
    (mesh.boneIndices?.byteLength ?? 0) +
    (mesh.boneWeights?.byteLength ?? 0)
  );
}
