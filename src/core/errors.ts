/**
 * Typed failure modes.
 *
 * A scientific tool fails in ways a marketing site does not: an unauthenticated
 * upstream, a root ID invalidated by proofreading, and a missing skeleton are
 * three completely different situations and must never collapse into one
 * "Something went wrong". In particular, the UI must be able to distinguish
 * "this neuron genuinely has 0 connections" from "we could not retrieve
 * connectivity".
 */
export type DataErrorCode =
  | 'upstream_unavailable'
  | 'auth_missing'
  | 'auth_rejected'
  | 'not_found'
  | 'stale_root_id'
  | 'skeleton_unavailable'
  | 'connectivity_unavailable'
  | 'activity_unavailable'
  | 'malformed_binary'
  | 'dataset_mismatch'
  | 'version_mismatch'
  | 'query_too_large'
  | 'unsupported_operation'
  | 'rate_limited'
  | 'timeout'
  | 'unknown';

export interface DataErrorInit {
  code: DataErrorCode;
  message: string;
  /** Short, user-facing sentence. Should say what to do, not just what broke. */
  detail?: string;
  datasetId?: string;
  cause?: unknown;
  /** True when retrying the identical request could plausibly succeed. */
  retryable?: boolean;
  httpStatus?: number;
}

const DEFAULT_RETRYABLE = new Set<DataErrorCode>([
  'upstream_unavailable',
  'rate_limited',
  'timeout',
]);

const DEFAULT_STATUS: Record<DataErrorCode, number> = {
  upstream_unavailable: 502,
  auth_missing: 501,
  auth_rejected: 403,
  not_found: 404,
  stale_root_id: 409,
  skeleton_unavailable: 404,
  connectivity_unavailable: 502,
  activity_unavailable: 501,
  malformed_binary: 500,
  dataset_mismatch: 400,
  version_mismatch: 409,
  query_too_large: 413,
  unsupported_operation: 501,
  rate_limited: 429,
  timeout: 504,
  unknown: 500,
};

export class DataError extends Error {
  readonly code: DataErrorCode;
  readonly detail?: string;
  readonly datasetId?: string;
  readonly retryable: boolean;
  readonly httpStatus: number;

  constructor(init: DataErrorInit) {
    super(init.message, { cause: init.cause });
    this.name = 'DataError';
    this.code = init.code;
    this.detail = init.detail;
    this.datasetId = init.datasetId;
    this.retryable = init.retryable ?? DEFAULT_RETRYABLE.has(init.code);
    this.httpStatus = init.httpStatus ?? DEFAULT_STATUS[init.code];
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        detail: this.detail,
        datasetId: this.datasetId,
        retryable: this.retryable,
      },
    };
  }
}

/** Copy tuned for a researcher: says what happened and what to do next. */
export const ERROR_COPY: Record<DataErrorCode, { title: string; hint: string }> = {
  upstream_unavailable: {
    title: 'Upstream dataset unreachable',
    hint: 'The CAVE service did not respond. This is an upstream outage, not a problem with your query.',
  },
  auth_missing: {
    title: 'CAVE access not configured',
    hint: 'No CAVE_TOKEN is set on the server. See README, section "Fish1 access setup".',
  },
  auth_rejected: {
    title: 'CAVE token rejected',
    hint: 'The configured token is expired or lacks access to this datastack. Generate a new one.',
  },
  not_found: {
    title: 'Neuron not found',
    hint: 'No soma with this identifier exists in the current materialization.',
  },
  stale_root_id: {
    title: 'Root ID out of date',
    hint: 'This segment was edited by proofreading. Re-resolve it from the stable lore ID.',
  },
  skeleton_unavailable: {
    title: 'Morphology unavailable',
    hint: 'No skeleton has been generated for this segment.',
  },
  connectivity_unavailable: {
    title: 'Connectivity unavailable',
    hint: 'The synapse query failed. This is NOT the same as the neuron having no partners.',
  },
  activity_unavailable: {
    title: 'No activity data',
    hint: 'This dataset is structural only. Functional traces come from a separate dataset.',
  },
  malformed_binary: {
    title: 'Corrupt dataset binary',
    hint: 'A neuron index file failed validation. Re-run the pipeline export.',
  },
  dataset_mismatch: {
    title: 'Dataset mismatch',
    hint: 'This identifier belongs to a different dataset than the one loaded.',
  },
  version_mismatch: {
    title: 'Version mismatch',
    hint: 'The loaded index and the requested query refer to different materializations.',
  },
  query_too_large: {
    title: 'Query too large',
    hint: 'Narrow the traversal depth or raise the minimum synapse threshold.',
  },
  unsupported_operation: {
    title: 'Not supported by this dataset',
    hint: 'This adapter does not implement the requested capability.',
  },
  rate_limited: {
    title: 'Rate limited upstream',
    hint: 'Too many requests to CAVE. Wait a moment and retry.',
  },
  timeout: {
    title: 'Request timed out',
    hint: 'The upstream query exceeded its deadline.',
  },
  unknown: {
    title: 'Unexpected error',
    hint: 'See the browser console and server logs.',
  },
};

export function isDataError(e: unknown): e is DataError {
  return e instanceof DataError;
}

export function toDataError(e: unknown, fallbackCode: DataErrorCode = 'unknown'): DataError {
  if (isDataError(e)) return e;
  if (e instanceof Error) {
    const isAbort = e.name === 'AbortError' || e.name === 'TimeoutError';
    return new DataError({
      code: isAbort ? 'timeout' : fallbackCode,
      message: e.message,
      cause: e,
    });
  }
  return new DataError({ code: fallbackCode, message: String(e) });
}

/** Shape returned by every API route on failure. */
export interface ApiErrorBody {
  error: {
    code: DataErrorCode;
    message: string;
    detail?: string;
    datasetId?: string;
    retryable: boolean;
  };
}

export function isApiErrorBody(v: unknown): v is ApiErrorBody {
  return (
    typeof v === 'object' &&
    v !== null &&
    'error' in v &&
    typeof (v as ApiErrorBody).error?.code === 'string'
  );
}
