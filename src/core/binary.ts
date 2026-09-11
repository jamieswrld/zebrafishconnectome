import { DataError } from './errors';
import { computeRenderTransform, voxelToMicrometres, type VoxelSpace } from './coords';
import type { BrainRegion, DataOrigin, DatasetVersion, NeuronIndex } from './types';
import type { EvidenceProvenance } from './provenance';

/**
 * Binary container for a whole-brain neuron index.
 *
 * Layout
 *   [0..4)          magic "CLN1"
 *   [4..8)          uint32 JSON descriptor byte length
 *   [8..8+n)        UTF-8 JSON descriptor
 *   padding         to the next 8-byte boundary
 *   lane payloads   in descriptor order, each 8-byte aligned
 *
 * Why this shape:
 *  - One HTTP request for the entire population (no waterfall of lane files).
 *  - Self-describing: lanes can be added without a new decoder.
 *  - 8-byte alignment so every lane can be wrapped by a zero-copy TypedArray
 *    view over the response ArrayBuffer. Misalignment would force a copy of
 *    several megabytes on the main thread.
 *
 * Only SOURCE voxel coordinates are stored. Micrometre positions are derived at
 * load time from the dataset voxel size, so the published coordinate remains
 * the single source of truth and can never drift from the rendered one.
 */

export const NEURON_INDEX_MAGIC = 'CLN1';
export const NEURON_INDEX_FORMAT_VERSION = 1;

export type LaneType = 'int32' | 'uint32' | 'uint16' | 'uint8' | 'float32' | 'uint64';

const BYTES_PER_ELEMENT: Record<LaneType, number> = {
  int32: 4,
  uint32: 4,
  uint16: 2,
  uint8: 1,
  float32: 4,
  uint64: 8,
};

export interface LaneDescriptor {
  readonly name: string;
  readonly type: LaneType;
  /** Values per neuron (3 for interleaved xyz). */
  readonly components: number;
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface NeuronIndexDescriptor {
  readonly format: 'connectome-lab/neuron-index';
  readonly formatVersion: number;
  readonly datasetId: string;
  readonly origin: DataOrigin;
  readonly count: number;
  readonly version: DatasetVersion;
  readonly voxelSpace: VoxelSpace;
  readonly positionProvenance: EvidenceProvenance;
  readonly lanes: readonly LaneDescriptor[];
  readonly regions: readonly BrainRegion[];
  readonly checksum?: { algorithm: 'fnv1a32'; value: string };
}

/** Lanes the decoder requires; anything else is optional enrichment. */
const REQUIRED_LANES = ['positionsVoxel', 'loreIds', 'cellTypes'] as const;

function align8(n: number): number {
  return (n + 7) & ~7;
}

/** FNV-1a (32-bit). Fast enough to checksum a multi-megabyte payload. */
export function fnv1a32(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    // h *= 16777619, kept in 32-bit range without BigInt.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

export interface EncodeNeuronIndexInput {
  datasetId: string;
  origin: DataOrigin;
  count: number;
  version: DatasetVersion;
  voxelSpace: VoxelSpace;
  positionProvenance: EvidenceProvenance;
  regions: readonly BrainRegion[];
  positionsVoxel: Int32Array;
  loreIds: Uint32Array;
  cellTypes: Uint8Array;
  regionIds?: Uint16Array;
  flags?: Uint8Array;
  rootIds?: BigUint64Array;
}

/**
 * Serialises a population to the container format. Used by the pipeline and by
 * the synthetic generator, so both produce byte-identical structures and the
 * decoder is exercised by every path.
 */
export function encodeNeuronIndex(input: EncodeNeuronIndexInput): ArrayBuffer {
  const { count } = input;

  const sources: Array<{
    name: string;
    type: LaneType;
    components: number;
    bytes: Uint8Array;
  }> = [];

  const push = (
    name: string,
    type: LaneType,
    components: number,
    array: ArrayBufferView | undefined,
  ) => {
    if (!array) return;
    const expected = count * components * BYTES_PER_ELEMENT[type];
    if (array.byteLength !== expected) {
      throw new DataError({
        code: 'malformed_binary',
        message: `Lane "${name}" has ${array.byteLength} bytes, expected ${expected} for ${count} neurons.`,
      });
    }
    sources.push({
      name,
      type,
      components,
      bytes: new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
    });
  };

  push('positionsVoxel', 'int32', 3, input.positionsVoxel);
  push('loreIds', 'uint32', 1, input.loreIds);
  push('cellTypes', 'uint8', 1, input.cellTypes);
  push('regionIds', 'uint16', 1, input.regionIds);
  push('flags', 'uint8', 1, input.flags);
  push('rootIds', 'uint64', 1, input.rootIds);

  // Two passes: the descriptor must contain byte offsets, but its own encoded
  // length shifts those offsets. Encode with placeholder offsets first to learn
  // the descriptor size, then re-encode with real offsets at that same size.
  const buildDescriptor = (lanes: LaneDescriptor[]): NeuronIndexDescriptor => ({
    format: 'connectome-lab/neuron-index',
    formatVersion: NEURON_INDEX_FORMAT_VERSION,
    datasetId: input.datasetId,
    origin: input.origin,
    count,
    version: input.version,
    voxelSpace: input.voxelSpace,
    positionProvenance: input.positionProvenance,
    lanes,
    regions: input.regions,
  });

  const encoder = new TextEncoder();
  const placeholderLanes: LaneDescriptor[] = sources.map((s) => ({
    name: s.name,
    type: s.type,
    components: s.components,
    // Wide placeholders so the digit count cannot grow on the real pass.
    byteOffset: 9999999999,
    byteLength: 9999999999,
  }));
  const probe = encoder.encode(JSON.stringify(buildDescriptor(placeholderLanes)));
  const dataStart = align8(8 + probe.byteLength);

  const lanes: LaneDescriptor[] = [];
  let cursor = dataStart;
  for (const s of sources) {
    cursor = align8(cursor);
    lanes.push({
      name: s.name,
      type: s.type,
      components: s.components,
      byteOffset: cursor,
      byteLength: s.bytes.byteLength,
    });
    cursor += s.bytes.byteLength;
  }
  const totalBytes = align8(cursor);

  const json = encoder.encode(JSON.stringify(buildDescriptor(lanes)));
  if (8 + json.byteLength > dataStart) {
    throw new DataError({
      code: 'malformed_binary',
      message: 'Descriptor grew between encoding passes.',
    });
  }

  const buffer = new ArrayBuffer(totalBytes);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  for (let i = 0; i < 4; i++) bytes[i] = NEURON_INDEX_MAGIC.charCodeAt(i);
  view.setUint32(4, json.byteLength, true);
  bytes.set(json, 8);
  for (const [i, lane] of lanes.entries()) {
    bytes.set(sources[i].bytes, lane.byteOffset);
  }
  return buffer;
}

/**
 * Decodes a container into zero-copy views plus derived micrometre positions.
 *
 * Validates aggressively: a silently mis-decoded index would produce a brain
 * that looks plausible and is wrong, which is the worst possible failure for
 * this application.
 */
export function decodeNeuronIndex(buffer: ArrayBuffer): NeuronIndex {
  if (buffer.byteLength < 8) {
    throw new DataError({
      code: 'malformed_binary',
      message: 'Neuron index is shorter than its header.',
    });
  }
  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== NEURON_INDEX_MAGIC) {
    throw new DataError({
      code: 'malformed_binary',
      message: `Bad magic "${magic}"; expected "${NEURON_INDEX_MAGIC}".`,
    });
  }

  const view = new DataView(buffer);
  const jsonLength = view.getUint32(4, true);
  if (8 + jsonLength > buffer.byteLength) {
    throw new DataError({
      code: 'malformed_binary',
      message: 'Descriptor length exceeds file size.',
    });
  }

  let descriptor: NeuronIndexDescriptor;
  try {
    descriptor = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jsonLength)));
  } catch (cause) {
    throw new DataError({
      code: 'malformed_binary',
      message: 'Descriptor is not valid JSON.',
      cause,
    });
  }

  if (descriptor.format !== 'connectome-lab/neuron-index') {
    throw new DataError({
      code: 'malformed_binary',
      message: `Unknown container format "${descriptor.format}".`,
    });
  }
  if (descriptor.formatVersion !== NEURON_INDEX_FORMAT_VERSION) {
    throw new DataError({
      code: 'version_mismatch',
      message: `Neuron index format v${descriptor.formatVersion} is not supported by this build (expects v${NEURON_INDEX_FORMAT_VERSION}).`,
    });
  }

  const { count } = descriptor;
  if (!Number.isInteger(count) || count < 0) {
    throw new DataError({
      code: 'malformed_binary',
      message: `Invalid neuron count ${count}.`,
    });
  }

  const laneByName = new Map(descriptor.lanes.map((l) => [l.name, l]));
  for (const required of REQUIRED_LANES) {
    if (!laneByName.has(required)) {
      throw new DataError({
        code: 'malformed_binary',
        message: `Neuron index is missing required lane "${required}".`,
      });
    }
  }

  for (const lane of descriptor.lanes) {
    const expected = count * lane.components * BYTES_PER_ELEMENT[lane.type];
    if (lane.byteLength !== expected) {
      throw new DataError({
        code: 'malformed_binary',
        message: `Lane "${lane.name}": ${lane.byteLength} bytes declared, ${expected} required for ${count} neurons.`,
      });
    }
    if (lane.byteOffset + lane.byteLength > buffer.byteLength) {
      throw new DataError({
        code: 'malformed_binary',
        message: `Lane "${lane.name}" extends past the end of the file.`,
      });
    }
    if (lane.byteOffset % BYTES_PER_ELEMENT[lane.type] !== 0) {
      throw new DataError({
        code: 'malformed_binary',
        message: `Lane "${lane.name}" is misaligned for type ${lane.type}.`,
      });
    }
  }

  const laneView = <T>(
    name: string,
    ctor: new (b: ArrayBuffer, o: number, l: number) => T,
  ): T | undefined => {
    const lane = laneByName.get(name);
    if (!lane) return undefined;
    return new ctor(buffer, lane.byteOffset, count * lane.components);
  };

  const positionsVoxel = laneView('positionsVoxel', Int32Array)!;
  const loreIds = laneView('loreIds', Uint32Array)!;
  const cellTypes = laneView('cellTypes', Uint8Array)!;
  const regionIds = laneView('regionIds', Uint16Array) ?? new Uint16Array(count).fill(0xffff);
  const flags = laneView('flags', Uint8Array) ?? new Uint8Array(count);
  const rootIds = laneView('rootIds', BigUint64Array);

  // Derive physical positions from the published voxel coordinates. This is the
  // only place the conversion happens, so voxel and micrometre values can never
  // disagree.
  const positionsUm = new Float32Array(count * 3);
  const { voxelSpace } = descriptor;
  let invalid = 0;
  for (let i = 0; i < count; i++) {
    const um = voxelToMicrometres(
      [positionsVoxel[i * 3], positionsVoxel[i * 3 + 1], positionsVoxel[i * 3 + 2]],
      voxelSpace,
    );
    if (!Number.isFinite(um[0]) || !Number.isFinite(um[1]) || !Number.isFinite(um[2])) {
      invalid++;
    }
    positionsUm[i * 3] = um[0];
    positionsUm[i * 3 + 1] = um[1];
    positionsUm[i * 3 + 2] = um[2];
  }
  if (invalid > 0) {
    throw new DataError({
      code: 'malformed_binary',
      message: `${invalid} neuron positions are not finite after voxel conversion.`,
    });
  }

  return {
    datasetId: descriptor.datasetId,
    origin: descriptor.origin,
    version: descriptor.version,
    count,
    positionsUm,
    positionsVoxel,
    loreIds,
    cellTypes,
    regionIds,
    flags,
    rootIds,
    regions: descriptor.regions ?? [],
    voxelSpace,
    renderTransform: computeRenderTransform(positionsUm, count),
    positionProvenance: descriptor.positionProvenance,
  };
}

/** Reads only the descriptor, e.g. to show counts before the payload lands. */
export function peekNeuronIndexDescriptor(buffer: ArrayBuffer): NeuronIndexDescriptor {
  const view = new DataView(buffer);
  const jsonLength = view.getUint32(4, true);
  return JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 8, jsonLength)),
  ) as NeuronIndexDescriptor;
}
