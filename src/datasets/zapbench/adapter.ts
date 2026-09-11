import type { BrainDatasetAdapter, NeuronIndexOptions } from '@/core/adapter';
import { DataError } from '@/core/errors';
import type { LoreId } from '@/core/ids';
import type { ActivitySource } from '@/core/activity';
import {
  NO_CAPABILITIES,
  type DatasetMetadata,
  type Neuron,
  type NeuronIndex,
} from '@/core/types';

/**
 * ZAPBench adapter boundary (not yet implemented).
 *
 * ZAPBench is the Zebrafish Activity Prediction Benchmark: 4D light-sheet
 * recordings of over 70,000 neurons in a larval zebrafish brain under a range
 * of visual stimuli, published by Google Research with HHMI Janelia and
 * Harvard. It is FUNCTIONAL data - the opposite of Fish1, which is purely
 * structural.
 *
 *   paper  https://arxiv.org/abs/2503.02618
 *   code   https://github.com/google-research/zapbench
 *
 * The single most important constraint encoded here:
 *
 *   ZAPBench and Fish1 are DIFFERENT ANIMALS. There is no cell-level
 *   correspondence between them, and this application must never paint
 *   ZAPBench traces onto Fish1 soma. Any future mapping has to arrive as an
 *   explicit CellCorrespondence with `sameAnimal: false` and its own
 *   provenance, and the UI has to show it as a registration, not an identity.
 *
 * This file exists as a typed boundary so the functional-data path is designed
 * now and the work later is implementation, not redesign. It deliberately
 * reports no capabilities rather than pretending to have data.
 */
export class ZapBenchAdapter implements BrainDatasetAdapter {
  readonly id = 'zapbench';

  async metadata(): Promise<DatasetMetadata> {
    return {
      id: this.id,
      title: 'ZAPBench',
      organism: 'Larval zebrafish (Danio rerio)',
      description:
        'Whole-brain cellular-resolution calcium imaging of over 70,000 neurons under visual stimuli, published as a forecasting benchmark. Functional data only; a different animal from Fish1.',
      modality: ['functional'],
      origin: 'preprocessed-export',
      capabilities: NO_CAPABILITIES,
      voxelSpace: {
        // Left unstated rather than guessed. The real grid is read from the
        // dataset's own metadata when ingestion is implemented.
        voxelSizeNm: [1, 1, 1],
        axisOrder: 'xyz',
      },
      published: { somaCount: 70_000 },
      version: { materializationVersion: null, label: 'not ingested' },
      citation: {
        text: 'Immer, A., Lueckmann, J.-M., et al. (2025). ZAPBench: A Benchmark for Whole-Brain Activity Prediction in Zebrafish.',
        url: 'https://arxiv.org/abs/2503.02618',
      },
      sourceUrl: 'https://github.com/google-research/zapbench',
      unavailable: {
        reason: 'not-implemented',
        message: 'ZAPBench ingestion is not implemented in this build.',
        remediation:
          'Requires a pipeline stage to read the published volumes and trace matrices and emit an ActivitySource. See docs/DATA_SOURCES.md.',
      },
    };
  }

  async neuronIndex(_options?: NeuronIndexOptions): Promise<NeuronIndex> {
    throw new DataError({
      code: 'unsupported_operation',
      message: 'ZAPBench is not ingested in this build.',
      detail:
        'It contributes activity traces, not a structural soma index. See docs/DATA_SOURCES.md.',
      datasetId: this.id,
    });
  }

  async getNeuron(_loreId: LoreId): Promise<Neuron> {
    throw new DataError({
      code: 'unsupported_operation',
      message: 'ZAPBench is not ingested in this build.',
      datasetId: this.id,
    });
  }

  async activitySource(): Promise<ActivitySource | null> {
    return null;
  }
}
