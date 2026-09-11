import { decodeHmiCircuit, type HmiCircuit, type HmiPopulations } from '@/core/hmi';
import { DataError } from '@/core/errors';

/**
 * Loads the HMI circuit artefacts.
 *
 * Failure here must be visible, not silent: if the circuit cannot be loaded the
 * application falls back to the baseline controller and says NEURAL MODEL
 * UNAVAILABLE. It must never quietly substitute a spatial guess for the
 * measured circuit.
 */

export interface HmiArtifacts {
  readonly circuit: HmiCircuit;
  readonly populations: HmiPopulations;
  readonly bytes: number;
}

export const HMI_MANIFEST_URL = '/datasets/fish1-hmi/manifest.json';

interface HmiManifest {
  readonly dataset: string;
  readonly version: string;
  readonly neuronCount: number;
  readonly edgeCount: number;
  readonly files: { readonly circuit: string; readonly populations: string };
}

export async function loadHmiArtifacts(
  fetchImpl: typeof fetch = fetch,
  manifestUrl = HMI_MANIFEST_URL,
): Promise<HmiArtifacts> {
  const manifestResponse = await fetchImpl(manifestUrl);
  if (!manifestResponse.ok) {
    throw new DataError({
      code: 'upstream_unavailable',
      message: `HMI manifest returned ${manifestResponse.status}.`,
      detail: 'The HMI circuit artefact could not be fetched. The neural model is unavailable.',
      retryable: true,
    });
  }
  const manifest = (await manifestResponse.json()) as HmiManifest;

  const [circuitResponse, populationsResponse] = await Promise.all([
    fetchImpl(manifest.files.circuit),
    fetchImpl(manifest.files.populations),
  ]);
  if (!circuitResponse.ok) {
    throw new DataError({
      code: 'upstream_unavailable',
      message: `HMI circuit returned ${circuitResponse.status}.`,
      detail: 'The HMI circuit binary could not be fetched. The neural model is unavailable.',
      retryable: true,
    });
  }
  if (!populationsResponse.ok) {
    throw new DataError({
      code: 'upstream_unavailable',
      message: `HMI populations returned ${populationsResponse.status}.`,
      detail:
        'The HMI population definitions could not be fetched. The neural model is unavailable.',
      retryable: true,
    });
  }

  const buffer = await circuitResponse.arrayBuffer();
  const circuit = decodeHmiCircuit(buffer);
  const populations = (await populationsResponse.json()) as HmiPopulations;

  // Refuse to run on a mismatched pair rather than silently simulating a
  // circuit whose population definitions belong to a different build.
  if (
    circuit.neuronCount !== manifest.neuronCount ||
    circuit.edgeCount !== manifest.edgeCount
  ) {
    throw new DataError({
      code: 'version_mismatch',
      message: `HMI manifest describes ${manifest.neuronCount} neurons and ${manifest.edgeCount} edges, but the circuit contains ${circuit.neuronCount} and ${circuit.edgeCount}.`,
      detail:
        'The HMI artefacts do not match each other. Refusing to run rather than simulate a circuit that is not the one described.',
      retryable: false,
    });
  }
  if (populations.version !== circuit.version) {
    throw new DataError({
      code: 'version_mismatch',
      message: `HMI populations are version ${populations.version}, circuit is ${circuit.version}.`,
      detail:
        'Population definitions belong to a different build of the circuit. Refusing to run.',
      retryable: false,
    });
  }

  return { circuit, populations, bytes: buffer.byteLength };
}

/** Population id to lore ids, in the shape the network builder expects. */
export function populationMap(populations: HmiPopulations): Map<string, readonly number[]> {
  const map = new Map<string, readonly number[]>();
  for (const population of populations.populations) {
    map.set(population.id, population.loreIds);
  }
  return map;
}
