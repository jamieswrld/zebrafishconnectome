import type { NeuralMotorIntent } from './types';

/**
 * Bounded experiment traces.
 *
 * Fixed-capacity Float32Array tracks, so a run that lasts minutes cannot grow
 * memory without limit and the timeline can be scrubbed without re-running the
 * model. This is deliberately NOT the event log: per-step state at 50 Hz across
 * eight tracks would bury the event feed, so high-rate numeric state lives here
 * and the event log keeps only meaningful events.
 */

/**
 * Target sampling rate of the trace, Hz.
 *
 * The model steps at 200 Hz but a sample can only be taken when the host loop
 * reads state, so the achieved rate is min(TRACE_HZ, frame rate). At 60 fps
 * that is the full 50 Hz; on a throttled tab it degrades gracefully rather than
 * distorting the recorded times, because every sample stores its own timestamp.
 */
export const TRACE_HZ = 50;

/** Capacity, in samples. 60 s at 50 Hz. */
export const TRACE_CAPACITY = TRACE_HZ * 60;

export interface TraceTracks {
  readonly time: Float32Array;
  /** Signed stimulus evidence: negative leftward, positive rightward. */
  readonly stimulus: Float32Array;
  readonly classILeft: Float32Array;
  readonly classIRight: Float32Array;
  readonly classIILeft: Float32Array;
  readonly classIIRight: Float32Array;
  readonly readoutLeft: Float32Array;
  readonly readoutRight: Float32Array;
  readonly decisionVariable: Float32Array;
  /** Body heading, radians. */
  readonly bodyYaw: Float32Array;
}

export interface TraceMark {
  readonly time: number;
  readonly action: NeuralMotorIntent['action'];
  readonly confidence: number;
  readonly latency: number;
}

export interface TraceSample {
  readonly time: number;
  readonly stimulus: number;
  readonly classILeft: number;
  readonly classIRight: number;
  readonly classIILeft: number;
  readonly classIIRight: number;
  readonly readoutLeft: number;
  readonly readoutRight: number;
  readonly decisionVariable: number;
  readonly bodyYaw: number;
}

export class ExperimentTrace {
  readonly capacity: number;
  private readonly tracks: TraceTracks;
  private count = 0;
  private nextSampleAt = 0;
  private marks: TraceMark[] = [];

  constructor(capacity = TRACE_CAPACITY) {
    this.capacity = capacity;
    const make = () => new Float32Array(capacity);
    this.tracks = {
      time: make(),
      stimulus: make(),
      classILeft: make(),
      classIRight: make(),
      classIILeft: make(),
      classIIRight: make(),
      readoutLeft: make(),
      readoutRight: make(),
      decisionVariable: make(),
      bodyYaw: make(),
    };
  }

  reset(): void {
    this.count = 0;
    this.nextSampleAt = 0;
    this.marks = [];
  }

  /**
   * Records a sample if the trace interval has elapsed.
   *
   * Returns true when a sample was actually stored, so callers can avoid
   * building sample objects that would be discarded.
   */
  sample(s: TraceSample): boolean {
    if (s.time < this.nextSampleAt) return false;
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    this.nextSampleAt = s.time + 1 / TRACE_HZ;
    const t = this.tracks;
    t.time[i] = s.time;
    t.stimulus[i] = s.stimulus;
    t.classILeft[i] = s.classILeft;
    t.classIRight[i] = s.classIRight;
    t.classIILeft[i] = s.classIILeft;
    t.classIIRight[i] = s.classIIRight;
    t.readoutLeft[i] = s.readoutLeft;
    t.readoutRight[i] = s.readoutRight;
    t.decisionVariable[i] = s.decisionVariable;
    t.bodyYaw[i] = s.bodyYaw;
    return true;
  }

  mark(intent: NeuralMotorIntent): void {
    this.marks.push({
      time: intent.time,
      action: intent.action,
      confidence: intent.confidence,
      latency: intent.evidence.latency,
    });
  }

  length(): number {
    return this.count;
  }

  isFull(): boolean {
    return this.count >= this.capacity;
  }

  decisions(): readonly TraceMark[] {
    return this.marks;
  }

  /** A track truncated to the samples actually recorded. */
  track(name: keyof TraceTracks): Float32Array {
    return this.tracks[name].subarray(0, this.count);
  }

  /** The sample nearest a given time, for scrubbing. */
  at(time: number): TraceSample | null {
    if (this.count === 0) return null;
    const times = this.tracks.time;
    let low = 0;
    let high = this.count - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (times[mid] < time) low = mid + 1;
      else high = mid;
    }
    // Prefer whichever neighbour is closer, so scrubbing feels exact.
    if (low > 0 && Math.abs(times[low - 1] - time) < Math.abs(times[low] - time)) low -= 1;
    const t = this.tracks;
    return {
      time: t.time[low],
      stimulus: t.stimulus[low],
      classILeft: t.classILeft[low],
      classIRight: t.classIRight[low],
      classIILeft: t.classIILeft[low],
      classIIRight: t.classIIRight[low],
      readoutLeft: t.readoutLeft[low],
      readoutRight: t.readoutRight[low],
      decisionVariable: t.decisionVariable[low],
      bodyYaw: t.bodyYaw[low],
    };
  }
}

/**
 * A bounded per-neuron rate history, for the neuron inspector.
 *
 * Only tracks neurons the user has actually selected: keeping a history for
 * every node would be 1,730 ring buffers updated at 50 Hz for a panel that
 * shows one of them.
 */
export class NeuronTrace {
  private readonly values: Float32Array;
  private readonly capacity: number;
  private head = 0;
  private filled = 0;
  private node = -1;

  constructor(capacity = 256) {
    this.capacity = capacity;
    this.values = new Float32Array(capacity);
  }

  follow(node: number): void {
    if (node === this.node) return;
    this.node = node;
    this.head = 0;
    this.filled = 0;
    this.values.fill(0);
  }

  following(): number {
    return this.node;
  }

  push(value: number): void {
    if (this.node < 0) return;
    this.values[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }

  /** Oldest to newest. */
  history(): Float32Array {
    const out = new Float32Array(this.filled);
    for (let i = 0; i < this.filled; i++) {
      out[i] = this.values[(this.head - this.filled + i + this.capacity) % this.capacity];
    }
    return out;
  }

  reset(): void {
    this.head = 0;
    this.filled = 0;
    this.values.fill(0);
  }
}
