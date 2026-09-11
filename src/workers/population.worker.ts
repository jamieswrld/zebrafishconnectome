/// <reference lib="webworker" />
import { encodeNeuronIndex } from '@/core/binary';
import { generateSyntheticPopulation } from '@/datasets/synthetic/generator';
import type { DataOrigin, DatasetVersion } from '@/core/types';

/**
 * Generates synthetic populations off the main thread.
 *
 * Placing 200,000 neurons involves two Box-Muller draws each and takes long
 * enough to drop frames if run inline. The worker returns the same binary
 * container format that the real Fish1 export produces, so the decode path is
 * identical for synthetic and real data - there is exactly one loader.
 */

export interface GeneratePopulationRequest {
  readonly type: 'generate';
  readonly requestId: number;
  readonly count: number;
  readonly seed?: number;
  readonly datasetId: string;
  readonly origin: DataOrigin;
  readonly version: DatasetVersion;
}

export type PopulationWorkerRequest = GeneratePopulationRequest;

export interface GeneratePopulationResponse {
  readonly type: 'generated';
  readonly requestId: number;
  readonly buffer: ArrayBuffer;
  readonly generateMs: number;
  readonly encodeMs: number;
}

export interface PopulationWorkerError {
  readonly type: 'error';
  readonly requestId: number;
  readonly message: string;
}

export type PopulationWorkerResponse = GeneratePopulationResponse | PopulationWorkerError;

self.onmessage = (event: MessageEvent<PopulationWorkerRequest>) => {
  const request = event.data;
  if (request.type !== 'generate') return;

  try {
    const t0 = performance.now();
    const population = generateSyntheticPopulation({
      count: request.count,
      seed: request.seed,
    });
    const t1 = performance.now();

    const buffer = encodeNeuronIndex({
      datasetId: request.datasetId,
      origin: request.origin,
      count: population.count,
      version: request.version,
      voxelSpace: population.voxelSpace,
      // Synthetic coordinates are generator output, not observations.
      positionProvenance: 'simulated',
      regions: population.regions,
      positionsVoxel: population.positionsVoxel,
      loreIds: population.loreIds,
      cellTypes: population.cellTypes,
      regionIds: population.regionIds,
      flags: population.flags,
    });
    const t2 = performance.now();

    const response: GeneratePopulationResponse = {
      type: 'generated',
      requestId: request.requestId,
      buffer,
      generateMs: t1 - t0,
      encodeMs: t2 - t1,
    };
    // Transfer, not copy: a 200k population is several megabytes.
    (self as unknown as Worker).postMessage(response, [buffer]);
  } catch (e) {
    const response: PopulationWorkerError = {
      type: 'error',
      requestId: request.requestId,
      message: e instanceof Error ? e.message : String(e),
    };
    (self as unknown as Worker).postMessage(response);
  }
};
