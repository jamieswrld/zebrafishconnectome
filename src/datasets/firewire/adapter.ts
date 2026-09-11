import type { BrainDatasetAdapter, NeuronIndexOptions } from '@/core/adapter';
import { DataError } from '@/core/errors';
import type { LoreId } from '@/core/ids';
import {
  NO_CAPABILITIES,
  type DatasetMetadata,
  type Neuron,
  type NeuronIndex,
} from '@/core/types';

/**
 * Fire&Wire adapter boundary - RESTRICTED, DELIBERATELY NOT IMPLEMENTED.
 *
 * Fire&Wire is scientifically the most valuable dataset for this application,
 * because connectivity and activity are aligned at the level of individual
 * cells IN THE SAME ANIMAL. That removes the correspondence problem that keeps
 * Fish1 and ZAPBench apart, and it is what a genuine
 * stimulus -> activity -> circuit -> behaviour story eventually needs.
 *
 * It is also not ours to take.
 *
 * This file therefore contains NO endpoints, NO bucket paths, NO credentials
 * and NO fetching code. Nothing in this repository downloads, mirrors,
 * redistributes or caches Fire&Wire data. The adapter exists so the shape of
 * the integration is settled, and so that anyone reading the codebase sees the
 * access status stated plainly rather than discovering a half-finished
 * scraper.
 *
 * To enable it, an authorised collaborator must implement this class against
 * whatever access route their authorisation actually grants.
 */
export class FireWireAdapter implements BrainDatasetAdapter {
  readonly id = 'firewire';

  async metadata(): Promise<DatasetMetadata> {
    return {
      id: this.id,
      title: 'Fish Fire&Wire',
      organism: 'Larval zebrafish (Danio rerio)',
      description:
        'Connectivity and neural activity measured from the same individual animal, aligned at single-cell resolution. Access is restricted.',
      modality: ['structural', 'functional'],
      origin: 'upstream-live',
      capabilities: NO_CAPABILITIES,
      voxelSpace: { voxelSizeNm: [1, 1, 1], axisOrder: 'xyz' },
      version: { materializationVersion: null, label: 'no access' },
      unavailable: {
        reason: 'requires-authorization',
        message:
          'This application has no authorization to access Fire&Wire data, and holds none of it.',
        remediation:
          'Obtain authorization from the dataset owners, then implement this adapter against the access route that authorization grants. Do not commit, mirror or cache any of the data.',
      },
    };
  }

  async neuronIndex(_options?: NeuronIndexOptions): Promise<NeuronIndex> {
    throw this.restricted();
  }

  async getNeuron(_loreId: LoreId): Promise<Neuron> {
    throw this.restricted();
  }

  private restricted(): DataError {
    return new DataError({
      code: 'auth_missing',
      message: 'Fire&Wire access is restricted and is not configured.',
      detail:
        'No Fire&Wire data is bundled with or reachable from this application. See docs/DATA_SOURCES.md.',
      datasetId: this.id,
    });
  }
}
