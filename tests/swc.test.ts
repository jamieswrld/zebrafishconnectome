import { describe, expect, it } from 'vitest';
import { parseSwc, toSwc } from '@/core/swc';
import { DataError } from '@/core/errors';

/**
 * SWC parsing feeds morphology rendering and the download endpoint. Getting
 * parent resolution wrong produces a neuron with the wrong branching structure,
 * which looks fine and is false.
 */

const SIMPLE = `# a comment
# another comment
1 1 0 0 0 5000 -1
2 2 1000 0 0 500 1
3 2 2000 0 0 400 2
4 3 1000 1000 0 300 1
`;

describe('parseSwc', () => {
  it('parses vertices and converts nanometres to micrometres by default', () => {
    const parsed = parseSwc(SIMPLE);
    expect(parsed.vertexCount).toBe(4);
    // 1000 nm = 1 um.
    expect(parsed.vertices[3]).toBeCloseTo(1, 6);
    expect(parsed.radii[0]).toBeCloseTo(5, 6);
  });

  it('resolves parents to row indices, not raw SWC ids', () => {
    const parsed = parseSwc(SIMPLE);
    expect(Array.from(parsed.parents)).toEqual([-1, 0, 1, 0]);
  });

  it('keeps SWC structure identifiers', () => {
    const parsed = parseSwc(SIMPLE);
    expect(Array.from(parsed.compartments)).toEqual([1, 2, 2, 3]);
  });

  it('honours an explicit unit scale', () => {
    const parsed = parseSwc(SIMPLE, { scaleToUm: 1 });
    expect(parsed.vertices[3]).toBeCloseTo(1000, 6);
  });

  it('handles parents that appear after their children', () => {
    const outOfOrder = `3 2 2000 0 0 1 1
1 1 0 0 0 1 -1
`;
    const parsed = parseSwc(outOfOrder);
    // Row 0 is SWC id 3, whose parent is SWC id 1, which is row 1.
    expect(Array.from(parsed.parents)).toEqual([1, -1]);
  });

  it('keeps a vertex whose parent is missing, and counts it', () => {
    const dangling = `1 1 0 0 0 1 -1
2 2 1000 0 0 1 77
`;
    const parsed = parseSwc(dangling);
    // Dropping it would silently change the morphology.
    expect(parsed.vertexCount).toBe(2);
    expect(parsed.parents[1]).toBe(-1);
    expect(parsed.danglingParents).toBe(1);
  });

  it('ignores comments, blank lines and short rows', () => {
    const messy = `# header

1 1 0 0 0 1 -1

garbage row
2 2 1 1 1 1 1
`;
    expect(parseSwc(messy).vertexCount).toBe(2);
  });

  it('throws when there are no vertices at all', () => {
    expect(() => parseSwc('# only a comment\n')).toThrow(DataError);
    expect(() => parseSwc('')).toThrow(/no vertices/i);
  });

  it('refuses a skeleton beyond the vertex cap', () => {
    const rows = Array.from({ length: 12 }, (_, i) => `${i + 1} 2 ${i} 0 0 1 ${i || -1}`);
    expect(() => parseSwc(rows.join('\n'), { maxVertices: 5 })).toThrow(/exceeds 5 vertices/);
  });
});

describe('toSwc', () => {
  it('round-trips structure through serialisation', () => {
    const parsed = parseSwc(SIMPLE);
    const text = toSwc(parsed, ['test export']);
    const reparsed = parseSwc(text, { scaleToUm: 1 });

    expect(reparsed.vertexCount).toBe(parsed.vertexCount);
    expect(Array.from(reparsed.parents)).toEqual(Array.from(parsed.parents));
    expect(Array.from(reparsed.compartments)).toEqual(Array.from(parsed.compartments));
    for (let i = 0; i < parsed.vertices.length; i++) {
      expect(reparsed.vertices[i]).toBeCloseTo(parsed.vertices[i], 3);
    }
  });

  it('emits 1-based ids and -1 for roots', () => {
    const text = toSwc(parseSwc(SIMPLE));
    const lines = text.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(lines[0].split(' ')[0]).toBe('1');
    expect(lines[0].split(' ')[6]).toBe('-1');
    expect(lines[1].split(' ')[6]).toBe('1');
  });

  it('writes header comments', () => {
    const text = toSwc(parseSwc(SIMPLE), ['Fish1 lore 173502']);
    expect(text.startsWith('# Fish1 lore 173502')).toBe(true);
  });
});
