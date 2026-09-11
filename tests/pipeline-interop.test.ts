import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeNeuronIndex } from '@/core/binary';
import { CELL_TYPE_CODE } from '@/core/types';

/**
 * Cross-language contract test.
 *
 * The Python pipeline writes the binary the browser reads. Those are two
 * independent implementations of the same format, in two languages, with
 * different endianness defaults and alignment rules. Without this test, a
 * divergence between them would only ever show up as a subtly wrong brain.
 *
 * The Python writer is exercised directly and the result is decoded by the
 * production TypeScript decoder.
 */

function python(): string | null {
  for (const candidate of ['python', 'python3', 'py']) {
    try {
      execFileSync(candidate, ['-c', 'import numpy'], { stdio: 'ignore' });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

const interpreter = python();

describe.skipIf(!interpreter)('python writer -> typescript decoder', () => {
  it('produces a container the browser decoder accepts verbatim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cl-interop-'));
    try {
      const script = join(dir, 'emit.py');
      const outPath = join(dir, 'neurons.bin').replace(/\\/g, '/');

      writeFileSync(
        script,
        `
import sys, numpy as np
sys.path.insert(0, ${JSON.stringify(process.cwd().replace(/\\/g, '/') + '/pipeline')})
from fish1.neuron_index import build_neuron_index, validate_container

count = 7
positions = np.zeros((count, 3), dtype=np.int32)
for i in range(count):
    positions[i] = (1000 + i * 37, 2000 + i * 11, 300 + i)

lore = np.arange(170000, 170000 + count, dtype=np.uint32)
types = np.array([1 if i % 2 == 0 else 2 for i in range(count)], dtype=np.uint8)
regions = np.full(count, 0xFFFF, dtype=np.uint16)
flags = np.full(count, 4, dtype=np.uint8)
roots = np.array([864691128630286274 + i for i in range(count)], dtype=np.uint64)

data = build_neuron_index(
    dataset_id="fish1",
    origin="preprocessed-export",
    count=count,
    version={"materializationVersion": 574, "segmentationTable": "fish1_v250915", "label": "mat 574"},
    voxel_space={"voxelSizeNm": [16, 16, 30], "axisOrder": "xyz"},
    position_provenance="measured",
    regions=[],
    positions_voxel=positions,
    lore_ids=lore,
    cell_types=types,
    region_ids=regions,
    flags=flags,
    root_ids=roots,
)
validate_container(data)
open(${JSON.stringify(outPath)}, "wb").write(data)
print("ok")
`,
        'utf-8',
      );

      execFileSync(interpreter!, [script], { stdio: 'pipe' });

      const bytes = readFileSync(outPath);
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;

      const index = decodeNeuronIndex(buffer);

      expect(index.count).toBe(7);
      expect(index.datasetId).toBe('fish1');
      expect(index.origin).toBe('preprocessed-export');
      expect(index.version.materializationVersion).toBe(574);
      expect(index.version.segmentationTable).toBe('fish1_v250915');
      expect(index.positionProvenance).toBe('measured');

      // Source coordinates survive the language boundary exactly.
      expect(Array.from(index.positionsVoxel.slice(0, 3))).toEqual([1000, 2000, 300]);
      expect(Array.from(index.loreIds.slice(0, 3))).toEqual([170000, 170001, 170002]);
      expect(index.cellTypes[0]).toBe(CELL_TYPE_CODE.excitatory);
      expect(index.cellTypes[1]).toBe(CELL_TYPE_CODE.inhibitory);

      // 64-bit root IDs cross the boundary without precision loss.
      expect(index.rootIds?.[0]).toBe(864691128630286274n);
      expect(index.rootIds?.[6]).toBe(864691128630286280n);

      // Micrometre derivation matches the voxel size declared by Python.
      expect(index.positionsUm[0]).toBeCloseTo(16, 4);
      expect(index.positionsUm[2]).toBeCloseTo(9, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

if (!interpreter) {
  describe('python writer -> typescript decoder', () => {
    it.skip('skipped: no Python with numpy on PATH', () => {});
  });
}
