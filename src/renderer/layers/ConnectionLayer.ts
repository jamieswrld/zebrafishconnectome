import type { ConnectionLineSet } from '../types';
import { COLOR_CIRCUIT_IN, COLOR_CIRCUIT_OUT } from '../backends/palette';

/**
 * Builds the geometry for locally displayed connectivity.
 *
 * This layer NEVER draws the full synapse population. Fish1 has roughly 30
 * million synapses; rendering them all would be both meaningless to look at and
 * pointless to compute. Only edges belonging to the current selection - already
 * filtered, ranked and capped upstream - reach here.
 *
 * Edges are straight segments between soma. That is an abstraction, not
 * anatomy: the real axon takes a path through the neuropil that only the
 * skeleton layer can show. The UI labels this view accordingly.
 */

export interface CircuitEdgeInput {
  /** Index of the source neuron in the loaded population. */
  readonly sourceIndex: number;
  readonly targetIndex: number;
  /** 'incoming' edges point into the selected cell. */
  readonly direction: 'incoming' | 'outgoing';
  readonly synapseCount: number;
  readonly depth: number;
}

export interface BuildEdgesOptions {
  /** Strongest connection in the set, used to normalise opacity. */
  readonly maxSynapseCount: number;
  /** Base opacity for the strongest edge. */
  readonly maxAlpha?: number;
  readonly minAlpha?: number;
}

export class ConnectionLayer {
  private lines: ConnectionLineSet | null = null;

  /**
   * @param worldPositions Interleaved xyz world positions of every neuron.
   */
  build(
    edges: readonly CircuitEdgeInput[],
    worldPositions: Float32Array,
    options: BuildEdgesOptions,
  ): ConnectionLineSet | null {
    if (edges.length === 0) {
      this.lines = null;
      return null;
    }

    const positions = new Float32Array(edges.length * 6);
    const colors = new Float32Array(edges.length * 8);
    const maxAlpha = options.maxAlpha ?? 0.75;
    const minAlpha = options.minAlpha ?? 0.14;
    const maxCount = Math.max(1, options.maxSynapseCount);

    let written = 0;
    for (const edge of edges) {
      const s = edge.sourceIndex;
      const t = edge.targetIndex;
      if (s < 0 || t < 0) continue;
      if (s * 3 + 2 >= worldPositions.length || t * 3 + 2 >= worldPositions.length) continue;

      const p = written * 6;
      positions[p] = worldPositions[s * 3];
      positions[p + 1] = worldPositions[s * 3 + 1];
      positions[p + 2] = worldPositions[s * 3 + 2];
      positions[p + 3] = worldPositions[t * 3];
      positions[p + 4] = worldPositions[t * 3 + 1];
      positions[p + 5] = worldPositions[t * 3 + 2];

      const rgb = edge.direction === 'incoming' ? COLOR_CIRCUIT_IN : COLOR_CIRCUIT_OUT;
      // Opacity encodes synapse count on a square-root scale: linear scaling
      // makes everything but the single strongest partner invisible.
      const strength = Math.sqrt(edge.synapseCount / maxCount);
      const depthFade = Math.pow(0.6, Math.max(0, edge.depth - 1));
      const alpha = (minAlpha + (maxAlpha - minAlpha) * strength) * depthFade;

      const c = written * 8;
      for (let end = 0; end < 2; end++) {
        // Fade toward the partner end so direction is readable without arrows.
        const endAlpha =
          edge.direction === 'incoming'
            ? end === 0
              ? alpha * 0.35
              : alpha
            : end === 0
              ? alpha
              : alpha * 0.35;
        colors[c + end * 4] = rgb[0];
        colors[c + end * 4 + 1] = rgb[1];
        colors[c + end * 4 + 2] = rgb[2];
        colors[c + end * 4 + 3] = endAlpha;
      }
      written++;
    }

    if (written === 0) {
      this.lines = null;
      return null;
    }

    this.lines = {
      segmentCount: written,
      positions: positions.subarray(0, written * 6),
      colors: colors.subarray(0, written * 8),
    };
    return this.lines;
  }

  clear(): void {
    this.lines = null;
  }

  current(): ConnectionLineSet | null {
    return this.lines;
  }
}

/** Concatenates several line sets into one upload. */
export function mergeLineSets(
  sets: readonly (ConnectionLineSet | null)[],
): ConnectionLineSet | null {
  const present = sets.filter((s): s is ConnectionLineSet => s !== null && s.segmentCount > 0);
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];

  const total = present.reduce((n, s) => n + s.segmentCount, 0);
  const positions = new Float32Array(total * 6);
  const colors = new Float32Array(total * 8);
  let posOffset = 0;
  let colOffset = 0;
  for (const s of present) {
    positions.set(s.positions, posOffset);
    colors.set(s.colors, colOffset);
    posOffset += s.segmentCount * 6;
    colOffset += s.segmentCount * 8;
  }
  return { segmentCount: total, positions, colors };
}
