import { micrometresToWorld } from '@/core/coords';
import type { NeuronIndex } from '@/core/types';
import {
  SOMA_STATE,
  SOMA_STRIDE_BYTES,
  packSomaAttributes,
  type SomaBufferSet,
} from '../types';

/**
 * Owns the GPU-side representation of the whole soma population.
 *
 * Everything here is a TypedArray. There is no per-neuron object, and nothing in
 * this class scales with the number of React components on screen - only with
 * the number of neurons, once, at load.
 */
export class SomaLayer {
  count = 0;

  /** Interleaved static attributes, uploaded once per dataset. */
  staticData: ArrayBuffer = new ArrayBuffer(0);
  /** Per-neuron {@link SOMA_STATE} bits. Small and re-uploaded on change. */
  state: Uint8Array = new Uint8Array(0);
  /** Per-neuron activity scalar; stays zero until a functional source drives it. */
  activity: Float32Array = new Float32Array(0);

  /**
   * World-space positions kept CPU-side too, because connection geometry,
   * camera framing and bounds all need them and reading back from the GPU
   * would stall the pipeline.
   */
  worldPositions: Float32Array = new Float32Array(0);

  /** Index -> lore ID, for resolving a pick back to a stable identifier. */
  loreIds: Uint32Array = new Uint32Array(0);

  private stateDirty = false;
  private activityDirty = false;

  build(index: NeuronIndex): SomaBufferSet {
    const { count } = index;
    this.count = count;

    this.staticData = new ArrayBuffer(count * SOMA_STRIDE_BYTES);
    const f32 = new Float32Array(this.staticData);
    const u32 = new Uint32Array(this.staticData);
    this.worldPositions = new Float32Array(count * 3);

    const t = index.renderTransform;
    for (let i = 0; i < count; i++) {
      const world = micrometresToWorld(
        [index.positionsUm[i * 3], index.positionsUm[i * 3 + 1], index.positionsUm[i * 3 + 2]],
        t,
      );
      const base = i * 4;
      f32[base] = world[0];
      f32[base + 1] = world[1];
      f32[base + 2] = world[2];
      u32[base + 3] = packSomaAttributes(
        index.cellTypes[i],
        index.flags[i],
        index.regionIds[i],
      );
      this.worldPositions[i * 3] = world[0];
      this.worldPositions[i * 3 + 1] = world[1];
      this.worldPositions[i * 3 + 2] = world[2];
    }

    this.state = new Uint8Array(count).fill(SOMA_STATE.VISIBLE);
    this.activity = new Float32Array(count);
    this.loreIds = index.loreIds;
    this.stateDirty = true;
    this.activityDirty = true;

    return { count, staticData: this.staticData, state: this.state, activity: this.activity };
  }

  /**
   * Applies a filter result. `mask[i] !== 0` means the neuron passes.
   * Only the VISIBLE bit is touched, so selection and circuit membership
   * survive a filter change.
   */
  applyVisibilityMask(mask: Uint8Array): void {
    const n = Math.min(mask.length, this.count);
    for (let i = 0; i < n; i++) {
      if (mask[i]) this.state[i] |= SOMA_STATE.VISIBLE;
      else this.state[i] &= ~SOMA_STATE.VISIBLE;
    }
    this.stateDirty = true;
  }

  private clearBit(bit: number): void {
    const inverse = ~bit & 0xff;
    for (let i = 0; i < this.count; i++) this.state[i] &= inverse;
  }

  setSelected(index: number): void {
    this.clearBit(SOMA_STATE.SELECTED);
    if (index >= 0 && index < this.count) this.state[index] |= SOMA_STATE.SELECTED;
    this.stateDirty = true;
  }

  setHovered(index: number): void {
    this.clearBit(SOMA_STATE.HOVERED);
    if (index >= 0 && index < this.count) this.state[index] |= SOMA_STATE.HOVERED;
    this.stateDirty = true;
  }

  /**
   * Marks circuit membership. `inputs` and `outputs` are neuron indices; a
   * neuron appearing in both keeps only the input colour, which is the
   * convention used by the inspector legend.
   */
  setCircuit(inputs: Int32Array | null, outputs: Int32Array | null): void {
    const inverse =
      ~(SOMA_STATE.IN_CIRCUIT | SOMA_STATE.CIRCUIT_INPUT | SOMA_STATE.CIRCUIT_OUTPUT) & 0xff;
    for (let i = 0; i < this.count; i++) this.state[i] &= inverse;
    if (outputs) {
      for (const idx of outputs) {
        if (idx >= 0 && idx < this.count) {
          this.state[idx] |= SOMA_STATE.IN_CIRCUIT | SOMA_STATE.CIRCUIT_OUTPUT;
        }
      }
    }
    if (inputs) {
      for (const idx of inputs) {
        if (idx >= 0 && idx < this.count) {
          this.state[idx] =
            (this.state[idx] & ~SOMA_STATE.CIRCUIT_OUTPUT) |
            SOMA_STATE.IN_CIRCUIT |
            SOMA_STATE.CIRCUIT_INPUT;
        }
      }
    }
    this.stateDirty = true;
  }

  setActivity(values: Float32Array): void {
    this.activity.set(values.subarray(0, Math.min(values.length, this.count)));
    this.activityDirty = true;
  }

  worldPositionOf(index: number): [number, number, number] | null {
    if (index < 0 || index >= this.count) return null;
    return [
      this.worldPositions[index * 3],
      this.worldPositions[index * 3 + 1],
      this.worldPositions[index * 3 + 2],
    ];
  }

  visibleCount(): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.state[i] & SOMA_STATE.VISIBLE) n++;
    }
    return n;
  }

  consumeStateDirty(): boolean {
    const dirty = this.stateDirty;
    this.stateDirty = false;
    return dirty;
  }

  consumeActivityDirty(): boolean {
    const dirty = this.activityDirty;
    this.activityDirty = false;
    return dirty;
  }
}
