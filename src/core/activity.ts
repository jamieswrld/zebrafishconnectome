import type { EvidenceProvenance } from './provenance';
import type { LoreId } from './ids';

/**
 * Functional (time-varying) data.
 *
 * Kept deliberately separate from the structural connectome. Fish1 is a
 * structural EM dataset and contains NO neural activity; any activity shown
 * alongside it must come from a different dataset and must be labelled as such.
 *
 * Critically, cells in a functional dataset are NOT automatically the same
 * cells as in a structural dataset. Correspondence must be established by an
 * explicit registration, and carries its own provenance - see
 * {@link CellCorrespondence}.
 */

/** Which of the three runtime modes produced the values on screen. */
export type RuntimeMode = 'recorded' | 'predicted' | 'simulated';

export interface RuntimeModeDescriptor {
  readonly badge: string;
  readonly provenance: EvidenceProvenance;
  readonly description: string;
}

export const RUNTIME_MODE_INFO: Record<RuntimeMode, RuntimeModeDescriptor> = {
  recorded: {
    badge: 'RECORDED',
    provenance: 'measured',
    description: 'Replay of activity actually recorded from an animal.',
  },
  predicted: {
    badge: 'PREDICTED',
    provenance: 'predicted',
    description: 'Forecast produced by a model, not an observation.',
  },
  simulated: {
    badge: 'SIMULATED',
    provenance: 'simulated',
    description: 'Output of a computational model driven by connectivity.',
  },
};

export interface TimeRange {
  /** Seconds from the start of the recording. */
  readonly startSeconds: number;
  readonly endSeconds: number;
  /** Number of sampled frames in the range. */
  readonly frameCount: number;
  /** Sampling interval in seconds. */
  readonly frameIntervalSeconds: number;
}

export type ActivityUnit =
  /** Relative fluorescence change, dF/F. */
  | 'dff'
  /** Z-scored fluorescence. */
  | 'zscore'
  /** Inferred spike rate, Hz. Note: inference, not a spike measurement. */
  | 'inferred-rate-hz'
  /** Arbitrary normalised units from a simulation. */
  | 'normalised';

export interface ActivityMetadata {
  readonly datasetId: string;
  readonly sourceId: string;
  readonly title: string;
  readonly mode: RuntimeMode;
  readonly unit: ActivityUnit;
  readonly neuronCount: number;
  readonly timeRange: TimeRange;
  readonly provenance: EvidenceProvenance;
  /**
   * Which structural dataset these traces can be mapped onto, if any.
   * Undefined means the traces stand alone and must not be painted onto
   * another dataset's neurons.
   */
  readonly correspondence?: CellCorrespondence;
  /** Stimulus / behavioural conditions present in the recording. */
  readonly conditions?: readonly ActivityCondition[];
}

export interface ActivityCondition {
  readonly id: string;
  readonly label: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly provenance: EvidenceProvenance;
}

/**
 * A mapping between cells of two datasets.
 *
 * This exists so that "the same neuron" is an explicit, auditable claim rather
 * than an assumption. Fish1 and ZAPBench are different animals; there is no
 * cell-level correspondence between them, and the application must not invent
 * one.
 */
export interface CellCorrespondence {
  readonly fromDatasetId: string;
  readonly toDatasetId: string;
  readonly method: string;
  readonly provenance: EvidenceProvenance;
  readonly matchedCells: number;
  /** True only when the two datasets come from the same individual animal. */
  readonly sameAnimal: boolean;
}

export interface ActivityQuery {
  readonly startSeconds: number;
  readonly endSeconds: number;
  /** Restrict to specific cells; omit for all. */
  readonly neuronIds?: readonly LoreId[];
  /** Downsample to at most this many frames. */
  readonly maxFrames?: number;
}

/**
 * A window of activity, laid out for direct GPU upload.
 *
 * Row-major [frame][neuron]: frame f of neuron n is at
 *   values[f * neuronCount + n]
 * This is the layout the renderer wants when advancing playback, because one
 * frame is a contiguous slice that can be uploaded as a single buffer write.
 */
export interface ActivityWindow {
  readonly sourceId: string;
  readonly mode: RuntimeMode;
  readonly unit: ActivityUnit;
  readonly neuronCount: number;
  readonly frameCount: number;
  readonly startSeconds: number;
  readonly frameIntervalSeconds: number;
  readonly values: Float32Array;
  /**
   * Maps column index in `values` to a neuron index in the loaded
   * {@link import('./types').NeuronIndex}. -1 marks a trace with no
   * corresponding structural cell, which must not be rendered on the brain.
   */
  readonly neuronIndexMap: Int32Array;
  readonly provenance: EvidenceProvenance;
}

/**
 * Contract for any dataset that supplies time-varying per-cell signals.
 * Implemented by recorded, predicted and simulated sources alike, so playback
 * UI is written once - but the `mode` field keeps them visually distinct.
 */
export interface ActivitySource {
  readonly sourceId: string;
  metadata(): Promise<ActivityMetadata>;
  timeRange(): Promise<TimeRange>;
  getWindow(query: ActivityQuery): Promise<ActivityWindow>;
}

export function frameIndexAt(t: number, range: TimeRange): number {
  const raw = Math.round((t - range.startSeconds) / range.frameIntervalSeconds);
  return Math.min(Math.max(raw, 0), Math.max(range.frameCount - 1, 0));
}
