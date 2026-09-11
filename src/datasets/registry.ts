import { registerAdapter, createAdapter, type BrainDatasetAdapter } from '@/core/adapter';
import { Fish1Adapter } from './fish1/adapter';
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

export const DEFAULT_DATASET_ID = 'dev-sample';

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
    id: FISH1_DATASET_ID,
    label: 'FISH1',
    note: 'Structural connectome. Requires a pipeline export and a CAVE token.',
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
