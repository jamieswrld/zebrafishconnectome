/**
 * Identifier handling for segmentation-backed connectomes.
 *
 * Fish1 (and CAVE datasets generally) use a two-level identity system:
 *
 *   lore ID   Small stable integer naming a *soma*  (e.g. 173502).
 *             Does NOT change when the segmentation is proofread.
 *             This is the identifier we persist, share in URLs, and key on.
 *
 *   root ID   Large 64-bit integer naming the *current segmentation* of a
 *             neuron (e.g. 864691128630286274). CHANGES after merge/split
 *             edits. Valid only relative to a materialization version or
 *             timestamp. Never persist a bare root ID as a neuron's identity.
 *
 *   supervoxel ID  Leaf chunk of the segmentation graph; the atomic unit.
 *
 * Root IDs exceed Number.MAX_SAFE_INTEGER, so they are carried as strings
 * throughout the application and converted to BigInt only where arithmetic is
 * genuinely required. JSON.parse would silently corrupt them as numbers.
 */

declare const loreBrand: unique symbol;
declare const rootBrand: unique symbol;

export type LoreId = string & { readonly [loreBrand]: 'LoreId' };
export type RootId = string & { readonly [rootBrand]: 'RootId' };

/** Canonical application-level neuron key: `<datasetId>:<loreId>`. */
export type NeuronKey = string;

const DIGITS = /^[0-9]+$/;

export function isLoreId(value: unknown): value is LoreId {
  return typeof value === 'string' && DIGITS.test(value) && value.length <= 12;
}

export function isRootId(value: unknown): value is RootId {
  // Root IDs in CAVE deployments are 64-bit; accept 13..20 digits.
  return typeof value === 'string' && DIGITS.test(value) && value.length >= 13;
}

export function asLoreId(value: string | number | bigint): LoreId {
  const s = typeof value === 'string' ? value.trim() : String(value);
  if (!DIGITS.test(s)) throw new Error(`Invalid lore ID: ${JSON.stringify(value)}`);
  // Strip leading zeros so "0173502" and "173502" are the same neuron.
  const norm = s.replace(/^0+(?=\d)/, '');
  return norm as LoreId;
}

export function asRootId(value: string | number | bigint): RootId {
  const s = typeof value === 'string' ? value.trim() : String(value);
  if (!DIGITS.test(s)) throw new Error(`Invalid root ID: ${JSON.stringify(value)}`);
  return s.replace(/^0+(?=\d)/, '') as RootId;
}

/**
 * Classifies a free-text search term. Used by the search endpoint to decide
 * whether to resolve a stable soma ID or a mutable segmentation ID.
 */
export type IdentifierKind = 'lore' | 'root' | 'unknown';

export function classifyIdentifier(term: string): IdentifierKind {
  const t = term.trim();
  if (!DIGITS.test(t)) return 'unknown';
  if (t.length >= 13) return 'root';
  return 'lore';
}

export function neuronKey(datasetId: string, loreId: LoreId): NeuronKey {
  return `${datasetId}:${loreId}`;
}

export function parseNeuronKey(key: NeuronKey): { datasetId: string; loreId: LoreId } {
  const idx = key.indexOf(':');
  if (idx < 0) throw new Error(`Malformed neuron key: ${key}`);
  return {
    datasetId: key.slice(0, idx),
    loreId: asLoreId(key.slice(idx + 1)),
  };
}

/**
 * A root ID is only meaningful together with the version it was read at.
 * Carrying them as a pair prevents comparing IDs across materializations.
 */
export interface VersionedRootId {
  readonly rootId: RootId;
  readonly materializationVersion: number | null;
  /** ISO timestamp the root ID was valid at, when the server reports one. */
  readonly validAt?: string;
  /**
   * Whether the upstream chunked graph confirmed this is the newest root for
   * the segment. `null` means we did not check (checking costs a request).
   */
  readonly isLatest: boolean | null;
}
