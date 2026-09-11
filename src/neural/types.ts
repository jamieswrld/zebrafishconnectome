import type { EvidenceProvenance } from '@/core/provenance';

/**
 * The neural runtime boundary.
 *
 * Phase 2 reserved the idea; this is the contract. Everything crossing it is
 * compact typed-array state, never per-neuron objects and never React state:
 * the runtime steps at a fixed 200 Hz over 1,730 nodes, and allocating there
 * would show up immediately in the frame budget.
 *
 * THE CENTRAL HONESTY RULE OF THIS MODULE
 *
 *   Fish1 is a structural EM dataset. It contains no neural activity.
 *   Everything this runtime produces is SIMULATED. The measured connectome
 *   constrains WHO is connected to WHOM, with WHAT SIGN, and by HOW MANY
 *   SYNAPSES. The dynamics on top of that graph are a model.
 *
 * So the correct description is CONNECTOME-CONSTRAINED SIMULATION. It is not a
 * recording, it is not "the fish's thoughts", and no value produced here may be
 * presented as measured activity.
 */

/* -------------------------------------------------------------------------- */
/* Model provenance                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What kind of model is running.
 *
 * The distinction that matters: whether the dynamics were published and
 * validated by someone else, or are ours.
 */
export type NeuralModelCategory =
  /** The authors' own model, run as published. */
  | 'published_model'
  /** A faithful reimplementation of a published model. */
  | 'reimplemented_published_model'
  /** Our dynamics, constrained by a measured connectome. */
  | 'connectome_constrained_model'
  /** Exploratory dynamics on a graph, with no claim to biological fidelity. */
  | 'experimental_graph_model';

export interface NeuralModelCategoryDescriptor {
  readonly label: string;
  readonly description: string;
}

export const NEURAL_MODEL_CATEGORY_INFO: Record<
  NeuralModelCategory,
  NeuralModelCategoryDescriptor
> = {
  published_model: {
    label: 'PUBLISHED MODEL',
    description: "The original authors' model and weights, run as published.",
  },
  reimplemented_published_model: {
    label: 'REIMPLEMENTED MODEL',
    description:
      'A reimplementation of a published model, validated against published results.',
  },
  connectome_constrained_model: {
    label: 'CONNECTOME-CONSTRAINED MODEL',
    description:
      'Dynamics chosen by us, with connectivity, sign and synapse counts taken from a measured connectome.',
  },
  experimental_graph_model: {
    label: 'EXPERIMENTAL GRAPH MODEL',
    description: 'Exploratory dynamics on a graph. No claim of biological fidelity.',
  },
};

/**
 * The full disclosure for a run.
 *
 * Every field exists so a user can answer "what part of this is real?" without
 * reading the source or the docs.
 */
export interface NeuralModelProvenance {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly category: NeuralModelCategory;
  /** Where the graph came from. */
  readonly connectivitySource: string;
  /** True only if the edges are measured synaptic contacts. */
  readonly connectivityMeasured: boolean;
  /** Where the synaptic weights came from. */
  readonly weightsSource: string;
  /** Where the dynamical equations came from. */
  readonly dynamicsSource: string;
  /** True only if real recorded activity is being replayed. Always false here. */
  readonly activityMeasured: boolean;
  readonly citations: readonly string[];
  /** Limits a reader must know before quoting any number out of this runtime. */
  readonly caveats: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Sign policy                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What to do about neurons whose transmitter was never labelled.
 *
 * In the Fish1 HMI release, 642 of 865 placed cells have no published
 * neurotransmitter. Calling them all excitatory because the model needs a sign
 * would be the single easiest way to fabricate a result, so the policy is
 * explicit, selectable, and reported with every run.
 */
export type SignPolicy =
  /**
   * Only neurons with a MEASURED transmitter contribute signed drive. Edges out
   * of an unlabelled neuron are present in the graph but contribute zero.
   * The default, because it is the only policy that adds no assumption.
   */
  | 'strict'
  /**
   * An unlabelled neuron inherits the majority transmitter of its
   * morphological class, but only where that class is labelled purely enough
   * (see CLASS_IMPUTATION_MIN_PURITY). Its weight is scaled by the class purity
   * so a 70%-pure imputation cannot act like a measurement.
   */
  | 'class-imputed'
  /**
   * Runs strict and class-imputed side by side and reports whether the decision
   * differs. Used to answer "does this result depend on the assumption?".
   */
  | 'sensitivity';

export interface SignPolicyDescriptor {
  readonly label: string;
  readonly description: string;
}

export const SIGN_POLICY_INFO: Record<SignPolicy, SignPolicyDescriptor> = {
  strict: {
    label: 'STRICT',
    description:
      'Only measured neurotransmitter labels produce signed drive. Unlabelled neurons contribute nothing.',
  },
  'class-imputed': {
    label: 'CLASS-IMPUTED',
    description:
      'Unlabelled neurons inherit their class majority transmitter, down-weighted by class purity. An assumption, and labelled as one.',
  },
  sensitivity: {
    label: 'SENSITIVITY',
    description:
      'Runs strict and class-imputed together and reports whether the outcome differs.',
  },
};

/** A class must be at least this pure before imputation is allowed at all. */
export const CLASS_IMPUTATION_MIN_PURITY = 0.7;
/** And have at least this many labelled members. */
export const CLASS_IMPUTATION_MIN_LABELLED = 5;

/* -------------------------------------------------------------------------- */
/* Weighting                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How a synapse count becomes a weight.
 *
 * A synapse count is NOT a physiological synaptic weight. It is a structural
 * proxy, and which monotone function of it you choose changes the dynamics, so
 * the choice is named, selectable and reported rather than buried.
 */
export type WeightScheme =
  /** w = log1p(synapses). Compresses hub edges; the default. */
  | 'log1p'
  /** w = synapses. Linear in contact count. */
  | 'linear'
  /** w = 1 for every measured contact. Tests whether counts matter at all. */
  | 'binary';

export const WEIGHT_SCHEME_INFO: Record<WeightScheme, { label: string; description: string }> =
  {
    log1p: {
      label: 'LOG1P SYNAPSE-COUNT WEIGHTED',
      description:
        'w = log(1 + synapse count), then normalised per postsynaptic neuron. Compresses the influence of high-count hub edges.',
    },
    linear: {
      label: 'LINEAR SYNAPSE-COUNT WEIGHTED',
      description: 'w = synapse count, then normalised per postsynaptic neuron.',
    },
    binary: {
      label: 'BINARY (CONNECTED OR NOT)',
      description:
        'Every measured contact counts the same. Tests whether synapse counts matter.',
    },
  };

/* -------------------------------------------------------------------------- */
/* Input and output                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Sensory drive entering the circuit.
 *
 * Deliberately only two numbers plus context. The mapping from a visual scene
 * to these values lives in the sensory encoder, not in the neural runtime, so
 * the encoder can be replaced without touching the model.
 */
export interface NeuralSensoryInput {
  /** Drive favouring leftward motion, 0..1. */
  readonly leftDrive: number;
  /** Drive favouring rightward motion, 0..1. */
  readonly rightDrive: number;
  /** Fraction of the stimulus carrying coherent motion, 0..1. */
  readonly coherence: number;
}

export const ZERO_SENSORY_INPUT: NeuralSensoryInput = {
  leftDrive: 0,
  rightDrive: 0,
  coherence: 0,
};

/** Summary state of one named population on one side. */
export interface PopulationSummary {
  readonly id: string;
  readonly label: string;
  readonly left: number;
  readonly right: number;
  readonly neuronCount: number;
}

export interface PopulationState {
  readonly time: number;
  readonly populations: readonly PopulationSummary[];
  /** Signed decision variable: negative favours left, positive favours right. */
  readonly decisionVariable: number;
  /** Threshold the decision variable must cross. */
  readonly threshold: number;
  readonly provenance: Extract<EvidenceProvenance, 'simulated'>;
}

export type NeuralAction = 'turn_left' | 'turn_right' | 'none';

export interface NeuralDecisionEvidence {
  /** Readout population activity that produced the decision. */
  readonly leftReadout: number;
  readonly rightReadout: number;
  readonly decisionVariable: number;
  readonly threshold: number;
  /** Seconds of simulated time from stimulus onset to threshold crossing. */
  readonly latency: number;
  /** Sensory input at the moment of crossing. */
  readonly input: NeuralSensoryInput;
}

/**
 * What the circuit asks for.
 *
 * MOTOR INTENT, not motor execution. The reconstructed circuit reaches spinal
 * projection neurons; the spinal pattern generator and the muscles are not in
 * this dataset, so the body still executes the movement procedurally.
 */
export interface NeuralMotorIntent {
  readonly time: number;
  readonly source: 'connectome';
  readonly action: NeuralAction;
  /** 0..1, how far past threshold the decision variable is. */
  readonly confidence: number;
  readonly evidence: NeuralDecisionEvidence;
  /** Identifier of the circuit that produced this. */
  readonly circuit: string;
}

/** One step of the model. Arrays are views owned by the runtime: do not retain. */
export interface NeuralFrame {
  readonly time: number;
  readonly step: number;
  /** Rate of every node, 0..1. Length = nodeCount. */
  readonly rates: Float32Array;
  readonly populations: PopulationState;
  readonly intent: NeuralMotorIntent | null;
}

/* -------------------------------------------------------------------------- */
/* Ablation                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * An IN SILICO ABLATION: a change to the model, not a biological lesion.
 *
 * Everything here is reversible and affects only the simulation.
 */
export type AblationTarget =
  /** Silence one neuron by its index in the network. */
  | { readonly kind: 'neuron'; readonly node: number }
  /** Silence every neuron of one class, optionally on one side only. */
  | {
      readonly kind: 'class';
      readonly className: string;
      readonly hemisphere?: 'left' | 'right';
    }
  /** Silence one entire hemisphere. */
  | { readonly kind: 'hemisphere'; readonly hemisphere: 'left' | 'right' }
  /** Remove one named projection (measured or modeled). */
  | { readonly kind: 'projection'; readonly projectionId: string }
  /** Remove recurrent connections within a class on the same side. */
  | { readonly kind: 'recurrence'; readonly className: string };

export interface Ablation {
  readonly id: string;
  readonly label: string;
  readonly target: AblationTarget;
}

/* -------------------------------------------------------------------------- */
/* Runtime                                                                    */
/* -------------------------------------------------------------------------- */

export interface NeuralRuntime {
  readonly id: string;
  readonly provenance: NeuralModelProvenance;
  readonly nodeCount: number;

  /** Clears all state. Same seed and inputs must reproduce the same run. */
  reset(seed?: number): void;

  setSensoryInput(input: NeuralSensoryInput): void;

  /**
   * Advances the model by `dt` seconds of simulated time, internally using as
   * many fixed neural steps as needed.
   */
  step(dt: number): NeuralFrame;

  getPopulationState(): PopulationState;

  /** Per-node rate, for the GPU activity layer. Length = nodeCount. */
  getNeuronStateBuffer(): Float32Array;

  getMotorIntent(): NeuralMotorIntent | null;

  setAblations(ablations: readonly Ablation[]): void;
  getAblations(): readonly Ablation[];
}
