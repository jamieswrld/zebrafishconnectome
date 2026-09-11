import type { LoreId } from '@/core/ids';
import type { CellPolarity } from '@/core/types';
import type { ActivityWindow, RuntimeMode } from '@/core/activity';

/**
 * Simulation runtime — TYPES ONLY.
 *
 * Nothing in this build runs a simulation. These interfaces exist so the shape
 * of the eventual engine is fixed now, and so the connectivity representation
 * it needs is already the one the data layer produces.
 *
 * Deliberate non-decision: the neuron model is NOT chosen here. Picking
 * leaky-integrate-and-fire versus a rate model versus anything else before the
 * connectivity is correctly represented would be premature. What IS fixed is
 * the pipeline shape:
 *
 *   stimulus -> sensory population -> kernel -> network state
 *            -> population readouts -> motor output
 *
 * and the rule that every output of this subsystem is labelled SIMULATED.
 */

/* -------------------------------------------------------------------------- */
/* Connectivity representation                                                */
/* -------------------------------------------------------------------------- */

/**
 * Compressed sparse row adjacency.
 *
 * The one representation a network simulation actually needs: for node i, its
 * outgoing edges are `targets[offsets[i] .. offsets[i+1]]`. Contiguous, cache
 * friendly, uploadable to a GPU compute buffer unchanged, and it never
 * materialises an edge object.
 *
 * Both orientations are kept because forward propagation reads outgoing edges
 * while credit assignment and input aggregation read incoming ones, and
 * transposing 30M edges per step would dominate the cost.
 */
export interface SparseConnectivity {
  readonly datasetId: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  /** length = nodeCount + 1 */
  readonly offsets: Uint32Array;
  /** length = edgeCount */
  readonly targets: Uint32Array;
  /** Synapse counts, used as the basis for weight. length = edgeCount */
  readonly weights: Float32Array;
  /**
   * Sign of each edge: +1 excitatory, -1 inhibitory, 0 unknown.
   * Kept separate from magnitude so an unknown-polarity edge is distinguishable
   * from a zero-weight one.
   */
  readonly signs: Int8Array;
  readonly orientation: 'outgoing' | 'incoming';
}

/** Per-node static properties the kernel reads. */
export interface NetworkNodes {
  readonly count: number;
  readonly loreIds: Uint32Array;
  readonly polarity: Uint8Array;
  readonly regionIds: Uint16Array;
}

/* -------------------------------------------------------------------------- */
/* Stimulus and sensory encoding                                              */
/* -------------------------------------------------------------------------- */

export type StimulusKind =
  | 'looming-disk'
  | 'dark-flash'
  | 'bright-flash'
  | 'lateralised-light'
  | 'optic-flow'
  | 'rotation'
  | 'water-flow'
  | 'direct-neural';

export interface StimulusEvent {
  readonly kind: StimulusKind;
  readonly startSeconds: number;
  readonly endSeconds: number;
  /** Kind-specific parameters, e.g. disk expansion rate. */
  readonly parameters: Readonly<Record<string, number>>;
}

/**
 * Turns a stimulus into drive on specific cells.
 *
 * This is where a scientific claim is actually made - "these cells respond to
 * this stimulus" - so an encoder must declare how its target population was
 * determined, and that justification is surfaced in the UI.
 */
export interface SensoryEncoder {
  readonly id: string;
  readonly stimulusKinds: readonly StimulusKind[];
  /** How the driven population was chosen. Shown to the user verbatim. */
  readonly populationJustification: string;
  encode(event: StimulusEvent, timeSeconds: number): Float32Array;
}

/* -------------------------------------------------------------------------- */
/* Kernel                                                                     */
/* -------------------------------------------------------------------------- */

export interface SimulationConfig {
  readonly timestepSeconds: number;
  readonly durationSeconds: number;
  /** Identifier of the neuron/population model in use. */
  readonly modelId: string;
  readonly modelParameters: Readonly<Record<string, number>>;
  readonly seed: number;
}

export interface NetworkState {
  readonly timeSeconds: number;
  readonly step: number;
  /** Per-node state variable. Meaning depends on the model. */
  readonly activation: Float32Array;
  /** Per-node output/rate, which drives the renderer's activity lane. */
  readonly output: Float32Array;
}

export interface SimulationKernel {
  readonly modelId: string;
  readonly describe: () => string;
  init(nodes: NetworkNodes, connectivity: SparseConnectivity, config: SimulationConfig): void;
  step(input: Float32Array): NetworkState;
  reset(): void;
}

/* -------------------------------------------------------------------------- */
/* Readouts and motor output                                                  */
/* -------------------------------------------------------------------------- */

export interface PopulationReadout {
  readonly id: string;
  readonly label: string;
  readonly neuronIds: readonly LoreId[];
  /** How this population was defined. Never left implicit. */
  readonly definitionJustification: string;
  readonly polarityFilter?: CellPolarity;
}

export interface MotorOutput {
  readonly timeSeconds: number;
  /** Normalised forward swim drive. */
  readonly forward: number;
  /** Signed turn bias; negative left, positive right. */
  readonly turn: number;
  readonly provenance: 'simulated';
}

/**
 * A completed run. Always carries `mode: 'simulated'`, so a caller cannot
 * accidentally present model output with the same weight as a recording.
 */
export interface SimulationRun {
  readonly runId: string;
  readonly mode: Extract<RuntimeMode, 'simulated'>;
  readonly config: SimulationConfig;
  readonly stimuli: readonly StimulusEvent[];
  readonly activity: ActivityWindow;
  readonly motor: readonly MotorOutput[];
}

/* -------------------------------------------------------------------------- */
/* Virtual animal (future)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The closed loop that a second viewport would eventually drive:
 *
 *   environment -> sensory encoding -> brain model -> motor readout
 *               -> fish movement -> environment -> ...
 *
 * Typed here so the eventual module has a defined seam rather than growing
 * inside a React component.
 */
export interface VirtualFishState {
  readonly positionMm: readonly [number, number];
  readonly headingRadians: number;
  readonly timeSeconds: number;
}

export interface EnvironmentState {
  readonly timeSeconds: number;
  readonly stimuli: readonly StimulusEvent[];
}

export interface ClosedLoopStep {
  readonly environment: EnvironmentState;
  readonly network: NetworkState;
  readonly motor: MotorOutput;
  readonly fish: VirtualFishState;
}
