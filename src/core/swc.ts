import { DataError } from './errors';

/**
 * SWC morphology parsing.
 *
 * SWC is the lingua franca for neuron skeletons (NEURON, navis, neuromorpho).
 * Each non-comment line is:
 *
 *   id  type  x  y  z  radius  parent
 *
 * IDs are 1-based and parents may appear after their children, so the parser
 * builds an explicit id -> row-index map rather than assuming order. Parents are
 * emitted as row indices, which is what the renderer needs and what avoids a
 * second lookup per vertex when drawing.
 *
 * Coordinates arrive in the source's own units. CAVE skeleton services emit
 * nanometres; `scaleToUm` converts, and the default of 1/1000 reflects that.
 * The caller states the unit rather than the parser guessing.
 */

export interface ParsedSwc {
  readonly vertexCount: number;
  /** Interleaved xyz. */
  readonly vertices: Float32Array;
  /** Row index of each vertex's parent; -1 for roots. */
  readonly parents: Int32Array;
  readonly radii: Float32Array;
  /** SWC structure identifier: 0 undefined, 1 soma, 2 axon, 3/4 dendrite, ... */
  readonly compartments: Uint8Array;
  /** Vertices whose declared parent id was not present in the file. */
  readonly danglingParents: number;
}

export interface ParseSwcOptions {
  /** Multiplier from source units to micrometres. Default assumes nanometres. */
  readonly scaleToUm?: number;
  readonly maxVertices?: number;
}

export function parseSwc(text: string, options: ParseSwcOptions = {}): ParsedSwc {
  const scale = options.scaleToUm ?? 1 / 1000;
  const maxVertices = options.maxVertices ?? 2_000_000;

  const lines = text.split('\n');
  const ids: number[] = [];
  const parentIds: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const rs: number[] = [];
  const types: number[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 7) continue;

    const id = Number(parts[0]);
    const type = Number(parts[1]);
    const x = Number(parts[2]);
    const y = Number(parts[3]);
    const z = Number(parts[4]);
    const radius = Number(parts[5]);
    const parent = Number(parts[6]);

    if (
      !Number.isFinite(id) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(z)
    ) {
      continue;
    }
    if (ids.length >= maxVertices) {
      throw new DataError({
        code: 'query_too_large',
        message: `Skeleton exceeds ${maxVertices} vertices.`,
      });
    }

    ids.push(id);
    types.push(Number.isFinite(type) ? type : 0);
    xs.push(x * scale);
    ys.push(y * scale);
    zs.push(z * scale);
    rs.push(Number.isFinite(radius) ? radius * scale : 0);
    parentIds.push(Number.isFinite(parent) ? parent : -1);
  }

  const n = ids.length;
  if (n === 0) {
    throw new DataError({
      code: 'skeleton_unavailable',
      message: 'The SWC file contained no vertices.',
    });
  }

  const idToRow = new Map<number, number>();
  for (let i = 0; i < n; i++) idToRow.set(ids[i], i);

  const vertices = new Float32Array(n * 3);
  const parents = new Int32Array(n);
  const radii = new Float32Array(n);
  const compartments = new Uint8Array(n);
  let danglingParents = 0;

  for (let i = 0; i < n; i++) {
    vertices[i * 3] = xs[i];
    vertices[i * 3 + 1] = ys[i];
    vertices[i * 3 + 2] = zs[i];
    radii[i] = rs[i];
    compartments[i] = Math.min(Math.max(types[i], 0), 255);

    const parentId = parentIds[i];
    if (parentId < 0) {
      parents[i] = -1;
    } else {
      const row = idToRow.get(parentId);
      if (row === undefined) {
        // Keep the vertex but mark it as a root; dropping it would silently
        // change the morphology.
        parents[i] = -1;
        danglingParents++;
      } else {
        parents[i] = row;
      }
    }
  }

  return { vertexCount: n, vertices, parents, radii, compartments, danglingParents };
}

/** Serialises back to SWC, for the download endpoint. */
export function toSwc(
  skeleton: Pick<ParsedSwc, 'vertexCount' | 'vertices' | 'parents' | 'radii' | 'compartments'>,
  header: string[] = [],
): string {
  const out: string[] = header.map((h) => `# ${h}`);
  for (let i = 0; i < skeleton.vertexCount; i++) {
    const parent = skeleton.parents[i];
    out.push(
      [
        i + 1,
        skeleton.compartments[i],
        skeleton.vertices[i * 3].toFixed(4),
        skeleton.vertices[i * 3 + 1].toFixed(4),
        skeleton.vertices[i * 3 + 2].toFixed(4),
        skeleton.radii[i].toFixed(4),
        parent < 0 ? -1 : parent + 1,
      ].join(' '),
    );
  }
  return out.join('\n');
}
