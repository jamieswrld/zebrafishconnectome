import { TRAVERSAL_LIMITS } from './types';

/**
 * Bounded breadth-first traversal over a CSR adjacency.
 *
 * Lives here rather than inside the worker so it is directly testable: the
 * limits that stop a depth-3 query from consuming the browser are exactly the
 * kind of logic that must not be unverifiable.
 *
 * Two invariants this enforces:
 *  - Edges are always emitted presynaptic -> postsynaptic, regardless of which
 *    direction the traversal walked. Downstream code can then read an edge
 *    without knowing how it was found.
 *  - Traversal is capped by depth, per-hop partner count, and total node count.
 *    Hitting a cap sets `truncated` with a reason; it never silently returns a
 *    partial result that looks complete.
 */

export interface Csr {
  readonly offsets: Uint32Array;
  readonly targets: Uint32Array;
  readonly weights: Uint32Array;
}

export interface TraversalEdge {
  readonly source: number;
  readonly target: number;
  readonly synapseCount: number;
  readonly direction: 'incoming' | 'outgoing';
  readonly depth: number;
}

export interface TraversalOptions {
  readonly rootIndex: number;
  readonly depth: number;
  readonly direction: 'incoming' | 'outgoing' | 'both';
  readonly minSynapses: number;
  readonly topN: number;
  readonly outgoing: Csr;
  readonly incoming: Csr;
}

export interface TraversalResult {
  readonly edges: TraversalEdge[];
  readonly nodesByDepth: Record<number, number[]>;
  readonly truncated: boolean;
  readonly truncationReason?: string;
  readonly visitedCount: number;
}

export function neighbours(
  csr: Csr,
  node: number,
  minSynapses: number,
  topN: number,
): Array<{ target: number; weight: number }> {
  if (node < 0 || node + 1 >= csr.offsets.length) return [];
  const start = csr.offsets[node];
  const end = csr.offsets[node + 1];
  const out: Array<{ target: number; weight: number }> = [];
  for (let i = start; i < end; i++) {
    const weight = csr.weights[i];
    if (weight < minSynapses) continue;
    out.push({ target: csr.targets[i], weight });
  }
  // Rank by strength, so truncation drops the weakest partners rather than an
  // arbitrary slice.
  out.sort((a, b) => b.weight - a.weight);
  return topN > 0 ? out.slice(0, topN) : out;
}

export function traverseGraph(options: TraversalOptions): TraversalResult {
  const depth = Math.min(Math.max(1, options.depth), TRAVERSAL_LIMITS.maxDepth);
  const topN = Math.min(
    options.topN > 0 ? options.topN : TRAVERSAL_LIMITS.maxPartnersPerHop,
    TRAVERSAL_LIMITS.maxPartnersPerHop,
  );

  const edges: TraversalEdge[] = [];
  const nodesByDepth: Record<number, number[]> = { 0: [options.rootIndex] };
  const visited = new Set<number>([options.rootIndex]);
  let frontier = [options.rootIndex];
  let truncated = false;
  let truncationReason: string | undefined;

  const directions: Array<'incoming' | 'outgoing'> =
    options.direction === 'both' ? ['incoming', 'outgoing'] : [options.direction];

  for (let d = 1; d <= depth; d++) {
    const nextFrontier: number[] = [];
    const levelNodes: number[] = [];

    outer: for (const node of frontier) {
      for (const dir of directions) {
        const csr = dir === 'outgoing' ? options.outgoing : options.incoming;
        for (const { target, weight } of neighbours(csr, node, options.minSynapses, topN)) {
          edges.push({
            source: dir === 'outgoing' ? node : target,
            target: dir === 'outgoing' ? target : node,
            synapseCount: weight,
            direction: dir,
            depth: d,
          });
          if (!visited.has(target)) {
            visited.add(target);
            nextFrontier.push(target);
            levelNodes.push(target);
          }
          if (visited.size >= TRAVERSAL_LIMITS.maxTotalNodes) {
            truncated = true;
            truncationReason = `Traversal stopped at ${TRAVERSAL_LIMITS.maxTotalNodes} nodes. Reduce depth or raise the minimum synapse count.`;
            break outer;
          }
        }
      }
    }

    nodesByDepth[d] = levelNodes;
    frontier = nextFrontier;
    if (truncated || frontier.length === 0) break;
  }

  return {
    edges,
    nodesByDepth,
    truncated,
    truncationReason,
    visitedCount: visited.size,
  };
}

/**
 * Estimates how many nodes a traversal would touch, so the UI can warn before
 * running an expensive query instead of after.
 */
export function estimateTraversalSize(
  averageDegree: number,
  depth: number,
  topN: number,
): number {
  const branching = Math.min(averageDegree, topN);
  let total = 1;
  let level = 1;
  for (let d = 0; d < depth; d++) {
    level *= branching;
    total += level;
    if (total > TRAVERSAL_LIMITS.maxTotalNodes) return TRAVERSAL_LIMITS.maxTotalNodes;
  }
  return Math.round(total);
}
