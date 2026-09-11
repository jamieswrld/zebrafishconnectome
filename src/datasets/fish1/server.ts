import { DataError } from '@/core/errors';
import { asLoreId, asRootId, classifyIdentifier, type LoreId } from '@/core/ids';
import { voxelToMicrometres } from '@/core/coords';
import { parseSwc } from '@/core/swc';
import {
  TRAVERSAL_LIMITS,
  type CellPolarity,
  type ConnectionPartner,
  type ConnectionSet,
  type ConnectionTotals,
  type DatasetMetadata,
  type DatasetVersion,
  type Neuron,
  type NeuronSkeleton,
  type SearchResult,
} from '@/core/types';
import {
  FISH1_CITATION,
  FISH1_DATASET_ID,
  FISH1_PUBLISHED_COUNTS,
  FISH1_RELEASE_URL,
  FISH1_TABLES,
  FISH1_VOXEL_SPACE,
  SOMA_COLUMNS,
  SYNAPSE_COLUMNS,
  SYNAPSE_TAG,
  mapFish1CellType,
} from './constants';
import {
  getSkeletonSwc,
  isCaveConfigured,
  isLatestRoots,
  queryTable,
  readBigId,
  readPosition,
  readCaveConfig,
  resolveVersion,
  type CaveConfig,
  type Row,
} from './cave-client';

/**
 * Fish1 server-side data service.
 *
 * Translates CAVE rows into the application's domain model. Runs only on the
 * server (it imports the credentialed client) and is consumed exclusively by
 * the /api route handlers.
 *
 * Everything returned from here is `measured`: these are published observations
 * from the Fish1 resource. Aggregations we compute over them (partner counts,
 * per-polarity totals) are marked `derived` where they are surfaced separately.
 */

/** Hard cap on synapse rows pulled for one neuron, to bound a single request. */
const MAX_SYNAPSE_ROWS = 20_000;

export async function fish1Metadata(): Promise<DatasetMetadata> {
  const config = readCaveConfig();
  const configured = isCaveConfigured(config);

  let version: DatasetVersion = {
    materializationVersion: null,
    segmentationTable: config.pcgTable,
    label: configured ? 'resolving...' : 'unavailable',
  };

  let unavailable: DatasetMetadata['unavailable'];
  if (!configured) {
    unavailable = {
      reason: 'not-configured',
      message: 'No CAVE token is configured, so Fish1 cannot be queried.',
      remediation: `Obtain a token at ${config.globalUrl}/sticky_auth/settings/tokens and set CAVE_TOKEN in .env.local.`,
    };
  } else {
    try {
      const resolved = await resolveVersion(config);
      version = {
        materializationVersion: resolved,
        segmentationTable: config.pcgTable,
        label: `mat ${resolved}`,
      };
    } catch (e) {
      unavailable = {
        reason: 'not-configured',
        message:
          e instanceof DataError ? e.message : 'Could not resolve a materialization version.',
        remediation: 'Verify CAVE_TOKEN and network access to the CAVE deployment.',
      };
    }
  }

  return {
    id: FISH1_DATASET_ID,
    title: 'Fish1',
    organism: 'Larval zebrafish (Danio rerio), 7 dpf',
    description:
      'Whole-brain CLEM structural connectome of a larval zebrafish, covering the brain and anterior spinal cord. Structural only: this dataset contains no neural activity.',
    modality: ['structural'],
    // Live CAVE queries when configured. The whole-population index still
    // requires a pipeline export; the /brain route reports that separately.
    origin: 'upstream-live',
    capabilities: {
      neuronIndex: false,
      neuronMetadata: configured,
      connectivity: configured,
      skeletons: configured,
      synapsePositions: configured,
      regions: false,
      activity: false,
      search: configured,
      downloads: configured,
    },
    voxelSpace: FISH1_VOXEL_SPACE,
    published: FISH1_PUBLISHED_COUNTS,
    version,
    citation: FISH1_CITATION,
    license: 'Open access. Any work using this resource must cite the primary resource paper.',
    sourceUrl: FISH1_RELEASE_URL,
    unavailable,
  };
}

function versionOf(config: CaveConfig, materialization: number): DatasetVersion {
  return {
    materializationVersion: materialization,
    segmentationTable: config.pcgTable,
    label: `mat ${materialization}`,
  };
}

/** Reads one soma row into the domain model. */
function somaRowToNeuron(row: Row, materialization: number, isLatest: boolean | null): Neuron {
  const position = readPosition(row, SOMA_COLUMNS.position);
  if (!position) {
    throw new DataError({
      code: 'upstream_unavailable',
      message: 'A soma row arrived without a usable position.',
      datasetId: FISH1_DATASET_ID,
    });
  }
  const rootId = readBigId(row[SOMA_COLUMNS.rootId]);
  const rawCellType = row[SOMA_COLUMNS.cellType];

  return {
    datasetId: FISH1_DATASET_ID,
    loreId: asLoreId(String(row[SOMA_COLUMNS.loreId])),
    root: rootId
      ? {
          rootId: asRootId(rootId),
          materializationVersion: materialization,
          isLatest,
        }
      : null,
    supervoxelId: readBigId(row[SOMA_COLUMNS.supervoxelId]) ?? undefined,
    cellType: mapFish1CellType(rawCellType),
    cellTypeRaw: typeof rawCellType === 'string' ? rawCellType : undefined,
    positionVoxel: position,
    positionUm: voxelToMicrometres(position, FISH1_VOXEL_SPACE),
    flags: 0,
    annotations: {
      created:
        typeof row[SOMA_COLUMNS.created] === 'string'
          ? (row[SOMA_COLUMNS.created] as string)
          : null,
    },
    provenance: 'measured',
  };
}

export async function fish1GetNeuron(
  loreId: LoreId,
  options: { checkLatestRoot?: boolean } = {},
): Promise<Neuron> {
  const config = readCaveConfig();
  const materialization = await resolveVersion(config);

  const rows = await queryTable(config, materialization, {
    table: FISH1_TABLES.somas,
    filterEqual: { [SOMA_COLUMNS.loreId]: Number(loreId) },
    limit: 1,
  });

  if (rows.length === 0) {
    throw new DataError({
      code: 'not_found',
      message: `No soma with lore ID ${loreId} in materialization ${materialization}.`,
      datasetId: FISH1_DATASET_ID,
    });
  }

  let isLatest: boolean | null = null;
  const rootId = readBigId(rows[0][SOMA_COLUMNS.rootId]);
  if (options.checkLatestRoot && rootId) {
    // A root ID from a materialized table can be stale relative to live
    // proofreading. Checking costs a request, so it is opt-in.
    try {
      isLatest = (await isLatestRoots(config, [rootId])).get(rootId) ?? null;
    } catch {
      isLatest = null;
    }
  }

  return somaRowToNeuron(rows[0], materialization, isLatest);
}

/** Resolves root IDs back to stable lore IDs and cell types, in one query. */
async function somasByRootIds(
  config: CaveConfig,
  materialization: number,
  rootIds: readonly string[],
): Promise<Map<string, { loreId: LoreId; cellType: CellPolarity }>> {
  const out = new Map<string, { loreId: LoreId; cellType: CellPolarity }>();
  if (rootIds.length === 0) return out;

  // Chunked so a neuron with hundreds of partners does not build one enormous
  // filter clause.
  const CHUNK = 200;
  for (let i = 0; i < rootIds.length; i += CHUNK) {
    const chunk = rootIds.slice(i, i + CHUNK);
    const rows = await queryTable(config, materialization, {
      table: FISH1_TABLES.somas,
      filterIn: { [SOMA_COLUMNS.rootId]: chunk.map((id) => Number(id)) },
      selectColumns: [SOMA_COLUMNS.loreId, SOMA_COLUMNS.rootId, SOMA_COLUMNS.cellType],
    });
    for (const row of rows) {
      const rid = readBigId(row[SOMA_COLUMNS.rootId]);
      if (!rid) continue;
      out.set(rid, {
        loreId: asLoreId(String(row[SOMA_COLUMNS.loreId])),
        cellType: mapFish1CellType(row[SOMA_COLUMNS.cellType]),
      });
    }
  }
  return out;
}

export interface Fish1ConnectionOptions {
  readonly direction: 'incoming' | 'outgoing' | 'both';
  readonly minSynapses: number;
  readonly topN: number;
  readonly resolvePartnerIdentities: boolean;
}

export async function fish1GetConnections(
  loreId: LoreId,
  options: Fish1ConnectionOptions,
): Promise<ConnectionSet> {
  const config = readCaveConfig();
  const materialization = await resolveVersion(config);
  const neuron = await fish1GetNeuron(loreId);

  if (!neuron.root) {
    throw new DataError({
      code: 'connectivity_unavailable',
      message: `Lore ID ${loreId} has no root ID in materialization ${materialization}, so its synapses cannot be queried.`,
      datasetId: FISH1_DATASET_ID,
    });
  }
  const rootId = neuron.root.rootId;

  const directions: Array<'incoming' | 'outgoing'> =
    options.direction === 'both' ? ['incoming', 'outgoing'] : [options.direction];

  // partner root id -> aggregated counts, per direction.
  const aggregate = new Map<
    string,
    {
      direction: 'incoming' | 'outgoing';
      total: number;
      excitatory: number;
      inhibitory: number;
    }
  >();
  const totals: {
    incomingSynapses: number;
    outgoingSynapses: number;
    incomingExcitatory: number;
    incomingInhibitory: number;
    outgoingExcitatory: number;
    outgoingInhibitory: number;
  } = {
    incomingSynapses: 0,
    outgoingSynapses: 0,
    incomingExcitatory: 0,
    incomingInhibitory: 0,
    outgoingExcitatory: 0,
    outgoingInhibitory: 0,
  };

  let truncated = false;
  let truncationReason: string | undefined;

  for (const direction of directions) {
    const selfColumn =
      direction === 'incoming' ? SYNAPSE_COLUMNS.postRootId : SYNAPSE_COLUMNS.preRootId;
    const partnerColumn =
      direction === 'incoming' ? SYNAPSE_COLUMNS.preRootId : SYNAPSE_COLUMNS.postRootId;

    const rows = await queryTable(config, materialization, {
      table: FISH1_TABLES.synapsesAxDeLabel,
      filterEqual: { [selfColumn]: Number(rootId) },
      selectColumns: [
        SYNAPSE_COLUMNS.preRootId,
        SYNAPSE_COLUMNS.postRootId,
        SYNAPSE_COLUMNS.tag,
      ],
      limit: MAX_SYNAPSE_ROWS,
    });

    if (rows.length >= MAX_SYNAPSE_ROWS) {
      truncated = true;
      truncationReason = `Synapse rows were capped at ${MAX_SYNAPSE_ROWS.toLocaleString()} for the ${direction} direction; totals below this cap only.`;
    }

    // One row per synapse; we aggregate to one entry per PARTNER. A 30M-synapse
    // dataset must never be materialised as objects.
    for (const row of rows) {
      const partner = readBigId(row[partnerColumn]);
      if (!partner) continue;
      const tag = row[SYNAPSE_COLUMNS.tag];
      const key = `${direction}:${partner}`;
      let entry = aggregate.get(key);
      if (!entry) {
        entry = { direction, total: 0, excitatory: 0, inhibitory: 0 };
        aggregate.set(key, entry);
      }
      entry.total++;
      const tagStr = tag == null ? '' : String(tag);
      if (tagStr === SYNAPSE_TAG.excitatory) entry.excitatory++;
      else if (tagStr === SYNAPSE_TAG.inhibitory) entry.inhibitory++;

      if (direction === 'incoming') {
        totals.incomingSynapses++;
        if (tagStr === SYNAPSE_TAG.excitatory) totals.incomingExcitatory++;
        if (tagStr === SYNAPSE_TAG.inhibitory) totals.incomingInhibitory++;
      } else {
        totals.outgoingSynapses++;
        if (tagStr === SYNAPSE_TAG.excitatory) totals.outgoingExcitatory++;
        if (tagStr === SYNAPSE_TAG.inhibitory) totals.outgoingInhibitory++;
      }
    }
  }

  const incomingPartners = [...aggregate.values()].filter(
    (e) => e.direction === 'incoming',
  ).length;
  const outgoingPartners = [...aggregate.values()].filter(
    (e) => e.direction === 'outgoing',
  ).length;

  // Rank first, then cap, so a truncated list keeps the strongest partners.
  const ranked = [...aggregate.entries()]
    .map(([key, entry]) => ({ rootId: key.slice(key.indexOf(':') + 1), ...entry }))
    .filter((e) => e.total >= options.minSynapses)
    .sort((a, b) => b.total - a.total);

  const capped: typeof ranked = [];
  for (const direction of directions) {
    capped.push(
      ...ranked
        .filter((e) => e.direction === direction)
        .slice(0, Math.min(options.topN, TRAVERSAL_LIMITS.maxPartnersPerHop)),
    );
  }

  let identities = new Map<string, { loreId: LoreId; cellType: CellPolarity }>();
  if (options.resolvePartnerIdentities) {
    identities = await somasByRootIds(config, materialization, [
      ...new Set(capped.map((e) => e.rootId)),
    ]);
  }

  const partners: ConnectionPartner[] = capped.map((entry) => {
    const identity = identities.get(entry.rootId);
    return {
      // Null when the partner segment carries no soma annotation - a real and
      // common case (an axon fragment), not a lookup failure.
      loreId: identity?.loreId ?? null,
      rootId: asRootId(entry.rootId),
      direction: entry.direction,
      synapseCount: entry.total,
      synapsesByPolarity: {
        excitatory: entry.excitatory,
        inhibitory: entry.inhibitory,
      },
      partnerCellType: identity?.cellType ?? 'unknown',
      depth: 1,
    };
  });

  const connectionTotals: ConnectionTotals = {
    incomingSynapses: totals.incomingSynapses,
    outgoingSynapses: totals.outgoingSynapses,
    incomingPartners,
    outgoingPartners,
    incomingExcitatory: totals.incomingExcitatory,
    incomingInhibitory: totals.incomingInhibitory,
    outgoingExcitatory: totals.outgoingExcitatory,
    outgoingInhibitory: totals.outgoingInhibitory,
  };

  return {
    datasetId: FISH1_DATASET_ID,
    loreId,
    rootId,
    version: versionOf(config, materialization),
    partners,
    totals: connectionTotals,
    truncated,
    truncationReason,
    provenance: 'measured',
  };
}

export async function fish1GetSkeleton(loreId: LoreId): Promise<NeuronSkeleton> {
  const config = readCaveConfig();
  const neuron = await fish1GetNeuron(loreId);
  if (!neuron.root) {
    throw new DataError({
      code: 'skeleton_unavailable',
      message: `Lore ID ${loreId} has no root ID, so no skeleton can be requested.`,
      datasetId: FISH1_DATASET_ID,
    });
  }

  const swc = await getSkeletonSwc(config, neuron.root.rootId);
  if (swc === null) {
    throw new DataError({
      code: 'skeleton_unavailable',
      message: `No skeleton has been generated for root ${neuron.root.rootId}.`,
      datasetId: FISH1_DATASET_ID,
    });
  }

  // The CAVE skeleton cache emits nanometres; parseSwc defaults to nm -> um.
  const parsed = parseSwc(swc);
  return {
    datasetId: FISH1_DATASET_ID,
    loreId,
    rootId: neuron.root.rootId,
    vertexCount: parsed.vertexCount,
    verticesUm: parsed.vertices,
    parents: parsed.parents,
    radiiUm: parsed.radii,
    compartments: parsed.compartments,
    provenance: 'measured',
  };
}

/** Raw SWC passthrough for the download endpoint, avoiding a reserialise. */
export async function fish1GetSkeletonSwcText(loreId: LoreId): Promise<{
  swc: string;
  rootId: string;
}> {
  const config = readCaveConfig();
  const neuron = await fish1GetNeuron(loreId);
  if (!neuron.root) {
    throw new DataError({
      code: 'skeleton_unavailable',
      message: `Lore ID ${loreId} has no root ID.`,
      datasetId: FISH1_DATASET_ID,
    });
  }
  const swc = await getSkeletonSwc(config, neuron.root.rootId);
  if (swc === null) {
    throw new DataError({
      code: 'skeleton_unavailable',
      message: `No skeleton exists for root ${neuron.root.rootId}.`,
      datasetId: FISH1_DATASET_ID,
    });
  }
  return { swc, rootId: neuron.root.rootId };
}

export async function fish1Search(term: string): Promise<SearchResult[]> {
  const config = readCaveConfig();
  const materialization = await resolveVersion(config);
  const kind = classifyIdentifier(term);
  if (kind === 'unknown') return [];

  const rows = await queryTable(config, materialization, {
    table: FISH1_TABLES.somas,
    filterEqual:
      kind === 'lore'
        ? { [SOMA_COLUMNS.loreId]: Number(term) }
        : { [SOMA_COLUMNS.rootId]: Number(term) },
    limit: 10,
  });

  return rows.map((row) => {
    const position = readPosition(row, SOMA_COLUMNS.position);
    return {
      datasetId: FISH1_DATASET_ID,
      loreId: asLoreId(String(row[SOMA_COLUMNS.loreId])),
      label: String(row[SOMA_COLUMNS.loreId]),
      sublabel:
        kind === 'root'
          ? `matched root ${term}`
          : `root ${readBigId(row[SOMA_COLUMNS.rootId]) ?? 'unknown'}`,
      cellType: mapFish1CellType(row[SOMA_COLUMNS.cellType]),
      matchedOn: kind === 'root' ? ('root-id' as const) : ('lore-id' as const),
      positionUm: position ? voxelToMicrometres(position, FISH1_VOXEL_SPACE) : undefined,
    };
  });
}
