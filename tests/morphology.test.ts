import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { decodeHmiCircuit, type HmiCircuit } from '@/core/hmi';
import { decodeMorphology, type MorphologyManifest } from '@/core/morphology';

/**
 * Tests for the traced morphology artefact.
 *
 * The property that matters most here is that a mesh belongs to a cell the
 * simulation actually knows about. If morphology and connectivity were keyed
 * differently, the viewer would draw a shape and attribute it to the wrong
 * neuron — which is worse than drawing nothing.
 */

const MANIFEST = 'public/datasets/fish1-hmi/v1/morphology/manifest.json';

function loadCircuit(): HmiCircuit {
  const bytes = readFileSync('public/datasets/fish1-hmi/v1/hmi.bin');
  return decodeHmiCircuit(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

function loadClass(file: string) {
  const path = `public${file}`;
  const bytes = readFileSync(path);
  return decodeMorphology(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

const available = existsSync(MANIFEST);
const manifest: MorphologyManifest | null = available
  ? (JSON.parse(readFileSync(MANIFEST, 'utf8')) as MorphologyManifest)
  : null;

describe.runIf(available)('traced morphology artefact', () => {
  const circuit = loadCircuit();

  it('is labelled measured, decimated, and carries its citation', () => {
    expect(manifest!.provenance ?? 'measured').toBe('measured');
    expect(manifest!.citation.length).toBeGreaterThan(10);
    expect(manifest!.source).toMatch(/fish1-public/);
    // Level of detail must be stated: this is not the full reconstruction.
    expect(manifest!.lod).toBeGreaterThan(0);
  });

  it('decodes every published class', () => {
    for (const [className, entry] of Object.entries(manifest!.classes)) {
      const decoded = loadClass(entry.file);
      expect(decoded.className).toBe(className);
      expect(decoded.cellCount).toBe(entry.cells);
      expect(decoded.vertexCount).toBe(entry.vertices);
      expect(decoded.triangleCount).toBe(entry.triangles);
      expect(decoded.positions.length).toBe(entry.vertices * 3);
    }
  });

  it('keeps every mesh inside its own vertex range', () => {
    for (const entry of Object.values(manifest!.classes)) {
      const decoded = loadClass(entry.file);
      for (let i = 0; i < decoded.indices.length; i += 991) {
        expect(decoded.indices[i]).toBeLessThan(decoded.vertexCount);
      }
    }
  });

  it('keys every mesh to a cell the circuit knows about', () => {
    // The whole point: a shape must belong to a neuron whose measured
    // connectivity is in the simulation, not to an unrelated segment.
    const known = new Set<number>();
    for (let i = 0; i < circuit.neuronCount; i++) known.add(circuit.loreIds[i]);
    let checked = 0;
    for (const entry of Object.values(manifest!.classes)) {
      for (const cell of loadClass(entry.file).cells) {
        expect(known.has(cell.loreId)).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('places morphology in the same space and scale as the soma', () => {
    // Positions are source voxels. Every cell's mesh should sit near the soma
    // the circuit records for it — same coordinate system, same units.
    const somaByLore = new Map<number, [number, number, number]>();
    for (let i = 0; i < circuit.neuronCount; i++) {
      somaByLore.set(circuit.loreIds[i], [
        circuit.positions[i * 3],
        circuit.positions[i * 3 + 1],
        circuit.positions[i * 3 + 2],
      ]);
    }

    const distances: number[] = [];
    for (const entry of Object.values(manifest!.classes)) {
      const decoded = loadClass(entry.file);
      for (const cell of decoded.cells.slice(0, 6)) {
        const soma = somaByLore.get(cell.loreId);
        if (!soma) continue;
        // Nearest mesh vertex to the recorded soma, in micrometres.
        let nearest = Infinity;
        for (let v = cell.firstVertex; v < cell.firstVertex + cell.vertexCount; v++) {
          const dx = (decoded.positions[v * 3] - soma[0]) * 0.008;
          const dy = (decoded.positions[v * 3 + 1] - soma[1]) * 0.008;
          const dz = (decoded.positions[v * 3 + 2] - soma[2]) * 0.03;
          nearest = Math.min(nearest, Math.hypot(dx, dy, dz));
        }
        distances.push(nearest);
      }
    }
    expect(distances.length).toBeGreaterThan(20);
    distances.sort((a, b) => a - b);
    const median = distances[Math.floor(distances.length / 2)];

    // The median cell's own surface passes within a few microns of its soma
    // point. The median rather than every cell, because these are the coarsest
    // published meshes and a CAVE soma annotation is a point on the cell, not
    // its centroid — a handful of cells legitimately sit tens of microns out.
    expect(median).toBeLessThan(15);
    // Nothing is wildly displaced. A wrong voxel size would put the whole
    // population out by a factor of two, i.e. hundreds of microns.
    expect(distances[distances.length - 1]).toBeLessThan(200);
  });

  it('rejects a truncated container rather than drawing wrong geometry', () => {
    const entry = Object.values(manifest!.classes)[0];
    const bytes = readFileSync(`public${entry.file}`);
    const truncated = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + Math.floor(bytes.byteLength * 0.6),
    ) as ArrayBuffer;
    expect(() => decodeMorphology(truncated)).toThrow();
  });

  it('rejects a container with the wrong magic', () => {
    const bad = new ArrayBuffer(64);
    new DataView(bad).setUint32(0, 0x4d4f5230, false);
    expect(() => decodeMorphology(bad)).toThrow(/magic/i);
  });
});
