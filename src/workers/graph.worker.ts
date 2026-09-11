/// <reference lib="webworker" />
import { traverseGraph, type TraversalEdge } from '@/core/traversal';

/**
 * Graph traversal, off the main thread.
 *
 * Depth-2 and depth-3 expansions in a dense connectome grow fast enough to
 * freeze a tab. Running here keeps the viewport interactive; the traversal
 * itself lives in src/core/traversal.ts so it can be tested directly, and this
 * file is only the message boundary.
 */

export interface TraverseRequest {
  readonly type: 'traverse';
  readonly requestId: number;
  readonly rootIndex: number;
  readonly depth: number;
  readonly direction: 'incoming' | 'outgoing' | 'both';
  readonly minSynapses: number;
  readonly topN: number;
  /**
   * Flattened CSR adjacency supplied by the caller, so the same traversal code
   * serves synthetic data and a real pipeline export.
   */
  readonly outgoingOffsets: Uint32Array;
  readonly outgoingTargets: Uint32Array;
  readonly outgoingWeights: Uint32Array;
  readonly incomingOffsets: Uint32Array;
  readonly incomingTargets: Uint32Array;
  readonly incomingWeights: Uint32Array;
}

export interface TraverseResponse {
  readonly type: 'traversed';
  readonly requestId: number;
  readonly edges: TraversalEdge[];
  readonly nodesByDepth: Record<number, number[]>;
  readonly truncated: boolean;
  readonly truncationReason?: string;
  readonly visitedCount: number;
  readonly elapsedMs: number;
}

export interface GraphWorkerError {
  readonly type: 'error';
  readonly requestId: number;
  readonly message: string;
}

export type GraphWorkerRequest = TraverseRequest;
export type GraphWorkerResponse = TraverseResponse | GraphWorkerError;

self.onmessage = (event: MessageEvent<GraphWorkerRequest>) => {
  const request = event.data;
  if (request.type !== 'traverse') return;

  try {
    const started = performance.now();
    const result = traverseGraph({
      rootIndex: request.rootIndex,
      depth: request.depth,
      direction: request.direction,
      minSynapses: request.minSynapses,
      topN: request.topN,
      outgoing: {
        offsets: request.outgoingOffsets,
        targets: request.outgoingTargets,
        weights: request.outgoingWeights,
      },
      incoming: {
        offsets: request.incomingOffsets,
        targets: request.incomingTargets,
        weights: request.incomingWeights,
      },
    });

    const response: TraverseResponse = {
      type: 'traversed',
      requestId: request.requestId,
      edges: result.edges,
      nodesByDepth: result.nodesByDepth,
      truncated: result.truncated,
      truncationReason: result.truncationReason,
      visitedCount: result.visitedCount,
      elapsedMs: performance.now() - started,
    };
    (self as unknown as Worker).postMessage(response);
  } catch (e) {
    const error: GraphWorkerError = {
      type: 'error',
      requestId: request.requestId,
      message: e instanceof Error ? e.message : String(e),
    };
    (self as unknown as Worker).postMessage(error);
  }
};
