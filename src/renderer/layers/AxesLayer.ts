import type { Bounds3 } from '@/core/coords';
import type { ConnectionLineSet } from '../types';

/**
 * Orientation reference.
 *
 * Draws the axis-aligned bounding box of the loaded population plus a small
 * axis triad. This is deliberately geometric rather than anatomical: we do not
 * draw invented "brain region" shells. Anatomical labels are attached by the UI
 * only when the dataset documents its axis orientation.
 */
export class AxesLayer {
  private lines: ConnectionLineSet | null = null;

  build(
    bounds: Bounds3,
    options?: { boxAlpha?: number; triadLength?: number },
  ): ConnectionLineSet {
    const boxAlpha = options?.boxAlpha ?? 0.09;
    const [minX, minY, minZ] = bounds.min;
    const [maxX, maxY, maxZ] = bounds.max;

    const corners: [number, number, number][] = [
      [minX, minY, minZ],
      [maxX, minY, minZ],
      [maxX, maxY, minZ],
      [minX, maxY, minZ],
      [minX, minY, maxZ],
      [maxX, minY, maxZ],
      [maxX, maxY, maxZ],
      [minX, maxY, maxZ],
    ];
    const boxEdges: [number, number][] = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
      [4, 5],
      [5, 6],
      [6, 7],
      [7, 4],
      [0, 4],
      [1, 5],
      [2, 6],
      [3, 7],
    ];

    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
    const triadLength = options?.triadLength ?? span * 0.16;
    const origin: [number, number, number] = [minX, minY, minZ];
    const triad: Array<{ to: [number, number, number]; color: [number, number, number] }> = [
      { to: [origin[0] + triadLength, origin[1], origin[2]], color: [0.85, 0.35, 0.35] },
      { to: [origin[0], origin[1] + triadLength, origin[2]], color: [0.45, 0.8, 0.45] },
      { to: [origin[0], origin[1], origin[2] + triadLength], color: [0.42, 0.6, 0.9] },
    ];

    const segmentCount = boxEdges.length + triad.length;
    const positions = new Float32Array(segmentCount * 6);
    const colors = new Float32Array(segmentCount * 8);

    let s = 0;
    for (const [a, b] of boxEdges) {
      writeSegment(positions, colors, s, corners[a], corners[b], [0.55, 0.6, 0.68], boxAlpha);
      s++;
    }
    for (const axis of triad) {
      writeSegment(positions, colors, s, origin, axis.to, axis.color, 0.55);
      s++;
    }

    this.lines = { segmentCount, positions, colors };
    return this.lines;
  }

  current(): ConnectionLineSet | null {
    return this.lines;
  }

  clear(): void {
    this.lines = null;
  }
}

function writeSegment(
  positions: Float32Array,
  colors: Float32Array,
  segment: number,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  rgb: readonly [number, number, number],
  alpha: number,
): void {
  const p = segment * 6;
  positions[p] = a[0];
  positions[p + 1] = a[1];
  positions[p + 2] = a[2];
  positions[p + 3] = b[0];
  positions[p + 4] = b[1];
  positions[p + 5] = b[2];
  const c = segment * 8;
  for (let end = 0; end < 2; end++) {
    colors[c + end * 4] = rgb[0];
    colors[c + end * 4 + 1] = rgb[1];
    colors[c + end * 4 + 2] = rgb[2];
    colors[c + end * 4 + 3] = alpha;
  }
}
