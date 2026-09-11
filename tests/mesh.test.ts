import { describe, expect, it } from 'vitest';
import { computeSmoothNormals, decodeMesh, encodeMesh, meshTriangleCount } from '@/core/mesh';
import { DataError } from '@/core/errors';
import type { SubMesh } from '@/core/mesh';

/**
 * The mesh container is the seam between the build-time body generator and the
 * GPU. A silently mis-decoded mesh would hand the renderer out-of-range indices
 * and read arbitrary memory, so the decoder validates rather than trusts.
 */

const subMeshes: SubMesh[] = [
  { name: 'body', material: 'skin', indexOffset: 0, indexCount: 6 },
];

function triangleQuad() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  return { positions, indices, normals: computeSmoothNormals(positions, indices) };
}

function sample() {
  const { positions, normals, indices } = triangleQuad();
  return encodeMesh({
    name: 'test-mesh',
    positions,
    normals,
    indices,
    boneIndices: new Uint8Array([0, 1, 0, 0, 0, 1, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0]),
    boneWeights: new Uint8Array([255, 0, 0, 0, 200, 55, 0, 0, 128, 127, 0, 0, 0, 255, 0, 0]),
    subMeshes,
    bones: [
      { name: 'head', parent: -1, headUm: [0, 0, 0], tailUm: [-1, 0, 0] },
      { name: 'spine_00', parent: 0, headUm: [-1, 0, 0], tailUm: [-2, 0, 0] },
      { name: 'spine_01', parent: 1, headUm: [-2, 0, 0], tailUm: [-3, 0, 0] },
    ],
    space: 'body-rest',
    sourceAttribution: 'test',
    license: 'test',
  });
}

describe('mesh container', () => {
  it('round-trips geometry, rig and attribution', () => {
    const mesh = decodeMesh(sample());
    expect(mesh.name).toBe('test-mesh');
    expect(mesh.vertexCount).toBe(4);
    expect(mesh.indexCount).toBe(6);
    expect(meshTriangleCount(mesh)).toBe(2);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 0, 2, 3]);
    expect(mesh.bones).toHaveLength(3);
    expect(mesh.bones[1].parent).toBe(0);
    expect(mesh.subMeshes[0].material).toBe('skin');
    // Attribution has to survive, because it is what labels the body as modeled.
    expect(mesh.sourceAttribution).toBe('test');
    expect(mesh.space).toBe('body-rest');
  });

  it('preserves skinning lanes exactly', () => {
    const mesh = decodeMesh(sample());
    expect(Array.from(mesh.boneIndices!.slice(0, 4))).toEqual([0, 1, 0, 0]);
    expect(Array.from(mesh.boneWeights!.slice(4, 8))).toEqual([200, 55, 0, 0]);
  });

  it('computes unit-length normals', () => {
    const { positions, indices } = triangleQuad();
    const normals = computeSmoothNormals(positions, indices);
    for (let i = 0; i < normals.length; i += 3) {
      const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
      expect(len).toBeCloseTo(1, 5);
    }
    // A quad in the z=0 plane wound counter-clockwise faces +z.
    expect(normals[2]).toBeCloseTo(1, 5);
  });

  it('aligns every lane for zero-copy views', () => {
    const buffer = sample();
    const view = new DataView(buffer);
    const jsonLength = view.getUint32(4, true);
    const descriptor = JSON.parse(
      new TextDecoder().decode(new Uint8Array(buffer, 8, jsonLength)),
    );
    for (const lane of descriptor.lanes) {
      expect(lane.byteOffset % 8).toBe(0);
    }
  });

  it('refuses an index that points past the vertex array', () => {
    const { positions, normals } = triangleQuad();
    expect(() =>
      encodeMesh({
        name: 'bad',
        positions,
        normals,
        // Vertex 9 does not exist.
        indices: new Uint32Array([0, 1, 9]),
        subMeshes: [{ name: 'x', material: 'skin', indexOffset: 0, indexCount: 3 }],
        space: 'body-rest',
        sourceAttribution: 't',
        license: 't',
      }),
    ).toThrow(/exceeds vertex count/);
  });

  it('refuses a non-triangular index count', () => {
    const { positions, normals } = triangleQuad();
    expect(() =>
      encodeMesh({
        name: 'bad',
        positions,
        normals,
        indices: new Uint32Array([0, 1]),
        subMeshes,
        space: 'body-rest',
        sourceAttribution: 't',
        license: 't',
      }),
    ).toThrow(/multiple of 3/);
  });

  it('rejects a bad magic value', () => {
    const buffer = sample();
    new Uint8Array(buffer)[1] = 0x00;
    expect(() => decodeMesh(buffer)).toThrow(DataError);
  });

  it('rejects a truncated file', () => {
    const buffer = sample();
    expect(() => decodeMesh(buffer.slice(0, buffer.byteLength - 12))).toThrow(DataError);
  });

  it('rejects an unsupported format version', () => {
    const buffer = sample();
    const bytes = new Uint8Array(buffer);
    const jsonLength = new DataView(buffer).getUint32(4, true);
    const json = new TextDecoder().decode(bytes.subarray(8, 8 + jsonLength));
    const tampered = json.replace('"formatVersion":1', '"formatVersion":7');
    new Uint8Array(buffer, 8, jsonLength).set(new TextEncoder().encode(tampered));
    expect(() => decodeMesh(buffer)).toThrow(/not supported by this build/);
  });

  it('catches a tampered index on read, not just on write', () => {
    const buffer = sample();
    const bytes = new Uint8Array(buffer);
    const jsonLength = new DataView(buffer).getUint32(4, true);
    const descriptor = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jsonLength)));
    const indexLane = descriptor.lanes.find((l: { name: string }) => l.name === 'indices');
    // Corrupt the first index in place.
    new DataView(buffer).setUint32(indexLane.byteOffset, 99, true);
    expect(() => decodeMesh(buffer)).toThrow(/exceeds vertex count/);
  });
});
