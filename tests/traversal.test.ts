import { describe, expect, it } from 'vitest';
import { estimateTraversalSize, neighbours, traverseGraph, type Csr } from '@/core/traversal';
import { TRAVERSAL_LIMITS } from '@/core/types';

/**
 * Traversal limits are a user-protection feature: a depth-3 query in a dense
 * connectome can touch a large fraction of the brain. These tests pin that the
 * caps engage, and that hitting one is reported rather than hidden.
 */

/** Builds a CSR where node i connects to i+1 .. i+degree with given weights. */
function chainCsr(nodeCount: number, degree: number, weight = 10): Csr {
  const offsets = new Uint32Array(nodeCount + 1);
  const targets: number[] = [];
  const weights: number[] = [];
  for (let i = 0; i < nodeCount; i++) {
    for (let d = 1; d <= degree; d++) {
      const target = (i + d) % nodeCount;
      targets.push(target);
      // Descending weights so ranking is observable.
      weights.push(weight - d);
    }
    offsets[i + 1] = targets.length;
  }
  return {
    offsets,
    targets: Uint32Array.from(targets),
    weights: Uint32Array.from(weights),
  };
}

/**
 * Builds a fan-out (tree-like) CSR: node i connects to i*degree+1 ... i*degree+degree.
 *
 * Distinct from chainCsr, where neighbourhoods overlap heavily and a depth-3
 * walk therefore reaches only a few hundred nodes. Real traversal blow-up needs
 * branches that do not immediately reconverge, which is what this produces.
 */
function fanOutCsr(nodeCount: number, degree: number): Csr {
  const offsets = new Uint32Array(nodeCount + 1);
  const targets: number[] = [];
  const weights: number[] = [];
  for (let i = 0; i < nodeCount; i++) {
    for (let d = 1; d <= degree; d++) {
      targets.push((i * degree + d) % nodeCount);
      weights.push(degree - d + 1);
    }
    offsets[i + 1] = targets.length;
  }
  return {
    offsets,
    targets: Uint32Array.from(targets),
    weights: Uint32Array.from(weights),
  };
}

const EMPTY: Csr = {
  offsets: new Uint32Array(1),
  targets: new Uint32Array(0),
  weights: new Uint32Array(0),
};

describe('neighbours', () => {
  const csr = chainCsr(10, 4);

  it('returns partners ranked by synapse count', () => {
    const result = neighbours(csr, 0, 1, 10);
    expect(result.map((r) => r.weight)).toEqual([9, 8, 7, 6]);
  });

  it('drops partners below the minimum synapse count', () => {
    expect(neighbours(csr, 0, 8, 10).map((r) => r.weight)).toEqual([9, 8]);
  });

  it('keeps the strongest partners when capped by topN', () => {
    const result = neighbours(csr, 0, 1, 2);
    expect(result.map((r) => r.weight)).toEqual([9, 8]);
  });

  it('returns nothing for an out-of-range node', () => {
    expect(neighbours(csr, -1, 1, 10)).toEqual([]);
    expect(neighbours(csr, 999, 1, 10)).toEqual([]);
  });
});

describe('traverseGraph', () => {
  it('returns direct partners at depth 1', () => {
    const outgoing = chainCsr(50, 3);
    const result = traverseGraph({
      rootIndex: 0,
      depth: 1,
      direction: 'outgoing',
      minSynapses: 1,
      topN: 10,
      outgoing,
      incoming: EMPTY,
    });
    expect(result.edges).toHaveLength(3);
    expect(result.nodesByDepth[1]).toEqual([1, 2, 3]);
    expect(result.truncated).toBe(false);
  });

  it('always orients edges presynaptic -> postsynaptic', () => {
    const incoming = chainCsr(20, 2);
    const result = traverseGraph({
      rootIndex: 5,
      depth: 1,
      direction: 'incoming',
      minSynapses: 1,
      topN: 10,
      outgoing: EMPTY,
      incoming,
    });
    // Walking backwards from node 5: the partner is presynaptic, so it must be
    // the edge SOURCE even though traversal found it as a "target".
    for (const edge of result.edges) {
      expect(edge.target).toBe(5);
      expect(edge.source).not.toBe(5);
      expect(edge.direction).toBe('incoming');
    }
  });

  it('expands over multiple hops and labels depth', () => {
    const outgoing = chainCsr(200, 2);
    const result = traverseGraph({
      rootIndex: 0,
      depth: 2,
      direction: 'outgoing',
      minSynapses: 1,
      topN: 10,
      outgoing,
      incoming: EMPTY,
    });
    expect(Object.keys(result.nodesByDepth).sort()).toEqual(['0', '1', '2']);
    expect(result.edges.some((e) => e.depth === 2)).toBe(true);
  });

  it('never visits a node twice', () => {
    const outgoing = chainCsr(30, 5);
    const result = traverseGraph({
      rootIndex: 0,
      depth: 3,
      direction: 'outgoing',
      minSynapses: 1,
      topN: 20,
      outgoing,
      incoming: EMPTY,
    });
    const all = Object.values(result.nodesByDepth).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it('clamps depth to the configured maximum', () => {
    const outgoing = chainCsr(5000, 2);
    const result = traverseGraph({
      rootIndex: 0,
      depth: 99,
      direction: 'outgoing',
      minSynapses: 1,
      topN: 4,
      outgoing,
      incoming: EMPTY,
    });
    const deepest = Math.max(...Object.keys(result.nodesByDepth).map(Number));
    expect(deepest).toBeLessThanOrEqual(TRAVERSAL_LIMITS.maxDepth);
  });

  it('stops at the node cap and says so', () => {
    // Genuinely fans out: depth 3 at degree 60 would reach ~200k nodes.
    const outgoing = fanOutCsr(500000, 60);
    const result = traverseGraph({
      rootIndex: 0,
      depth: 3,
      direction: 'outgoing',
      minSynapses: 1,
      topN: TRAVERSAL_LIMITS.maxPartnersPerHop,
      outgoing,
      incoming: EMPTY,
    });
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toMatch(/stopped at/i);
    expect(result.visitedCount).toBeLessThanOrEqual(TRAVERSAL_LIMITS.maxTotalNodes);
  });

  it('caps partners per hop even when asked for more', () => {
    const outgoing = chainCsr(2000, 400);
    const result = traverseGraph({
      rootIndex: 0,
      depth: 1,
      direction: 'outgoing',
      minSynapses: 1,
      topN: 100000,
      outgoing,
      incoming: EMPTY,
    });
    expect(result.edges.length).toBeLessThanOrEqual(TRAVERSAL_LIMITS.maxPartnersPerHop);
  });

  it('handles an isolated node without error', () => {
    const result = traverseGraph({
      rootIndex: 0,
      depth: 2,
      direction: 'both',
      minSynapses: 1,
      topN: 10,
      outgoing: EMPTY,
      incoming: EMPTY,
    });
    expect(result.edges).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.visitedCount).toBe(1);
  });

  it('walks both directions when asked', () => {
    const csr = chainCsr(40, 2);
    const result = traverseGraph({
      rootIndex: 10,
      depth: 1,
      direction: 'both',
      minSynapses: 1,
      topN: 10,
      outgoing: csr,
      incoming: csr,
    });
    expect(result.edges.some((e) => e.direction === 'incoming')).toBe(true);
    expect(result.edges.some((e) => e.direction === 'outgoing')).toBe(true);
  });
});

describe('estimateTraversalSize', () => {
  it('grows geometrically with depth', () => {
    expect(estimateTraversalSize(10, 1, 50)).toBe(11);
    expect(estimateTraversalSize(10, 2, 50)).toBe(111);
  });

  it('is bounded by the node cap', () => {
    expect(estimateTraversalSize(200, 3, 250)).toBe(TRAVERSAL_LIMITS.maxTotalNodes);
  });

  it('respects topN as the effective branching factor', () => {
    expect(estimateTraversalSize(1000, 2, 3)).toBe(13);
  });
});
