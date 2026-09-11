import { registerAdapter, createAdapter, type BrainDatasetAdapter } from '@/core/adapter';
import { Fish1Adapter } from './fish1/adapter';
import { Fish1ReleasedAdapter, FISH1_RELEASED_ID } from './fish1/released-adapter';
import { FireWireAdapter } from './firewire/adapter';
import { ZapBenchAdapter } from './zapbench/adapter';
import {
  BENCHMARK_SIZES,
  createBenchmarkAdapter,
  createDevSampleAdapter,
} from './synthetic/adapter';
import { FISH1_DATASET_ID } from './fish1/constants';

/**
 * Dataset registry.
 *
 * One place that knows which datasets exist, so a new fish is a registration
 * rather than a refactor. Dataset choice is driven by the URL
 * (`/brain?dataset=...`), which keeps research states shareable.
 */

/**
 * Real Fish1 data is the default. The published circuit-analysis export needs
 * no credentials, so a first-time visitor sees actual neurons rather than a
 * synthetic stand-in.
 */
export const DEFAULT_DATASET_ID = FISH1_RELEASED_ID;

export interface DatasetOption {
  readonly id: string;
  readonly label: string;
  /** Shown in the dataset picker under the label. */
  readonly note: string;
  readonly isRealBiology: boolean;
}

/** Datasets offered in the UI picker, in display order. */
export const DATASET_OPTIONS: readonly DatasetOption[] = [
  {
    id: FISH1_RELEASED_ID,
    label: 'FISH1 · PUBLISHED',
    note: 'Real Fish1 soma and synapses from the released circuit analysis. HMI region, no credentials needed.',
    isRealBiology: true,
  },
  {
    id: FISH1_DATASET_ID,
    label: 'FISH1 · FULL (CAVE)',
    note: 'Whole-brain structural connectome. Requires a CAVE token and a pipeline export.',
    isRealBiology: true,
  },
  {
    id: 'dev-sample',
    label: 'DEVELOPMENT SAMPLE',
    note: 'Synthetic stand-in with the real schema. Not biology.',
    isRealBiology: false,
  },
  {
    id: 'zapbench',
    label: 'ZAPBENCH',
    note: 'Functional recordings. Not ingested in this build.',
    isRealBiology: true,
  },
  {
    id: 'firewire',
    label: 'FIRE&WIRE',
    note: 'Restricted. No access configured.',
    isRealBiology: true,
  },
];

registerAdapter(FISH1_RELEASED_ID, () => new Fish1ReleasedAdapter());
registerAdapter(FISH1_DATASET_ID, () => new Fish1Adapter());
registerAdapter('zapbench', () => new ZapBenchAdapter());
registerAdapter('firewire', () => new FireWireAdapter());
registerAdapter('dev-sample', () => createDevSampleAdapter());

// Benchmark populations register under a size-suffixed id so the URL can name
// one directly, e.g. /brain?dataset=benchmark-200000.
for (const size of BENCHMARK_SIZES) {
  registerAdapter(`benchmark-${size}`, () => createBenchmarkAdapter(size));
}

export function resolveAdapter(datasetId: string | null | undefined): BrainDatasetAdapter {
  const id = datasetId?.trim() || DEFAULT_DATASET_ID;
  const adapter = createAdapter(id);
  if (adapter) return adapter;
  // Unknown ids fall back to the clearly-labelled sample rather than a blank
  // screen; the UI shows which dataset actually loaded.
  return createAdapter(DEFAULT_DATASET_ID)!;
}

export function isBenchmarkDataset(datasetId: string): boolean {
  return datasetId.startsWith('benchmark-');
}

export { BENCHMARK_SIZES };
