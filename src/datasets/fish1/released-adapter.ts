import type { BrainDatasetAdapter, NeuronIndexOptions } from '@/core/adapter';
import { DataError } from '@/core/errors';
import { asLoreId, asRootId, type LoreId } from '@/core/ids';
import { voxelToMicrometres } from '@/core/coords';
import {
  cellTypeFromCode,
  TRAVERSAL_LIMITS,
  type ConnectionPartner,
  type ConnectionQuery,
  type ConnectionSet,
  type DatasetMetadata,
  type Neuron,
  type NeuronIndex,
  type SearchResult,
} from '@/core/types';
import { loadExportedNeuronIndex } from '../loader';
import {
  FISH1_CITATION,
  FISH1_PUBLISHED_COUNTS,
  FISH1_RELEASE_URL,
  FISH1_VOXEL_SPACE,
} from './constants';

/**
 * Fish1, from the PUBLISHED circuit-analysis packages. Real data, no token.
 *
 * The Fish1 release ships the HMI and TEN analysis archives alongside the
 * paper. Between them they contain a CAVE `somas` export (~30k soma with stable
 * lore IDs, molecular cell types, root IDs and voxel positions) and real
 * per-neuron synaptic partner lists. `pipeline/fish1/import_released.py` turns
 * those into our binary artefacts, so the application shows genuine Fish1
 * neurons out of the box, with no credentials at all.
 *
 * Everything this adapter returns is `measured`.
 *
 * Its limits are real and are surfaced rather than smoothed over:
 *
 *  - It covers the HMI analysis box, NOT the whole >180k population. The
 *    metadata says so, and `published` still reports the full-resource counts
 *    for context.
 *  - Connectivity was published only for the neurons in the TEN/DMV study. For
 *    any other neuron the honest answer is "no connectivity was published for
 *    this cell", which this adapter raises as `connectivity_unavailable` -
 *    never as an empty partner list. That distinction is the whole point.
 */

interface ConnectivityArtifact {
  readonly edges: ReadonlyArray<readonly [number, number, number]>;
  readonly analysedLoreIds: readonly number[];
  readonly note: string;
  readonly source: string;
}

interface ConnectivityIndex {
  /** lore id -> partners, split by direction. */
  readonly incoming: Map<number, Array<{ partner: number; synapses: number }>>;
  readonly outgoing: Map<number, Array<{ partner: number; synapses: number }>>;
  readonly analysed: Set<number>;
  readonly note: string;
}

export const FISH1_RELEASED_ID = 'fish1-released';

export class Fish1ReleasedAdapter implements BrainDatasetAdapter {
  readonly id = FISH1_RELEASED_ID;

  private index: NeuronIndex | null = null;
  private lookup: Map<number, number> | null = null;
  private connectivity: ConnectivityIndex | null = null;
  private connectivityPromise: Promise<ConnectivityIndex> | null = null;
  private connectivityUrl: string | null = null;

  async metadata(): Promise<DatasetMetadata> {
    return {
      id: this.id,
      title: 'Fish1 (published analysis)',
      organism: 'Larval zebrafish (Danio rerio), 7 dpf',
      description:
        'Real Fish1 soma and synaptic connectivity, taken from the HMI and TEN circuit-analysis packages published with the resource paper. Covers the HMI analysis region, not the whole brain. Structural only: no neural activity.',
      modality: ['structural'],
      origin: 'preprocessed-export',
      capabilities: {
        neuronIndex: true,
        neuronMetadata: true,
        connectivity: true,
        // Skeletons and synapse positions live behind the authenticated CAVE
        // services; switch to the `fish1` dataset with a token for those.
        skeletons: false,
        synapsePositions: false,
        regions: false,
        activity: false,
        search: true,
        downloads: false,
      },
      voxelSpace: FISH1_VOXEL_SPACE,
      published: FISH1_PUBLISHED_COUNTS,
      version: {
        materializationVersion: null,
        label: 'published circuit analysis',
      },
      citation: FISH1_CITATION,
      license:
        'Open access. Any work using this resource must cite the primary resource paper.',
      sourceUrl: FISH1_RELEASE_URL,
    };
  }

  async neuronIndex(options?: NeuronIndexOptions): Promise<NeuronIndex> {
    try {
      const { index, manifest } = await loadExportedNeuronIndex(this.id, {
        signal: options?.signal,
        onProgress: options?.onProgress,
      });
      this.index = index;
      this.lookup = new Map();
      for (let i = 0; i < index.count; i++) this.lookup.set(index.loreIds[i], i);
      this.connectivityUrl = manifest.files.connectivity ?? null;
      return index;
    } catch (e) {
      if (e instanceof DataError && e.code === 'not_found') {
        throw new DataError({
          code: 'not_found',
          message: 'The published Fish1 export is missing from this deployment.',
          detail:
            'Build it with: python pipeline/fish1/import_released.py — it downloads the published analysis archives and needs no credentials.',
          datasetId: this.id,
        });
      }
      throw e;
    }
  }

  private requireIndex(): NeuronIndex {
    if (!this.index || !this.lookup) {
      throw new DataError({
        code: 'not_found',
        message: 'The Fish1 population has not finished loading yet.',
        datasetId: this.id,
      });
    }
    return this.index;
  }

  async getNeuron(loreId: LoreId): Promise<Neuron> {
    const index = this.requireIndex();
    const i = this.lookup!.get(Number(loreId));
    if (i === undefined) {
      throw new DataError({
        code: 'not_found',
        message: `Lore ID ${loreId} is not present in this export.`,
        detail:
          'This export covers the HMI analysis region. The neuron may exist elsewhere in Fish1; querying it needs a CAVE token.',
        datasetId: this.id,
      });
    }

    const voxel: [number, number, number] = [
      index.positionsVoxel[i * 3],
      index.positionsVoxel[i * 3 + 1],
      index.positionsVoxel[i * 3 + 2],
    ];
    const rawRoot = index.rootIds?.[i];

    return {
      datasetId: this.id,
      loreId,
      root:
        rawRoot && rawRoot !== 0n
          ? {
              rootId: asRootId(rawRoot.toString()),
              // The published export does not state which materialization it
              // was taken at, so currency is genuinely unknown rather than
              // assumed current.
              materializationVersion: null,
              isLatest: null,
            }
          : null,
      cellType: cellTypeFromCode(index.cellTypes[i]),
      cellTypeRaw: RAW_CELL_TYPE[index.cellTypes[i]],
      positionVoxel: voxel,
      positionUm: voxelToMicrometres(voxel, index.voxelSpace),
      flags: index.flags[i],
      provenance: 'measured',
    };
  }

  private async loadConnectivity(): Promise<ConnectivityIndex> {
    if (this.connectivity) return this.connectivity;
    if (this.connectivityPromise) return this.connectivityPromise;

    const url = this.connectivityUrl;
    if (!url) {
      throw new DataError({
        code: 'connectivity_unavailable',
        message: 'This export does not include a connectivity artefact.',
        datasetId: this.id,
      });
    }

    this.connectivityPromise = (async () => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new DataError({
          code: 'connectivity_unavailable',
          message: `Connectivity artefact request failed with HTTP ${response.status}.`,
          datasetId: this.id,
        });
      }
      const raw = (await response.json()) as ConnectivityArtifact;

      const incoming = new Map<number, Array<{ partner: number; synapses: number }>>();
      const outgoing = new Map<number, Array<{ partner: number; synapses: number }>>();
      for (const [pre, post, synapses] of raw.edges) {
        let outList = outgoing.get(pre);
        if (!outList) outgoing.set(pre, (outList = []));
        outList.push({ partner: post, synapses });

        let inList = incoming.get(post);
        if (!inList) incoming.set(post, (inList = []));
        inList.push({ partner: pre, synapses });
      }
      // Rank once at load, so every later query is already strongest-first.
      for (const list of outgoing.values()) list.sort((a, b) => b.synapses - a.synapses);
      for (const list of incoming.values()) list.sort((a, b) => b.synapses - a.synapses);

      const built: ConnectivityIndex = {
        incoming,
        outgoing,
        analysed: new Set(raw.analysedLoreIds),
        note: raw.note,
      };
      this.connectivity = built;
      return built;
    })();

    try {
      return await this.connectivityPromise;
    } catch (e) {
      this.connectivityPromise = null;
      throw e;
    }
  }

  async getConnections(loreId: LoreId, query?: ConnectionQuery): Promise<ConnectionSet> {
    const index = this.requireIndex();
    const connectivity = await this.loadConnectivity();
    const id = Number(loreId);

    // The load-bearing distinction: this neuron was never part of the published
    // circuit analysis, so we have no information about it. Returning an empty
    // partner list here would assert it has no partners, which is false.
    if (!connectivity.analysed.has(id)) {
      throw new DataError({
        code: 'connectivity_unavailable',
        message: `No connectivity was published for lore ID ${loreId}.`,
        detail:
          'The released analysis covers the TEN/DMV circuit only. This is not a claim that the neuron has no partners — it means this export contains no information about them. A CAVE token enables whole-brain connectivity queries.',
        datasetId: this.id,
      });
    }

    const minSynapses = query?.minSynapses ?? 1;
    const topN = Math.min(query?.topN ?? 50, TRAVERSAL_LIMITS.maxPartnersPerHop);
    const direction = query?.direction ?? 'both';

    const partners: ConnectionPartner[] = [];
    const totals = {
      incomingSynapses: 0,
      outgoingSynapses: 0,
      incomingPartners: 0,
      outgoingPartners: 0,
      incomingExcitatory: 0,
      incomingInhibitory: 0,
      outgoingExcitatory: 0,
      outgoingInhibitory: 0,
    };
    let truncated = false;

    const collect = (dir: 'incoming' | 'outgoing') => {
      const list =
        (dir === 'incoming' ? connectivity.incoming : connectivity.outgoing).get(id) ?? [];
      for (const entry of list) {
        const partnerIndex = this.lookup!.get(entry.partner);
        const polarity =
          partnerIndex === undefined
            ? 'unknown'
            : cellTypeFromCode(index.cellTypes[partnerIndex]);
        if (dir === 'incoming') {
          totals.incomingSynapses += entry.synapses;
          totals.incomingPartners++;
          if (polarity === 'excitatory') totals.incomingExcitatory += entry.synapses;
          if (polarity === 'inhibitory') totals.incomingInhibitory += entry.synapses;
        } else {
          totals.outgoingSynapses += entry.synapses;
          totals.outgoingPartners++;
          if (polarity === 'excitatory') totals.outgoingExcitatory += entry.synapses;
          if (polarity === 'inhibitory') totals.outgoingInhibitory += entry.synapses;
        }
      }

      const filtered = list.filter((e) => e.synapses >= minSynapses);
      if (filtered.length > topN) truncated = true;
      for (const entry of filtered.slice(0, topN)) {
        const partnerIndex = this.lookup!.get(entry.partner);
        partners.push({
          loreId: asLoreId(entry.partner),
          // The published analysis is keyed by soma id; segmentation root IDs
          // for partners are not part of it.
          rootId: null,
          direction: dir,
          synapseCount: entry.synapses,
          partnerCellType:
            partnerIndex === undefined
              ? 'unknown'
              : cellTypeFromCode(index.cellTypes[partnerIndex]),
          depth: 1,
        });
      }
    };

    if (direction === 'incoming' || direction === 'both') collect('incoming');
    if (direction === 'outgoing' || direction === 'both') collect('outgoing');

    return {
      datasetId: this.id,
      loreId,
      rootId: null,
      version: { materializationVersion: null, label: 'published circuit analysis' },
      partners,
      totals,
      truncated,
      truncationReason: truncated
        ? `Showing the ${topN} strongest partners per direction.`
        : undefined,
      provenance: 'measured',
    };
  }

  async search(term: string): Promise<SearchResult[]> {
    const index = this.requireIndex();
    const trimmed = term.trim();
    if (!/^\d+$/.test(trimmed)) return [];

    const results: SearchResult[] = [];
    const exact = this.lookup!.get(Number(trimmed));
    if (exact !== undefined) {
      results.push(this.toResult(index, exact));
    }
    for (let i = 0; i < index.count && results.length < 20; i++) {
      if (i === exact) continue;
      if (String(index.loreIds[i]).startsWith(trimmed)) {
        results.push(this.toResult(index, i));
      }
    }
    return results;
  }

  private toResult(index: NeuronIndex, i: number): SearchResult {
    const cellType = cellTypeFromCode(index.cellTypes[i]);
    return {
      datasetId: this.id,
      loreId: asLoreId(index.loreIds[i]),
      label: String(index.loreIds[i]),
      sublabel: cellType === 'unknown' ? 'not molecularly annotated' : cellType,
      cellType,
      matchedOn: 'lore-id',
    };
  }
}

/** Dataset-native strings, preserved so the inspector can show them verbatim. */
const RAW_CELL_TYPE: Record<number, string | undefined> = {
  0: 'na',
  1: 'exc',
  2: 'inh',
};
