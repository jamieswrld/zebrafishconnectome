import { decodeNeuronIndex } from '@/core/binary';
import { DataError, isApiErrorBody } from '@/core/errors';
import type { LoadProgress } from '@/core/adapter';
import type { NeuronIndex } from '@/core/types';

/**
 * Manifest + binary loading for preprocessed dataset exports.
 *
 * A manifest names version-addressed artefact paths; the binaries themselves
 * are served with a one-year immutable cache header (see next.config.mjs),
 * which is safe precisely because a new materialization produces a new path.
 * Navigating back to /brain must never re-download several megabytes.
 */

export interface DatasetManifest {
  readonly dataset: string;
  readonly version: string;
  readonly materializationVersion: number | null;
  readonly generatedAt: string;
  readonly neuronCount: number;
  readonly files: {
    readonly neuronIndex: string;
    /** Aggregated edge list, when the export includes published connectivity. */
    readonly connectivity?: string;
    readonly regions?: string;
  };
  readonly bytes?: Record<string, number>;
  readonly checksums?: Record<string, string>;
  readonly notes?: string;
}

export function manifestUrl(datasetId: string): string {
  return `/datasets/${datasetId}/manifest.json`;
}

export async function fetchManifest(
  datasetId: string,
  signal?: AbortSignal,
): Promise<DatasetManifest> {
  const url = manifestUrl(datasetId);
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (cause) {
    throw new DataError({
      code: 'upstream_unavailable',
      message: `Could not fetch the dataset manifest at ${url}.`,
      datasetId,
      cause,
    });
  }

  if (response.status === 404) {
    throw new DataError({
      code: 'not_found',
      message: `No export exists for dataset "${datasetId}".`,
      detail:
        'The whole-population index is produced by the Python pipeline. See README, section "Data pipeline".',
      datasetId,
    });
  }
  if (!response.ok) {
    throw new DataError({
      code: 'upstream_unavailable',
      message: `Manifest request failed with HTTP ${response.status}.`,
      datasetId,
    });
  }

  const manifest = (await response.json()) as DatasetManifest;
  if (manifest.dataset !== datasetId) {
    throw new DataError({
      code: 'dataset_mismatch',
      message: `Manifest at ${url} declares dataset "${manifest.dataset}", expected "${datasetId}".`,
      datasetId,
    });
  }
  return manifest;
}

/**
 * Streams a binary neuron index, reporting byte progress.
 *
 * Progress matters here: the index is the single largest download in the
 * application, and a boot sequence that reports real bytes is far better than
 * a timed animation pretending to be one.
 */
export async function fetchNeuronIndexBinary(
  datasetId: string,
  url: string,
  options: { signal?: AbortSignal; onProgress?: (p: LoadProgress) => void } = {},
): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch(url, { signal: options.signal });
  } catch (cause) {
    throw new DataError({
      code: 'upstream_unavailable',
      message: `Could not fetch the neuron index at ${url}.`,
      datasetId,
      cause,
    });
  }

  if (!response.ok) {
    throw new DataError({
      code: response.status === 404 ? 'not_found' : 'upstream_unavailable',
      message: `Neuron index request failed with HTTP ${response.status}.`,
      datasetId,
    });
  }

  const declared = Number(response.headers.get('content-length') || 0);
  const total = Number.isFinite(declared) && declared > 0 ? declared : undefined;

  if (!response.body) {
    return response.arrayBuffer();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    loaded += value.byteLength;
    options.onProgress?.({
      stage: 'downloading',
      fraction: total ? loaded / total : null,
      message: 'LOADING NEURON INDEX',
      bytesLoaded: loaded,
      bytesTotal: total,
    });
  }

  // Concatenate once at the end: an incremental copy per chunk would be
  // quadratic over a multi-megabyte download.
  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

export async function loadExportedNeuronIndex(
  datasetId: string,
  options: { signal?: AbortSignal; onProgress?: (p: LoadProgress) => void } = {},
): Promise<{ index: NeuronIndex; manifest: DatasetManifest; bytes: number }> {
  options.onProgress?.({
    stage: 'manifest',
    fraction: null,
    message: 'LOADING DATASET MANIFEST',
  });
  const manifest = await fetchManifest(datasetId, options.signal);

  const buffer = await fetchNeuronIndexBinary(datasetId, manifest.files.neuronIndex, options);

  options.onProgress?.({
    stage: 'decoding',
    fraction: null,
    message: 'DECODING NEURON INDEX',
    bytesLoaded: buffer.byteLength,
    bytesTotal: buffer.byteLength,
  });

  const index = decodeNeuronIndex(buffer);
  if (index.datasetId !== datasetId) {
    throw new DataError({
      code: 'dataset_mismatch',
      message: `Binary declares dataset "${index.datasetId}" but was served for "${datasetId}".`,
      datasetId,
    });
  }
  if (index.count !== manifest.neuronCount) {
    throw new DataError({
      code: 'version_mismatch',
      message: `Manifest promises ${manifest.neuronCount} neurons but the binary contains ${index.count}.`,
      datasetId,
    });
  }
  return { index, manifest, bytes: buffer.byteLength };
}

/** Fetches one of our own API routes and rethrows typed errors faithfully. */
export async function apiFetch<T>(url: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (cause) {
    throw new DataError({
      code: 'upstream_unavailable',
      message: `Request to ${url} failed.`,
      cause,
    });
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (isApiErrorBody(payload)) {
      throw new DataError({
        code: payload.error.code,
        message: payload.error.message,
        detail: payload.error.detail,
        datasetId: payload.error.datasetId,
        retryable: payload.error.retryable,
      });
    }
    throw new DataError({
      code: 'unknown',
      message: `Request to ${url} failed with HTTP ${response.status}.`,
    });
  }
  return payload as T;
}
