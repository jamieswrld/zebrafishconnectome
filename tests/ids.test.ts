import { describe, expect, it } from 'vitest';
import {
  asLoreId,
  asRootId,
  classifyIdentifier,
  isLoreId,
  isRootId,
  neuronKey,
  parseNeuronKey,
} from '@/core/ids';

/**
 * The lore/root distinction is the single most important correctness rule in
 * the Fish1 data model: a lore ID is a stable soma identity, a root ID names a
 * segmentation that proofreading can change. Confusing them means confidently
 * showing the wrong neuron.
 */

describe('identifier classification', () => {
  it('treats short integers as lore IDs', () => {
    expect(classifyIdentifier('173502')).toBe('lore');
    expect(isLoreId('173502')).toBe(true);
  });

  it('treats 64-bit values as root IDs', () => {
    // A real Fish1 root ID from the official documentation.
    expect(classifyIdentifier('864691128630286274')).toBe('root');
    expect(isRootId('864691128630286274')).toBe(true);
    expect(isLoreId('864691128630286274')).toBe(false);
  });

  it('rejects non-numeric terms', () => {
    expect(classifyIdentifier('tectum')).toBe('unknown');
    expect(classifyIdentifier('')).toBe('unknown');
    expect(classifyIdentifier('173502a')).toBe('unknown');
  });

  it('carries root IDs as strings so 64-bit precision survives', () => {
    const raw = '864691128630286274';
    const rootId = asRootId(raw);
    expect(rootId).toBe(raw);
    // The same value as a JS number would silently lose precision.
    expect(String(Number(raw))).not.toBe(raw);
    expect(BigInt(rootId).toString()).toBe(raw);
  });
});

describe('normalisation', () => {
  it('strips leading zeros so a padded ID is the same neuron', () => {
    expect(asLoreId('0173502')).toBe('173502');
    expect(asLoreId(173502)).toBe('173502');
  });

  it('trims surrounding whitespace from pasted values', () => {
    expect(asLoreId('  173502  ')).toBe('173502');
  });

  it('preserves a bare zero', () => {
    expect(asLoreId('0')).toBe('0');
  });

  it('throws on malformed input rather than guessing', () => {
    expect(() => asLoreId('abc')).toThrow(/Invalid lore ID/);
    expect(() => asRootId('12.5')).toThrow(/Invalid root ID/);
    expect(() => asLoreId('-5')).toThrow();
  });
});

describe('neuron keys', () => {
  it('round-trips a dataset-scoped key', () => {
    const key = neuronKey('fish1', asLoreId('173502'));
    expect(key).toBe('fish1:173502');
    const parsed = parseNeuronKey(key);
    expect(parsed.datasetId).toBe('fish1');
    expect(parsed.loreId).toBe('173502');
  });

  it('rejects a malformed key', () => {
    expect(() => parseNeuronKey('173502')).toThrow(/Malformed neuron key/);
  });
});
