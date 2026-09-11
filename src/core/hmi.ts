import type { EvidenceProvenance } from './provenance';

/**
 * The Fish1 Hindbrain Motion Integrator circuit.
 *
 * This module decodes the HMI1 container produced by
 * `pipeline/fish1/hmi/build_hmi.py`, and nothing else. It makes no model
 * assumptions and imputes nothing: an unlabelled neurotransmitter stays
 * unknown, an unclassified cell stays unclassified.
 *
 * WHAT IS MEASURED HERE
 *   soma positions        EM, source voxels
 *   synaptic contacts     manually traced, with per-contact EM coordinates
 *   neurotransmitter      only where the release publishes a label
 *
 * WHAT IS NOT
 *   hemisphere            derived by comparing y to a fitted midline
 *   morphological class   the release's own published classifier, which is a
 *                         morphological prediction, not a functional recording
 */

/* -------------------------------------------------------------------------- */
/* Classification                                                             */
/* -------------------------------------------------------------------------- */

/**
 * How a per-cell label was arrived at.
 *
 * The whole point of this enum is that the UI must never make a
 * morphology-predicted class look like a functionally recorded one.
 */
export type ClassificationProvenance =
  | 'unclassified'
  | 'morphology_predicted'
  | 'molecularly_measured'
  | 'functionally_measured'
  | 'connectivity_derived';

/** Numeric codes, shared with the Python writer. Order is part of the format. */
export const CLASSIFICATION_PROVENANCE_ORDER: readonly ClassificationProvenance[] = [
  'unclassified',
  'morphology_predicted',
  'molecularly_measured',
  'functionally_measured',
  'connectivity_derived',
] as const;

export interface ClassificationProvenanceDescriptor {
  readonly label: string;
  readonly description: string;
  /** The evidence class this maps onto for the global provenance system. */
  readonly evidence: EvidenceProvenance;
}

export const CLASSIFICATION_PROVENANCE_INFO: Record<
  ClassificationProvenance,
  ClassificationProvenanceDescriptor
> = {
  unclassified: {
    label: 'UNCLASSIFIED',
    description: 'The release publishes no label for this cell. Nothing has been inferred.',
    evidence: 'inferred',
  },
  morphology_predicted: {
    label: 'MORPHOLOGY PREDICTED',
    description:
      'The published morphological classifier for this cell. A prediction from reconstructed shape, not a functional recording.',
    evidence: 'predicted',
  },
  molecularly_measured: {
    label: 'MOLECULARLY MEASURED',
    description: 'Directly measured molecular identity (VGluT2 / Gad1b) from the release.',
    evidence: 'measured',
  },
  functionally_measured: {
    label: 'FUNCTIONALLY MEASURED',
    description:
      'Identified from recorded neural activity. No cell in this artefact carries this label.',
    evidence: 'measured',
  },
  connectivity_derived: {
    label: 'CONNECTIVITY DERIVED',
    description: 'Follows from how the reconstruction was traced, not from the cell itself.',
    evidence: 'derived',
  },
};

/**
 * Morphological classes, in the release's own vocabulary.
 *
 * These are the labels `HMI_analysis/src/zfish/labels.py` produces. We keep
 * their names rather than translating them into the functional vocabulary of a
 * different paper — see docs/HMI_CIRCUIT.md for how the two relate and why the
 * mapping is deliberately not asserted here.
 */
export type HmiClass =
  | 'unclassified'
  | 'I'
  | 'II'
  | 'I_or_II'
  | 'L-2'
  | 'R'
  | 'P'
  | 'F'
  | 'SPN_turning'
  | 'SPN_forward'
  | 'SPN_other'
  | 'other';

export const HMI_CLASS_ORDER: readonly HmiClass[] = [
  'unclassified',
  'I',
  'II',
  'I_or_II',
  'L-2',
  'R',
  'P',
  'F',
  'SPN_turning',
  'SPN_forward',
  'SPN_other',
  'other',
] as const;

export interface HmiClassDescriptor {
  readonly label: string;
  readonly sourceClassifier: string;
  readonly description: string;
}

export const HMI_CLASS_INFO: Record<HmiClass, HmiClassDescriptor> = {
  unclassified: {
    label: 'Unclassified',
    sourceClassifier: '—',
    description: 'No published classifier.',
  },
  I: {
    label: 'Class I',
    sourceClassifier: "'1'",
    description:
      'Ipsilaterally projecting. In this reconstruction every traced Class I to Class I connection stays within one hemisphere.',
  },
  II: {
    label: 'Class II',
    sourceClassifier: "'2' / 'contralateral axon'",
    description:
      'Axon crosses the midline. 92% of labelled Class II cells are Gad1b, i.e. inhibitory.',
  },
  I_or_II: {
    label: 'Class I or II',
    sourceClassifier: "'1 or 2'",
    description:
      'The release itself is undecided between Class I and Class II for these cells.',
  },
  'L-2': {
    label: 'L-2',
    sourceClassifier: "'L-2'",
    description: 'Predominantly contralateral and Gad1b (90% of labelled cells).',
  },
  R: { label: 'Class R', sourceClassifier: "'4'", description: 'Published classifier 4.' },
  P: {
    label: 'Class P',
    sourceClassifier: "'5' / '6' / '5 or 6'",
    description: 'Published classifier 5/6.',
  },
  F: { label: 'Class F', sourceClassifier: "'7'", description: 'Published classifier 7.' },
  SPN_turning: {
    label: 'Spinal projection (turning)',
    sourceClassifier: "'spn_turning_*'",
    description:
      'Descending spinal projection neuron associated with turning. The measured output of this circuit.',
  },
  SPN_forward: {
    label: 'Spinal projection (forward)',
    sourceClassifier: "'spn_forward_*'",
    description: 'Descending spinal projection neuron associated with forward swimming.',
  },
  SPN_other: {
    label: 'Spinal projection (other)',
    sourceClassifier: "'spn_*'",
    description: 'Descending spinal projection neuron, subtype not resolved.',
  },
  other: {
    label: 'Other',
    sourceClassifier: "'other'",
    description: "The release's own catch-all label.",
  },
};

/* -------------------------------------------------------------------------- */
/* Neurotransmitter                                                           */
/* -------------------------------------------------------------------------- */

export type HmiTransmitter = 'unknown' | 'excitatory' | 'inhibitory';

export const HMI_TRANSMITTER_ORDER: readonly HmiTransmitter[] = [
  'unknown',
  'excitatory',
  'inhibitory',
] as const;

/** Sign a transmitter contributes under Dale's law. Unknown is 0, never +1. */
export function transmitterSign(transmitter: HmiTransmitter): -1 | 0 | 1 {
  if (transmitter === 'excitatory') return 1;
  if (transmitter === 'inhibitory') return -1;
  return 0;
}

export type Hemisphere = 'left' | 'right';

/* -------------------------------------------------------------------------- */
/* Decoded circuit                                                            */
/* -------------------------------------------------------------------------- */

export interface HmiMidline {
  readonly axis: 'y';
  readonly voxels: number;
  readonly volumeCentreVoxels: number;
  readonly method: string;
  readonly provenance: EvidenceProvenance;
}

export interface HmiClassPurity {
  readonly members: number;
  readonly labelled: number;
  readonly majority: HmiTransmitter;
  /** Fraction of LABELLED members sharing the majority transmitter, 0..1. */
  readonly purity: number;
}

export interface HmiTracingSummary {
  readonly cellsWithTracedContacts: number;
  readonly unidentifiedContacts: number;
  readonly malformedContacts: number;
  readonly contactsDroppedNoSoma: number;
  readonly reconstructedCellsWithoutSoma: number;
  readonly note: string;
}

/**
 * Struct-of-arrays, because the simulation reads these every tick and a
 * per-neuron object would defeat the point.
 */
export interface HmiCircuit {
  readonly datasetId: string;
  readonly version: string;
  readonly neuronCount: number;
  readonly edgeCount: number;
  readonly synapseCount: number;
  readonly midline: HmiMidline;
  readonly citation: string;
  readonly source: string;

  /* per neuron */
  readonly loreIds: Uint32Array;
  readonly rootIds: BigUint64Array;
  /** Source voxel coordinates, xyz interleaved. */
  readonly positions: Int32Array;
  /** 0 = left, 1 = right. */
  readonly hemispheres: Uint8Array;
  readonly classIndices: Uint8Array;
  readonly classConfidence: Float32Array;
  readonly classProvenance: Uint8Array;
  readonly transmitters: Uint8Array;
  readonly transmitterProvenance: Uint8Array;
  readonly incomingSynapses: Uint32Array;
  readonly outgoingSynapses: Uint32Array;

  /* per edge */
  readonly edgePre: Uint32Array;
  readonly edgePost: Uint32Array;
  readonly edgeSynapses: Uint32Array;
  /** Mean EM position of the contacts making up each edge, xyz interleaved. */
  readonly edgePositions: Int32Array;

  readonly classCounts: Readonly<Record<string, number>>;
  readonly transmitterCounts: Readonly<Record<string, number>>;
  readonly classTransmitterPurity: Readonly<Record<string, HmiClassPurity>>;
  readonly networkLevels: Readonly<Record<string, number>>;
  readonly tracing: HmiTracingSummary;
}

export interface HmiPopulation {
  readonly id: string;
  readonly label: string;
  /** How membership was determined. Shown verbatim; never a bounding box. */
  readonly definition: string;
  readonly provenance: ClassificationProvenance;
  readonly loreIds: readonly number[];
}

export interface HmiPopulations {
  readonly datasetId: string;
  readonly version: string;
  readonly note: string;
  readonly midlineVoxels: number;
  readonly populations: readonly HmiPopulation[];
}

/* -------------------------------------------------------------------------- */
/* Decoding                                                                   */
/* -------------------------------------------------------------------------- */

const MAGIC = 0x484d4931; // 'HMI1' big-endian

export class HmiFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HmiFormatError';
  }
}

interface LaneSpec {
  readonly name: string;
  readonly type: 'u8' | 'u32' | 'i32' | 'f32' | 'u64';
  readonly count: number;
}

const LANE_BYTES: Record<LaneSpec['type'], number> = { u8: 1, u32: 4, i32: 4, f32: 4, u64: 8 };

function align8(value: number): number {
  const remainder = value % 8;
  return remainder === 0 ? value : value + (8 - remainder);
}

/**
 * Decodes an HMI1 container.
 *
 * Validated on read, not merely on write: a truncated or reordered file must
 * fail loudly here rather than produce a network with silently wrong edges.
 */
export function decodeHmiCircuit(buffer: ArrayBuffer): HmiCircuit {
  if (buffer.byteLength < 8)
    throw new HmiFormatError('Buffer is too small to be an HMI1 container.');
  const view = new DataView(buffer);
  if (view.getUint32(0, false) !== MAGIC) {
    throw new HmiFormatError('Not an HMI1 container: bad magic.');
  }
  const descriptorLength = view.getUint32(4, true);
  if (8 + descriptorLength > buffer.byteLength) {
    throw new HmiFormatError('Descriptor length exceeds the buffer.');
  }
  const descriptorText = new TextDecoder().decode(new Uint8Array(buffer, 8, descriptorLength));
  const descriptor = JSON.parse(descriptorText) as Record<string, unknown>;

  const neuronCount = descriptor.neuronCount as number;
  const edgeCount = descriptor.edgeCount as number;
  const lanes = descriptor.lanes as LaneSpec[];

  let offset = align8(8 + descriptorLength);
  const decoded = new Map<string, ArrayBufferView>();
  for (const lane of lanes) {
    const bytes = lane.count * LANE_BYTES[lane.type];
    if (offset + bytes > buffer.byteLength) {
      throw new HmiFormatError(`Lane "${lane.name}" runs past the end of the buffer.`);
    }
    const slice = buffer.slice(offset, offset + bytes);
    switch (lane.type) {
      case 'u8':
        decoded.set(lane.name, new Uint8Array(slice));
        break;
      case 'u32':
        decoded.set(lane.name, new Uint32Array(slice));
        break;
      case 'i32':
        decoded.set(lane.name, new Int32Array(slice));
        break;
      case 'f32':
        decoded.set(lane.name, new Float32Array(slice));
        break;
      case 'u64':
        decoded.set(lane.name, new BigUint64Array(slice));
        break;
    }
    offset = align8(offset + bytes);
  }

  const lane = <T extends ArrayBufferView>(name: string): T => {
    const value = decoded.get(name);
    if (!value) throw new HmiFormatError(`Missing lane "${name}".`);
    return value as T;
  };

  const edgePre = lane<Uint32Array>('edgePre');
  const edgePost = lane<Uint32Array>('edgePost');
  for (let i = 0; i < edgeCount; i++) {
    if (edgePre[i] >= neuronCount || edgePost[i] >= neuronCount) {
      throw new HmiFormatError(`Edge ${i} references a neuron outside the index.`);
    }
  }

  return {
    datasetId: descriptor.dataset as string,
    version: descriptor.version as string,
    neuronCount,
    edgeCount,
    synapseCount: descriptor.synapseCount as number,
    midline: descriptor.midline as HmiMidline,
    citation: descriptor.citation as string,
    source: descriptor.source as string,
    loreIds: lane<Uint32Array>('loreId'),
    rootIds: lane<BigUint64Array>('rootId'),
    positions: lane<Int32Array>('position'),
    hemispheres: lane<Uint8Array>('hemisphere'),
    classIndices: lane<Uint8Array>('classIndex'),
    classConfidence: lane<Float32Array>('classConfidence'),
    classProvenance: lane<Uint8Array>('classProvenance'),
    transmitters: lane<Uint8Array>('transmitter'),
    transmitterProvenance: lane<Uint8Array>('transmitterProvenance'),
    incomingSynapses: lane<Uint32Array>('incomingSynapses'),
    outgoingSynapses: lane<Uint32Array>('outgoingSynapses'),
    edgePre,
    edgePost,
    edgeSynapses: lane<Uint32Array>('edgeSynapses'),
    edgePositions: lane<Int32Array>('edgePosition'),
    classCounts: (descriptor.classCounts ?? {}) as Record<string, number>,
    transmitterCounts: (descriptor.transmitterCounts ?? {}) as Record<string, number>,
    classTransmitterPurity: (descriptor.classTransmitterPurity ?? {}) as Record<
      string,
      HmiClassPurity
    >,
    networkLevels: (descriptor.networkLevels ?? {}) as Record<string, number>,
    tracing: descriptor.tracing as HmiTracingSummary,
  };
}

/* -------------------------------------------------------------------------- */
/* Accessors                                                                  */
/* -------------------------------------------------------------------------- */

export function neuronClass(circuit: HmiCircuit, index: number): HmiClass {
  return HMI_CLASS_ORDER[circuit.classIndices[index]] ?? 'unclassified';
}

export function neuronTransmitter(circuit: HmiCircuit, index: number): HmiTransmitter {
  return HMI_TRANSMITTER_ORDER[circuit.transmitters[index]] ?? 'unknown';
}

export function neuronClassProvenance(
  circuit: HmiCircuit,
  index: number,
): ClassificationProvenance {
  return CLASSIFICATION_PROVENANCE_ORDER[circuit.classProvenance[index]] ?? 'unclassified';
}

export function neuronTransmitterProvenance(
  circuit: HmiCircuit,
  index: number,
): ClassificationProvenance {
  return (
    CLASSIFICATION_PROVENANCE_ORDER[circuit.transmitterProvenance[index]] ?? 'unclassified'
  );
}

export function neuronHemisphere(circuit: HmiCircuit, index: number): Hemisphere {
  return circuit.hemispheres[index] === 0 ? 'left' : 'right';
}

/** Index lookup by stable lore id. Built once, used by selection and populations. */
export function buildLoreIndex(circuit: HmiCircuit): Map<number, number> {
  const map = new Map<number, number>();
  for (let i = 0; i < circuit.neuronCount; i++) map.set(circuit.loreIds[i], i);
  return map;
}
