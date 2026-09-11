import type { LoreId } from './ids';
import type { ActivitySource } from './activity';
import type {
  ConnectionQuery,
  ConnectionSet,
  DatasetMetadata,
  Neuron,
  NeuronIndex,
  NeuronSkeleton,
  SearchResult,
} from './types';

/**
 * The single contract every brain dataset implements.
 *
 * Optional methods correspond to capabilities: an adapter that cannot supply
 * skeletons simply omits `getSkeleton`, and `metadata().capabilities` reports
 * `skeletons: false` so the UI disables the control instead of offering one
 * that fails.
 *
 * Implementations run in the browser and talk to our own API routes. They never
 * hold upstream credentials; see src/datasets/fish1/cave-client.ts for the
 * server half.
 */
export interface BrainDatasetAdapter {
  readonly id: string;

  metadata(): Promise<DatasetMetadata>;

  /**
   * The whole population, as TypedArrays. Expected to be a single binary
   * fetch; `onProgress` drives the boot sequence readout.
   */
  neuronIndex(options?: NeuronIndexOptions): Promise<NeuronIndex>;

  getNeuron(loreId: LoreId, signal?: AbortSignal): Promise<Neuron>;

  getConnections?(
    loreId: LoreId,
    query?: ConnectionQuery,
    signal?: AbortSignal,
  ): Promise<ConnectionSet>;

  getSkeleton?(loreId: LoreId, signal?: AbortSignal): Promise<NeuronSkeleton>;

  search?(term: string, signal?: AbortSignal): Promise<SearchResult[]>;

  /** Functional data, when this dataset has any. */
  activitySource?(): Promise<ActivitySource | null>;
}

export interface NeuronIndexOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: LoadProgress) => void;
}

export type LoadStage =
  | 'idle'
  | 'gpu-init'
  | 'manifest'
  | 'downloading'
  | 'decoding'
  | 'uploading'
  | 'ready'
  | 'error';

export interface LoadProgress {
  readonly stage: LoadStage;
  /** 0..1 within the current stage, or null when indeterminate. */
  readonly fraction: number | null;
  readonly message: string;
  readonly bytesLoaded?: number;
  readonly bytesTotal?: number;
}

/** Human-readable stage labels for the boot readout. */
export const LOAD_STAGE_LABEL: Record<LoadStage, string> = {
  idle: 'IDLE',
  'gpu-init': 'INITIALIZING GPU',
  manifest: 'LOADING DATASET MANIFEST',
  downloading: 'LOADING NEURON INDEX',
  decoding: 'DECODING NEURON INDEX',
  uploading: 'UPLOADING SOMA BUFFERS',
  ready: 'READY',
  error: 'FAILED',
};

/** Adapters are registered by id so datasets can be swapped from the URL. */
export type AdapterFactory = () => BrainDatasetAdapter;

const registry = new Map<string, AdapterFactory>();

export function registerAdapter(id: string, factory: AdapterFactory): void {
  registry.set(id, factory);
}

export function createAdapter(id: string): BrainDatasetAdapter | null {
  const factory = registry.get(id);
  return factory ? factory() : null;
}

export function registeredDatasetIds(): string[] {
  return [...registry.keys()];
}
