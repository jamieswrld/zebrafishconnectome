import { describe, expect, it } from 'vitest';
import {
  NEURON_INDEX_MAGIC,
  decodeNeuronIndex,
  encodeNeuronIndex,
  fnv1a32,
  peekNeuronIndexDescriptor,
} from '@/core/binary';
import { DataError } from '@/core/errors';
import { CELL_TYPE_CODE, NEURON_FLAG } from '@/core/types';
import type { VoxelSpace } from '@/core/coords';

/**
 * The binary format is the seam between the Python pipeline and the browser.
 * A silent mis-decode here produces a brain that looks plausible and is wrong,
 * so these tests are deliberately aggressive about corruption.
 */

const voxelSpace: VoxelSpace = { voxelSizeNm: [16, 16, 30], axisOrder: 'xyz' };

function sample(count = 4) {
  const positionsVoxel = new Int32Array(count * 3);
  const loreIds = new Uint32Array(count);
  const cellTypes = new Uint8Array(count);
  const regionIds = new Uint16Array(count);
  const flags = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    positionsVoxel[i * 3] = 1000 + i * 37;
    positionsVoxel[i * 3 + 1] = 2000 + i * 11;
    positionsVoxel[i * 3 + 2] = 300 + i;
    loreIds[i] = 170000 + i;
    cellTypes[i] = i % 2 === 0 ? CELL_TYPE_CODE.excitatory : CELL_TYPE_CODE.inhibitory;
    regionIds[i] = i % 3;
    flags[i] = NEURON_FLAG.ANNOTATED;
  }

  return encodeNeuronIndex({
    datasetId: 'fish1',
    origin: 'preprocessed-export',
    count,
    version: { materializationVersion: 574, label: 'mat 574' },
    voxelSpace,
    positionProvenance: 'measured',
    regions: [
      {
        id: 'r0',
        name: 'Region zero',
        assignmentProvenance: 'derived',
      },
    ],
    positionsVoxel,
    loreIds,
    cellTypes,
    regionIds,
    flags,
  });
}

describe('neuron index container', () => {
  it('round-trips a population without altering source coordinates', () => {
    const buffer = sample(4);
    const index = decodeNeuronIndex(buffer);

    expect(index.count).toBe(4);
    expect(index.datasetId).toBe('fish1');
    expect(index.version.materializationVersion).toBe(574);
    // Source voxel coordinates must survive verbatim.
    expect(Array.from(index.positionsVoxel.slice(0, 3))).toEqual([1000, 2000, 300]);
    expect(Array.from(index.loreIds)).toEqual([170000, 170001, 170002, 170003]);
    expect(index.cellTypes[0]).toBe(CELL_TYPE_CODE.excitatory);
    expect(index.cellTypes[1]).toBe(CELL_TYPE_CODE.inhibitory);
    expect(index.regions[0].name).toBe('Region zero');
  });

  it('derives micrometre positions from the declared voxel size', () => {
    const index = decodeNeuronIndex(sample(1));
    // 1000 voxels * 16 nm = 16000 nm = 16 um; 300 * 30 nm = 9 um.
    expect(index.positionsUm[0]).toBeCloseTo(16, 5);
    expect(index.positionsUm[1]).toBeCloseTo(32, 5);
    expect(index.positionsUm[2]).toBeCloseTo(9, 5);
  });

  it('produces a uniform, invertible render transform', () => {
    const index = decodeNeuronIndex(sample(8));
    expect(index.renderTransform.scale).toBeGreaterThan(0);
    expect(Number.isFinite(index.renderTransform.scale)).toBe(true);
    // A single scalar scale is what keeps on-screen distance proportional to
    // real micrometres.
    expect(typeof index.renderTransform.scale).toBe('number');
  });

  it('writes the magic header and an 8-byte aligned payload', () => {
    const buffer = sample(3);
    const bytes = new Uint8Array(buffer);
    expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])).toBe(
      NEURON_INDEX_MAGIC,
    );

    const descriptor = peekNeuronIndexDescriptor(buffer);
    for (const lane of descriptor.lanes) {
      expect(lane.byteOffset % 8).toBe(0);
    }
  });

  it('supports 64-bit root IDs without precision loss', () => {
    const rootIds = new BigUint64Array([864691128630286274n, 864691128630286275n]);
    const buffer = encodeNeuronIndex({
      datasetId: 'fish1',
      origin: 'preprocessed-export',
      count: 2,
      version: { materializationVersion: 574, label: 'mat 574' },
      voxelSpace,
      positionProvenance: 'measured',
      regions: [],
      positionsVoxel: new Int32Array([1, 2, 3, 4, 5, 6]),
      loreIds: new Uint32Array([10, 11]),
      cellTypes: new Uint8Array([1, 2]),
      rootIds,
    });
    const index = decodeNeuronIndex(buffer);
    expect(index.rootIds?.[0]).toBe(864691128630286274n);
    expect(index.rootIds?.[1]).toBe(864691128630286275n);
  });

  it('rejects a bad magic value', () => {
    const buffer = sample(2);
    new Uint8Array(buffer)[0] = 0x58;
    expect(() => decodeNeuronIndex(buffer)).toThrow(DataError);
    expect(() => decodeNeuronIndex(buffer)).toThrow(/magic/i);
  });

  it('rejects a truncated file rather than decoding garbage', () => {
    const buffer = sample(6);
    const truncated = buffer.slice(0, buffer.byteLength - 40);
    expect(() => decodeNeuronIndex(truncated)).toThrow(DataError);
  });

  it('rejects a count that disagrees with the lane lengths', () => {
    const buffer = sample(4);
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const jsonLength = view.getUint32(4, true);
    const json = new TextDecoder().decode(bytes.subarray(8, 8 + jsonLength));
    // Same digit count, so the descriptor length is unchanged.
    const tampered = json.replace('"count":4', '"count":9');
    expect(tampered).not.toBe(json);
    new Uint8Array(buffer, 8, jsonLength).set(new TextEncoder().encode(tampered));
    expect(() => decodeNeuronIndex(buffer)).toThrow(/bytes declared|required for/i);
  });

  it('rejects an unsupported format version', () => {
    const buffer = sample(2);
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const jsonLength = view.getUint32(4, true);
    const json = new TextDecoder().decode(bytes.subarray(8, 8 + jsonLength));
    const tampered = json.replace('"formatVersion":1', '"formatVersion":9');
    new Uint8Array(buffer, 8, jsonLength).set(new TextEncoder().encode(tampered));
    expect(() => decodeNeuronIndex(buffer)).toThrow(/not supported by this build/i);
  });

  it('refuses to encode a lane whose length disagrees with the count', () => {
    expect(() =>
      encodeNeuronIndex({
        datasetId: 'x',
        origin: 'development-sample',
        count: 3,
        version: { materializationVersion: null, label: 'test' },
        voxelSpace,
        positionProvenance: 'simulated',
        regions: [],
        positionsVoxel: new Int32Array(6), // needs 9
        loreIds: new Uint32Array(3),
        cellTypes: new Uint8Array(3),
      }),
    ).toThrow(/expected 36/);
  });

  it('handles an empty population', () => {
    const buffer = encodeNeuronIndex({
      datasetId: 'x',
      origin: 'development-sample',
      count: 0,
      version: { materializationVersion: null, label: 'empty' },
      voxelSpace,
      positionProvenance: 'simulated',
      regions: [],
      positionsVoxel: new Int32Array(0),
      loreIds: new Uint32Array(0),
      cellTypes: new Uint8Array(0),
    });
    const index = decodeNeuronIndex(buffer);
    expect(index.count).toBe(0);
    expect(index.renderTransform.scale).toBe(1);
  });
});

describe('fnv1a32', () => {
  it('matches the reference value for a known input', () => {
    // FNV-1a 32-bit of "hello" is 0x4F9F2CAB.
    expect(fnv1a32(new TextEncoder().encode('hello'))).toBe(0x4f9f2cab);
  });

  it('is stable and differs for differing input', () => {
    const a = fnv1a32(new Uint8Array([1, 2, 3]));
    const b = fnv1a32(new Uint8Array([1, 2, 4]));
    expect(a).toBe(fnv1a32(new Uint8Array([1, 2, 3])));
    expect(a).not.toBe(b);
  });
});
