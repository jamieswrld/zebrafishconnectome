import type { BrainDatasetAdapter, NeuronIndexOptions } from '@/core/adapter';
import { DataError } from '@/core/errors';
import type { LoreId } from '@/core/ids';
import type {
  ConnectionQuery,
  ConnectionSet,
  DatasetMetadata,
  Neuron,
  NeuronIndex,
  NeuronSkeleton,
  SearchResult,
} from '@/core/types';
import { apiFetch, loadExportedNeuronIndex } from '../loader';
import { FISH1_DATASET_ID } from './constants';

/**
 * Fish1 browser adapter.
 *
 * Holds no credentials. Per-neuron queries go to our own API routes, which do
 * the authenticated CAVE work server-side. The whole-population index is a
 * static, version-addressed binary produced by the Python pipeline - pulling
 * 180,000 soma through a live materialization query on every page load would be
 * both slow and abusive of a shared community service.
 */
export class Fish1Adapter implements BrainDatasetAdapter {
  readonly id = FISH1_DATASET_ID;

  private cachedMetadata: DatasetMetadata | null = null;

  async metadata(): Promise<DatasetMetadata> {
    if (this.cachedMetadata) return this.cachedMetadata;
    const metadata = await apiFetch<DatasetMetadata>(
      `/api/datasets/${FISH1_DATASET_ID}/metadata`,
    );
    this.cachedMetadata = metadata;
    return metadata;
  }

  async neuronIndex(options?: NeuronIndexOptions): Promise<NeuronIndex> {
    try {
      const { index } = await loadExportedNeuronIndex(FISH1_DATASET_ID, {
        signal: options?.signal,
        onProgress: options?.onProgress,
      });
      return index;
    } catch (e) {
      if (e instanceof DataError && e.code === 'not_found') {
        throw new DataError({
          code: 'not_found',
          message: 'No Fish1 neuron index has been exported yet.',
          detail:
            'Run the pipeline to produce it: python pipeline/fish1/export_neurons.py --out public/datasets/fish1. This requires a CAVE token. Until then, load the development sample or a synthetic benchmark.',
          datasetId: FISH1_DATASET_ID,
        });
      }
      throw e;
    }
  }

  async getNeuron(loreId: LoreId, signal?: AbortSignal): Promise<Neuron> {
    return apiFetch<Neuron>(
      `/api/neurons/${encodeURIComponent(loreId)}?dataset=${this.id}`,
      signal,
    );
  }

  async getConnections(
    loreId: LoreId,
    query?: ConnectionQuery,
    signal?: AbortSignal,
  ): Promise<ConnectionSet> {
    const params = new URLSearchParams({ dataset: this.id });
    if (query?.direction) params.set('direction', query.direction);
    if (query?.minSynapses !== undefined) params.set('minSynapses', String(query.minSynapses));
    if (query?.topN !== undefined) params.set('topN', String(query.topN));
    return apiFetch<ConnectionSet>(
      `/api/neurons/${encodeURIComponent(loreId)}/connections?${params}`,
      signal,
    );
  }

  async getSkeleton(loreId: LoreId, signal?: AbortSignal): Promise<NeuronSkeleton> {
    // The API returns plain arrays; rehydrate into TypedArrays so the renderer
    // and the rest of the app see one consistent shape.
    const raw = await apiFetch<{
      datasetId: string;
      loreId: LoreId;
      rootId: string;
      vertexCount: number;
      verticesUm: number[];
      parents: number[];
      radiiUm?: number[];
      compartments?: number[];
    }>(`/api/neurons/${encodeURIComponent(loreId)}/skeleton?dataset=${this.id}`, signal);

    return {
      datasetId: raw.datasetId,
      loreId: raw.loreId,
      rootId: raw.rootId as NeuronSkeleton['rootId'],
      vertexCount: raw.vertexCount,
      verticesUm: Float32Array.from(raw.verticesUm),
      parents: Int32Array.from(raw.parents),
      radiiUm: raw.radiiUm ? Float32Array.from(raw.radiiUm) : undefined,
      compartments: raw.compartments ? Uint8Array.from(raw.compartments) : undefined,
      provenance: 'measured',
    };
  }

  async search(term: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const params = new URLSearchParams({ dataset: this.id, q: term });
    const result = await apiFetch<{ results: SearchResult[] }>(`/api/search?${params}`, signal);
    return result.results;
  }
}
