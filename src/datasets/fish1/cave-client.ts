import { DataError } from '@/core/errors';
import {
  CAVE_TOKEN_SETTINGS_PATH,
  DEFAULT_CAVE_GLOBAL_URL,
  DEFAULT_CAVE_LOCAL_URL,
  DEFAULT_DATASTACK,
  DEFAULT_PCG_TABLE,
  FISH1_DATASET_ID,
} from './constants';

/**
 * SERVER-ONLY CAVE client.
 *
 * The CAVE token is a personal credential that grants the holder our identity
 * against the upstream service. It is read from the environment here and never
 * leaves the server: the browser talks to our own /api routes, and those routes
 * talk to CAVE. Importing this module from a client component is a bug, and the
 * guard below turns that bug into an immediate, obvious failure.
 *
 * Endpoint templates, request bodies and the auth header are taken from the
 * CAVEclient reference implementation (seung-lab/CAVEclient, caveclient/
 * endpoints.py and materializationengine.py), not invented:
 *
 *   info          GET  {global}/info/api/v2/datastack/full/{datastack}
 *   versions      GET  {local}/materialize/api/v3/datastack/{ds}/versions
 *   simple query  POST {local}/materialize/api/v3/datastack/{ds}/version/{v}
 *                        /table/{table}/query
 *   is_latest     POST {local}/segmentation/api/v1/table/{pcg}/is_latest_roots
 *   skeleton      GET  {local}/skeletoncache/api/v1/{ds}/precomputed/skeleton
 *                        /{skeletonVersion}/{rootId}/{format}
 *   auth header   Authorization: Bearer <token>
 *
 * Query responses are requested as JSON (return_pyarrow=false). CAVEclient
 * passes that body through untyped, so the exact JSON shape is not contractual;
 * {@link rowsFromQueryResponse} therefore accepts the three shapes such services
 * emit and fails loudly rather than guessing.
 */

if (typeof window !== 'undefined') {
  throw new Error(
    'src/datasets/fish1/cave-client.ts is server-only and must never be bundled into the browser.',
  );
}

export interface CaveConfig {
  readonly globalUrl: string;
  readonly localUrl: string;
  readonly datastack: string;
  readonly pcgTable: string;
  readonly token: string | null;
  readonly pinnedVersion: number | null;
  readonly cacheTtlSeconds: number;
}

export function readCaveConfig(): CaveConfig {
  const pinned = process.env.FISH1_MATERIALIZATION_VERSION?.trim();
  return {
    globalUrl: stripSlash(process.env.CAVE_GLOBAL_URL || DEFAULT_CAVE_GLOBAL_URL),
    localUrl: stripSlash(process.env.CAVE_LOCAL_URL || DEFAULT_CAVE_LOCAL_URL),
    datastack: process.env.FISH1_DATASTACK || DEFAULT_DATASTACK,
    pcgTable: process.env.FISH1_PCG_TABLE || DEFAULT_PCG_TABLE,
    token: process.env.CAVE_TOKEN?.trim() || null,
    pinnedVersion: pinned && /^\d+$/.test(pinned) ? Number(pinned) : null,
    cacheTtlSeconds: Number(process.env.CAVE_CACHE_TTL_SECONDS || 900),
  };
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function missingTokenError(config: CaveConfig): DataError {
  return new DataError({
    code: 'auth_missing',
    message: 'No CAVE_TOKEN is configured on the server.',
    detail: `Fish1 requires an access token. Obtain one at ${config.globalUrl}${CAVE_TOKEN_SETTINGS_PATH}, then set CAVE_TOKEN in the server environment (.env.local when running locally, or a project environment variable when deployed) and restart.`,
    datasetId: FISH1_DATASET_ID,
  });
}

/* -------------------------------------------------------------------------- */
/* Response cache                                                             */
/* -------------------------------------------------------------------------- */

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * Process-local cache. Upstream materialized tables are immutable for a given
 * version, so repeating an identical query is pure waste - and CAVE is a shared
 * community resource we should not hammer.
 */
const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 500;

function cacheGet<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function cacheSet(key: string, value: unknown, ttlSeconds: number): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    // Cheap eviction: drop the oldest insertion.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export function clearCaveCache(): void {
  cache.clear();
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

const REQUEST_TIMEOUT_MS = 30_000;

async function caveFetch(
  config: CaveConfig,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  if (!config.token) throw missingTokenError(config);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      cache: 'no-store',
    });
  } catch (cause) {
    clearTimeout(timeout);
    const aborted = cause instanceof Error && cause.name === 'AbortError';
    throw new DataError({
      code: aborted ? 'timeout' : 'upstream_unavailable',
      message: aborted
        ? `CAVE request timed out after ${init.timeoutMs ?? REQUEST_TIMEOUT_MS} ms.`
        : `Could not reach the CAVE service at ${new URL(url).host}.`,
      datasetId: FISH1_DATASET_ID,
      cause,
    });
  }
  clearTimeout(timeout);

  if (response.status === 401 || response.status === 403) {
    throw new DataError({
      code: 'auth_rejected',
      message: `CAVE rejected the configured token (HTTP ${response.status}).`,
      detail:
        'The token may be expired, or the account may lack access to this datastack. Generate a new token and update CAVE_TOKEN.',
      datasetId: FISH1_DATASET_ID,
    });
  }
  if (response.status === 404) {
    throw new DataError({
      code: 'not_found',
      message: `CAVE returned 404 for ${url}.`,
      datasetId: FISH1_DATASET_ID,
    });
  }
  if (response.status === 429) {
    throw new DataError({
      code: 'rate_limited',
      message: 'CAVE rate-limited this request.',
      datasetId: FISH1_DATASET_ID,
    });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new DataError({
      code: 'upstream_unavailable',
      message: `CAVE returned HTTP ${response.status}.`,
      detail: body.slice(0, 400) || undefined,
      datasetId: FISH1_DATASET_ID,
    });
  }
  return response;
}

/* -------------------------------------------------------------------------- */
/* Row normalisation                                                          */
/* -------------------------------------------------------------------------- */

export type Row = Record<string, unknown>;

/**
 * Normalises a materialization query response into an array of row objects.
 *
 * Accepts the three encodings such services emit:
 *   1. `[{col: value}, ...]`                        record array
 *   2. `{col: {"0": value, "1": value}, ...}`       pandas "columns" orient
 *   3. `{data: [...], columns: [...]}`              split-ish form
 *
 * Anything else raises rather than silently producing an empty result, because
 * "no partners" and "we failed to read the response" must never look alike.
 */
export function rowsFromQueryResponse(payload: unknown): Row[] {
  if (Array.isArray(payload)) return payload as Row[];

  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;

    if (Array.isArray(obj.data)) {
      const data = obj.data as unknown[];
      if (Array.isArray(obj.columns)) {
        const columns = obj.columns as string[];
        return data.map((row) => {
          const values = row as unknown[];
          const out: Row = {};
          columns.forEach((c, i) => (out[c] = values[i]));
          return out;
        });
      }
      return data as Row[];
    }

    const columnNames = Object.keys(obj);
    const firstColumn = columnNames.length > 0 ? obj[columnNames[0]] : undefined;
    if (firstColumn && typeof firstColumn === 'object' && !Array.isArray(firstColumn)) {
      const rowKeys = Object.keys(firstColumn as Record<string, unknown>);
      return rowKeys.map((rk) => {
        const out: Row = {};
        for (const c of columnNames) {
          out[c] = (obj[c] as Record<string, unknown>)?.[rk];
        }
        return out;
      });
    }
    if (columnNames.length === 0) return [];
  }

  throw new DataError({
    code: 'upstream_unavailable',
    message: 'Could not interpret the CAVE query response.',
    detail:
      'The materialization service returned a JSON shape this client does not recognise. Treat this as a failed query, not as an empty result.',
    datasetId: FISH1_DATASET_ID,
  });
}

/** Reads a position that may be split into _x/_y/_z or arrive as an array. */
export function readPosition(row: Row, base: string): [number, number, number] | null {
  const packed = row[base];
  if (Array.isArray(packed) && packed.length >= 3) {
    return [Number(packed[0]), Number(packed[1]), Number(packed[2])];
  }
  const x = row[`${base}_x`];
  const y = row[`${base}_y`];
  const z = row[`${base}_z`];
  if (x != null && y != null && z != null) return [Number(x), Number(y), Number(z)];
  return null;
}

/**
 * Reads a 64-bit ID as a string.
 *
 * Root IDs exceed Number.MAX_SAFE_INTEGER. If the upstream JSON already parsed
 * one into a float, precision is gone and we must not pretend otherwise.
 */
export function readBigId(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new DataError({
        code: 'upstream_unavailable',
        message: `A 64-bit identifier arrived as an unsafe JSON number (${value}).`,
        detail:
          'The upstream response lost precision on a root ID. Refusing to report a corrupted identifier.',
        datasetId: FISH1_DATASET_ID,
      });
    }
    return String(value);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* API surface                                                                */
/* -------------------------------------------------------------------------- */

export interface DatastackInfo {
  readonly localServer: string;
  readonly segmentationSource?: string;
  readonly viewerResolution?: [number, number, number];
  readonly raw: Record<string, unknown>;
}

export async function getDatastackInfo(config: CaveConfig): Promise<DatastackInfo> {
  const key = `info:${config.datastack}`;
  const cached = cacheGet<DatastackInfo>(key);
  if (cached) return cached;

  const url = `${config.globalUrl}/info/api/v2/datastack/full/${config.datastack}`;
  const response = await caveFetch(config, url, { method: 'GET' });
  const raw = (await response.json()) as Record<string, unknown>;

  const info: DatastackInfo = {
    localServer: stripSlash(String(raw.local_server ?? config.localUrl)),
    segmentationSource:
      typeof raw.segmentation_source === 'string' ? raw.segmentation_source : undefined,
    viewerResolution: Array.isArray(raw.viewer_resolution_x) ? undefined : readResolution(raw),
    raw,
  };
  cacheSet(key, info, config.cacheTtlSeconds);
  return info;
}

function readResolution(raw: Record<string, unknown>): [number, number, number] | undefined {
  const x = raw.viewer_resolution_x;
  const y = raw.viewer_resolution_y;
  const z = raw.viewer_resolution_z;
  if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number') {
    return [x, y, z];
  }
  return undefined;
}

/** Materialization server, discovered from the info service when possible. */
async function materializeBase(config: CaveConfig): Promise<string> {
  try {
    const info = await getDatastackInfo(config);
    return info.localServer;
  } catch {
    return config.localUrl;
  }
}

export async function getMaterializationVersions(config: CaveConfig): Promise<number[]> {
  const key = `versions:${config.datastack}`;
  const cached = cacheGet<number[]>(key);
  if (cached) return cached;

  const base = await materializeBase(config);
  const url = `${base}/materialize/api/v3/datastack/${config.datastack}/versions`;
  const response = await caveFetch(config, url, { method: 'GET' });
  const payload = await response.json();
  const versions = Array.isArray(payload) ? payload.map(Number).filter(Number.isFinite) : [];
  versions.sort((a, b) => a - b);
  // Short TTL: a new materialization can appear at any time.
  cacheSet(key, versions, Math.min(config.cacheTtlSeconds, 300));
  return versions;
}

export async function resolveVersion(config: CaveConfig): Promise<number> {
  if (config.pinnedVersion !== null) return config.pinnedVersion;
  const versions = await getMaterializationVersions(config);
  const latest = versions.at(-1);
  if (latest === undefined) {
    throw new DataError({
      code: 'upstream_unavailable',
      message: 'CAVE reported no materialization versions for this datastack.',
      datasetId: FISH1_DATASET_ID,
    });
  }
  return latest;
}

export interface TableQuery {
  readonly table: string;
  readonly filterEqual?: Record<string, unknown>;
  readonly filterIn?: Record<string, unknown[]>;
  readonly selectColumns?: string[];
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Runs a single-table materialization query and returns normalised rows.
 * Results are cached per (version, table, filters, limit).
 */
export async function queryTable(
  config: CaveConfig,
  version: number,
  query: TableQuery,
): Promise<Row[]> {
  const key = `q:${config.datastack}:${version}:${JSON.stringify(query)}`;
  const cached = cacheGet<Row[]>(key);
  if (cached) return cached;

  const base = await materializeBase(config);
  const url =
    `${base}/materialize/api/v3/datastack/${config.datastack}` +
    `/version/${version}/table/${query.table}/query` +
    // JSON rather than Arrow: we have no Arrow decoder here, and these queries
    // are small (one neuron's partners), not bulk exports. Bulk extraction is
    // the Python pipeline's job.
    `?return_pyarrow=false&arrow_format=false&split_positions=true`;

  const body: Record<string, unknown> = {};
  if (query.filterEqual) body.filter_equal_dict = query.filterEqual;
  if (query.filterIn) body.filter_in_dict = query.filterIn;
  if (query.selectColumns) body.select_columns = query.selectColumns;
  if (query.limit !== undefined) body.limit = query.limit;
  if (query.offset !== undefined) body.offset = query.offset;

  const response = await caveFetch(config, url, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const rows = rowsFromQueryResponse(await response.json());
  cacheSet(key, rows, config.cacheTtlSeconds);
  return rows;
}

/**
 * Asks the chunked graph whether root IDs are current.
 *
 * This is the check that keeps the application honest about proofreading: a
 * root ID read from an older materialization may no longer name a real segment.
 */
export async function isLatestRoots(
  config: CaveConfig,
  rootIds: readonly string[],
): Promise<Map<string, boolean>> {
  if (rootIds.length === 0) return new Map();
  const base = await materializeBase(config);
  const url = `${base}/segmentation/api/v1/table/${config.pcgTable}/is_latest_roots`;
  const response = await caveFetch(config, url, {
    method: 'POST',
    body: JSON.stringify({ node_ids: rootIds.map((id) => Number(id)) }),
  });
  const payload = (await response.json()) as { is_latest?: boolean[] } | boolean[];
  const flags = Array.isArray(payload) ? payload : (payload.is_latest ?? []);
  const out = new Map<string, boolean>();
  rootIds.forEach((id, i) => out.set(id, Boolean(flags[i])));
  return out;
}

/**
 * Fetches an SWC skeleton from the skeleton cache.
 * Returns null when no skeleton exists, which the caller must present as
 * "morphology unavailable" rather than as an error.
 */
export async function getSkeletonSwc(
  config: CaveConfig,
  rootId: string,
  skeletonVersion = 0,
): Promise<string | null> {
  const base = await materializeBase(config);
  const url =
    `${base}/skeletoncache/api/v1/${config.datastack}` +
    `/precomputed/skeleton/${skeletonVersion}/${rootId}/swc`;
  try {
    const response = await caveFetch(config, url, { method: 'GET', timeoutMs: 60_000 });
    return await response.text();
  } catch (e) {
    if (e instanceof DataError && e.code === 'not_found') return null;
    throw e;
  }
}

export function isCaveConfigured(config: CaveConfig): boolean {
  return Boolean(config.token);
}
