import type { EvidenceProvenance } from './provenance';
import type { LoreId, RootId, VersionedRootId } from './ids';
import type { Vec3, VoxelSpace, RenderTransform } from './coords';

/* -------------------------------------------------------------------------- */
/* Cell identity                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Neurotransmitter polarity, normalised across datasets.
 *
 * Fish1 publishes `cell_type` as "exc" | "inh" | "na" from genetic labelling
 * (vglut2a+ / gad1b+). "unknown" means the cell was not molecularly annotated -
 * it does NOT mean the cell is neither excitatory nor inhibitory.
 */
export type CellPolarity =
  'excitatory' | 'inhibitory' | 'modulatory' | 'non-neuronal' | 'unknown';

/**
 * Compact GPU-side encoding of {@link CellPolarity}. Stored as Uint8 in the
 * neuron index so filtering and colouring happen on the GPU without touching
 * JavaScript objects. These numbers are part of the binary format: appending is
 * allowed, renumbering is a breaking change.
 */
export const CELL_TYPE_CODE = {
  unknown: 0,
  excitatory: 1,
  inhibitory: 2,
  modulatory: 3,
  'non-neuronal': 4,
} as const satisfies Record<CellPolarity, number>;

export const CELL_TYPE_BY_CODE: readonly CellPolarity[] = [
  'unknown',
  'excitatory',
  'inhibitory',
  'modulatory',
  'non-neuronal',
];

export function cellTypeCode(p: CellPolarity): number {
  return CELL_TYPE_CODE[p];
}

export function cellTypeFromCode(code: number): CellPolarity {
  return CELL_TYPE_BY_CODE[code] ?? 'unknown';
}

/** Per-neuron bit flags packed into a Uint8 lane of the neuron index. */
export const NEURON_FLAG = {
  /** A skeleton is known to exist for this segment. */
  HAS_SKELETON: 1 << 0,
  /** The segment has at least one manual proofreading edit. */
  PROOFREAD: 1 << 1,
  /** The cell carries a molecular / cell-type annotation. */
  ANNOTATED: 1 << 2,
  /** A functional activity trace is linked to this cell. */
  HAS_ACTIVITY: 1 << 3,
  /** Position lies outside the documented volume bounds (data quality flag). */
  OUT_OF_BOUNDS: 1 << 4,
} as const;

export type NeuronFlag = (typeof NEURON_FLAG)[keyof typeof NEURON_FLAG];

/* -------------------------------------------------------------------------- */
/* Dataset metadata                                                           */
/* -------------------------------------------------------------------------- */

/**
 * How the bytes currently in the viewport were obtained. Surfaced prominently
 * in the UI: a user must never be unable to tell real data from a stand-in.
 */
export type DataOrigin =
  /** Live authenticated queries against the upstream service (e.g. CAVE). */
  | 'upstream-live'
  /** Preprocessed export of the real dataset, produced by our pipeline. */
  | 'preprocessed-export'
  /** Procedurally generated stand-in. Never real biology. */
  | 'development-sample'
  /** Procedurally generated purely to stress the renderer. */
  | 'synthetic-benchmark';

export interface DataOriginDescriptor {
  readonly badge: string;
  readonly isRealBiology: boolean;
  readonly description: string;
}

export const DATA_ORIGIN_INFO: Record<DataOrigin, DataOriginDescriptor> = {
  'upstream-live': {
    badge: 'LIVE',
    isRealBiology: true,
    description: 'Queried directly from the upstream connectome service.',
  },
  'preprocessed-export': {
    badge: 'EXPORT',
    isRealBiology: true,
    description: 'Pipeline export of the published dataset.',
  },
  'development-sample': {
    badge: 'DEVELOPMENT SAMPLE',
    isRealBiology: false,
    description:
      'Procedurally generated placeholder with the same schema as the real dataset. Contains no biological measurements.',
  },
  'synthetic-benchmark': {
    badge: 'SYNTHETIC BENCHMARK',
    isRealBiology: false,
    description:
      'Deterministic synthetic population generated to measure rendering performance. Contains no biological measurements.',
  },
};

/** What an adapter can actually do, so the UI never offers a dead control. */
export interface DatasetCapabilities {
  readonly neuronIndex: boolean;
  readonly neuronMetadata: boolean;
  readonly connectivity: boolean;
  readonly skeletons: boolean;
  readonly synapsePositions: boolean;
  readonly regions: boolean;
  readonly activity: boolean;
  readonly search: boolean;
  readonly downloads: boolean;
}

export const NO_CAPABILITIES: DatasetCapabilities = {
  neuronIndex: false,
  neuronMetadata: false,
  connectivity: false,
  skeletons: false,
  synapsePositions: false,
  regions: false,
  activity: false,
  search: false,
  downloads: false,
};

export interface DatasetCitation {
  readonly text: string;
  readonly doi?: string;
  readonly url?: string;
}

export interface DatasetMetadata {
  /** Stable slug used in URLs and the neuron key namespace. */
  readonly id: string;
  readonly title: string;
  readonly organism: string;
  readonly description: string;
  /** Structural connectome, functional recording, or both. */
  readonly modality: readonly ('structural' | 'functional')[];
  readonly origin: DataOrigin;
  readonly capabilities: DatasetCapabilities;
  readonly voxelSpace: VoxelSpace;
  /** Counts published by the source, for context in the UI. */
  readonly published?: {
    readonly somaCount?: number;
    readonly synapseCount?: number;
    readonly annotatedNeuronCount?: number;
  };
  /** Materialization / snapshot version the loaded artefacts correspond to. */
  readonly version: DatasetVersion;
  readonly citation?: DatasetCitation;
  readonly license?: string;
  readonly sourceUrl?: string;
  /** Set when the dataset cannot currently be used, with the reason why. */
  readonly unavailable?: DatasetUnavailable;
}

export interface DatasetVersion {
  /** CAVE materialization version, or null when not applicable. */
  readonly materializationVersion: number | null;
  /** Upstream segmentation / pcg table name, when applicable. */
  readonly segmentationTable?: string;
  /** When our artefacts were generated. */
  readonly generatedAt?: string;
  /** Free-form label shown in the UI, e.g. "mat 574". */
  readonly label: string;
}

export interface DatasetUnavailable {
  readonly reason:
    'requires-authorization' | 'not-configured' | 'not-implemented' | 'restricted';
  readonly message: string;
  /** Exact operator action required, if any. */
  readonly remediation?: string;
}

/* -------------------------------------------------------------------------- */
/* Neuron index (population scale, TypedArray backed)                         */
/* -------------------------------------------------------------------------- */

/**
 * The whole-population structure. Deliberately a struct-of-arrays of TypedArrays
 * rather than an array of objects: at 180k+ neurons an object graph costs tens
 * of megabytes and makes GPU upload impossible without a copy.
 *
 * Index `i` in every array refers to the same neuron. That index - not the lore
 * ID - is what the GPU uses, and what picking returns.
 */
export interface NeuronIndex {
  readonly datasetId: string;
  readonly origin: DataOrigin;
  readonly version: DatasetVersion;
  readonly count: number;

  /** Interleaved xyz in micrometres (physical space). length = count * 3. */
  readonly positionsUm: Float32Array;
  /**
   * Source voxel coordinates exactly as published, interleaved xyz.
   * Retained so the UI can always show the citable coordinate and so no
   * transform is ever lossy. length = count * 3.
   */
  readonly positionsVoxel: Int32Array;
  /** Lore IDs as unsigned 32-bit. Fish1 lore IDs comfortably fit. */
  readonly loreIds: Uint32Array;
  /** {@link CELL_TYPE_CODE} per neuron. */
  readonly cellTypes: Uint8Array;
  /** Region index into {@link NeuronIndex.regions}; 0xffff = unassigned. */
  readonly regionIds: Uint16Array;
  /** Bit field of {@link NEURON_FLAG}. */
  readonly flags: Uint8Array;

  /**
   * Root IDs are 64-bit and mutable, so they are NOT part of the hot path.
   * Present only when the export included them; consumers must treat them as
   * valid solely for `version`.
   */
  readonly rootIds?: BigUint64Array;

  /** Region table this index refers to. */
  readonly regions: readonly BrainRegion[];
  /** The native voxel grid, so voxel <-> micrometre stays reversible anywhere. */
  readonly voxelSpace: VoxelSpace;
  /** Presentation transform computed from `positionsUm`. */
  readonly renderTransform: RenderTransform;
  /** Provenance of the positional data. */
  readonly positionProvenance: EvidenceProvenance;
}

export const UNASSIGNED_REGION = 0xffff;

/* -------------------------------------------------------------------------- */
/* Regions                                                                    */
/* -------------------------------------------------------------------------- */

export interface BrainRegion {
  readonly id: string;
  readonly name: string;
  readonly acronym?: string;
  readonly parentId?: string;
  /** CSS colour. Optional: regions without an agreed colour render neutrally. */
  readonly color?: string;
  /**
   * How cells were assigned to this region. Crucial: a region derived from a
   * bounding box in the viewer is not an anatomical claim.
   */
  readonly assignmentProvenance: EvidenceProvenance;
  readonly assignmentMethod?: string;
}

/* -------------------------------------------------------------------------- */
/* Single neuron detail                                                       */
/* -------------------------------------------------------------------------- */

export interface Neuron {
  readonly datasetId: string;
  readonly loreId: LoreId;
  readonly root: VersionedRootId | null;
  readonly supervoxelId?: string;
  readonly cellType: CellPolarity;
  /** Raw dataset-native cell type string, kept verbatim (e.g. "exc", "na"). */
  readonly cellTypeRaw?: string;
  readonly positionVoxel: Vec3;
  readonly positionUm: Vec3;
  readonly regionId?: string;
  readonly flags: number;
  /** Adapter-specific extras, displayed as a raw key/value table. */
  readonly annotations?: Readonly<Record<string, string | number | null>>;
  readonly provenance: EvidenceProvenance;
}

/* -------------------------------------------------------------------------- */
/* Connectivity                                                               */
/* -------------------------------------------------------------------------- */

export type ConnectionDirection = 'incoming' | 'outgoing';

export interface ConnectionQuery {
  readonly direction?: ConnectionDirection | 'both';
  /** Drop partners below this synapse count. */
  readonly minSynapses?: number;
  /** Keep only the N strongest partners per direction. */
  readonly topN?: number;
  /** Restrict to these polarities. */
  readonly polarities?: readonly CellPolarity[];
  /**
   * Graph traversal depth. 1 = direct partners only. Depths above 1 expand
   * combinatorially and are guarded by {@link TRAVERSAL_LIMITS}.
   */
  readonly depth?: number;
  /** Include per-synapse positions (expensive). */
  readonly includeSynapsePositions?: boolean;
}

/**
 * A partner of the queried neuron, aggregated over all synapses between them.
 * One object per *partner*, not per synapse - 30M synapses must never be
 * materialised as objects.
 */
export interface ConnectionPartner {
  /** Stable identifier when the partner has a soma annotation. */
  readonly loreId: LoreId | null;
  /**
   * Segmentation ID, valid only for the stated version. Null for datasets that
   * have no segmentation graph (such as the synthetic generator).
   */
  readonly rootId: RootId | null;
  readonly direction: ConnectionDirection;
  readonly synapseCount: number;
  /** Counts by the source-provided synapse label. */
  readonly synapsesByPolarity?: Readonly<Partial<Record<CellPolarity, number>>>;
  readonly partnerCellType: CellPolarity;
  /** Hop count from the queried neuron. 1 for direct partners. */
  readonly depth: number;
  readonly positionUm?: Vec3;
}

/** Individual synapse positions, requested explicitly and capped. */
export interface SynapsePoint {
  readonly preRootId: RootId;
  readonly postRootId: RootId;
  readonly positionVoxel: Vec3;
  readonly polarity: CellPolarity;
}

export interface ConnectionSet {
  readonly datasetId: string;
  readonly loreId: LoreId;
  readonly rootId: RootId | null;
  readonly version: DatasetVersion;
  readonly partners: readonly ConnectionPartner[];
  /** Totals before topN / minSynapses filtering was applied. */
  readonly totals: ConnectionTotals;
  /** True when results were truncated by a limit; the UI must say so. */
  readonly truncated: boolean;
  readonly truncationReason?: string;
  readonly synapses?: readonly SynapsePoint[];
  readonly provenance: EvidenceProvenance;
}

export interface ConnectionTotals {
  readonly incomingSynapses: number;
  readonly outgoingSynapses: number;
  readonly incomingPartners: number;
  readonly outgoingPartners: number;
  readonly incomingExcitatory?: number;
  readonly incomingInhibitory?: number;
  readonly outgoingExcitatory?: number;
  readonly outgoingInhibitory?: number;
}

/**
 * Hard guards against graph explosion. A depth-3 traversal in a dense
 * connectome can touch a large fraction of the brain; we refuse rather than
 * hang the browser.
 */
export const TRAVERSAL_LIMITS = {
  maxDepth: 3,
  maxPartnersPerHop: 250,
  maxTotalNodes: 5000,
  maxSynapsePoints: 20000,
  /** Above this many expected nodes the UI warns before running. */
  warnNodeCount: 800,
} as const;

/* -------------------------------------------------------------------------- */
/* Morphology                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Skeleton in SWC-compatible form, held as TypedArrays. A single Fish1 neuron
 * can have thousands of vertices, and the local-circuit view may hold dozens of
 * neurons at once.
 */
export interface NeuronSkeleton {
  readonly datasetId: string;
  readonly loreId: LoreId;
  readonly rootId: RootId;
  readonly vertexCount: number;
  /** Interleaved xyz in micrometres. length = vertexCount * 3. */
  readonly verticesUm: Float32Array;
  /** Parent vertex index per vertex; -1 for roots. length = vertexCount. */
  readonly parents: Int32Array;
  /** Radius in micrometres per vertex, when the source provides it. */
  readonly radiiUm?: Float32Array;
  /** SWC structure identifier per vertex (0 undefined, 1 soma, 2 axon, ...). */
  readonly compartments?: Uint8Array;
  readonly provenance: EvidenceProvenance;
}

/* -------------------------------------------------------------------------- */
/* Search                                                                     */
/* -------------------------------------------------------------------------- */

export interface SearchResult {
  readonly datasetId: string;
  readonly loreId: LoreId;
  readonly label: string;
  readonly sublabel?: string;
  readonly cellType: CellPolarity;
  readonly matchedOn: 'lore-id' | 'root-id' | 'annotation' | 'region';
  readonly positionUm?: Vec3;
}

/* -------------------------------------------------------------------------- */
/* Downloads                                                                  */
/* -------------------------------------------------------------------------- */

export type DownloadFormat = 'neuron-json' | 'connectivity-csv' | 'skeleton-swc';

export interface DownloadDescriptor {
  readonly format: DownloadFormat;
  readonly label: string;
  readonly filename: string;
  readonly mimeType: string;
  /** False when the loaded dataset cannot produce this artefact. */
  readonly available: boolean;
  readonly unavailableReason?: string;
}
