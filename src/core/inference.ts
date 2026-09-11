import type { EvidenceProvenance } from './provenance';
import type { LoreId } from './ids';

/**
 * Inferred internal states.
 *
 * TYPES ONLY in this phase. Nothing in the application produces values of these
 * types yet, and nothing should until a model exists that can justify them.
 *
 * The rules these types are designed to enforce:
 *
 *  1. An inferred state is a CLASSIFICATION OF A SIGNAL, never a report of what
 *     the animal is experiencing. `label` may say "escape-like response"; it may
 *     never say "the fish is afraid" and there is deliberately no field for a
 *     natural-language "thought".
 *  2. Every state must carry the evidence it was computed from, so a user can
 *     open it and see which neurons, which time window, and which model.
 *  3. Every state carries provenance, which for these is at best `inferred`.
 */

/**
 * Catalogue of states we may eventually infer. These name BEHAVIOURAL or
 * PHYSIOLOGICAL response categories with established usage in the larval
 * zebrafish literature - not emotions.
 */
export type InferredStateId =
  | 'escape-response'
  | 'startle-response'
  | 'locomotor-drive'
  | 'turn-bias-left'
  | 'turn-bias-right'
  | 'phototactic-drive'
  | 'passivity'
  | 'sensory-salience'
  | 'motor-preparation'
  | 'autonomic-arousal';

export interface InferredStateDefinition {
  readonly id: InferredStateId;
  /** Wording shown in the UI. Must describe a response, not a feeling. */
  readonly label: string;
  /** What the readout actually measures. Shown when the user opens evidence. */
  readonly definition: string;
  readonly unit: 'normalised';
}

export const INFERRED_STATE_DEFINITIONS: Record<InferredStateId, InferredStateDefinition> = {
  'escape-response': {
    id: 'escape-response',
    label: 'ESCAPE RESPONSE',
    definition:
      'Activation of identified escape circuitry above a model-defined threshold. Describes circuit state, not subjective fear.',
    unit: 'normalised',
  },
  'startle-response': {
    id: 'startle-response',
    label: 'STARTLE RESPONSE',
    definition: 'Short-latency population response to an abrupt stimulus onset.',
    unit: 'normalised',
  },
  'locomotor-drive': {
    id: 'locomotor-drive',
    label: 'LOCOMOTOR DRIVE',
    definition: 'Aggregate activity of populations associated with swim initiation.',
    unit: 'normalised',
  },
  'turn-bias-left': {
    id: 'turn-bias-left',
    label: 'TURN BIAS - LEFT',
    definition: 'Left/right asymmetry in motor-associated populations, left-dominant.',
    unit: 'normalised',
  },
  'turn-bias-right': {
    id: 'turn-bias-right',
    label: 'TURN BIAS - RIGHT',
    definition: 'Left/right asymmetry in motor-associated populations, right-dominant.',
    unit: 'normalised',
  },
  'phototactic-drive': {
    id: 'phototactic-drive',
    label: 'PHOTOTACTIC DRIVE',
    definition: 'Directional bias in visually driven populations under a light gradient.',
    unit: 'normalised',
  },
  passivity: {
    id: 'passivity',
    label: 'PASSIVITY',
    definition: 'Sustained suppression of motor-associated populations.',
    unit: 'normalised',
  },
  'sensory-salience': {
    id: 'sensory-salience',
    label: 'SENSORY SALIENCE',
    definition: 'Magnitude of the sensory-driven response relative to baseline.',
    unit: 'normalised',
  },
  'motor-preparation': {
    id: 'motor-preparation',
    label: 'MOTOR PREPARATION',
    definition: 'Premotor population activity preceding a detected motor event.',
    unit: 'normalised',
  },
  'autonomic-arousal': {
    id: 'autonomic-arousal',
    label: 'AUTONOMIC AROUSAL',
    definition: 'Activity in neuromodulatory populations associated with arousal.',
    unit: 'normalised',
  },
};

/** A single piece of support for an inferred state. */
export type StateEvidence =
  | {
      readonly kind: 'population-activity';
      readonly label: string;
      readonly neuronIds: readonly LoreId[];
      readonly windowSeconds: readonly [number, number];
      readonly statistic: string;
      readonly value: number;
      readonly provenance: EvidenceProvenance;
    }
  | {
      readonly kind: 'stimulus';
      readonly label: string;
      readonly windowSeconds: readonly [number, number];
      readonly provenance: EvidenceProvenance;
    }
  | {
      readonly kind: 'model-output';
      readonly label: string;
      readonly modelId: string;
      readonly value: number;
      readonly provenance: EvidenceProvenance;
    }
  | {
      readonly kind: 'graph-statistic';
      readonly label: string;
      readonly statistic: string;
      readonly value: number;
      readonly provenance: EvidenceProvenance;
    };

export interface InferredState {
  readonly id: InferredStateId;
  readonly label: string;
  /** Normalised 0..1 readout. Never presented as a percentage certainty. */
  readonly value: number;
  /** Model confidence, when the model reports one. */
  readonly confidence?: number;
  /** Always 'inferred' for this type; kept explicit so it is never assumed. */
  readonly provenance: Extract<EvidenceProvenance, 'inferred'>;
  readonly modelId: string;
  readonly modelVersion?: string;
  readonly timeSeconds: number;
  readonly evidence: readonly StateEvidence[];
  /**
   * What this readout does NOT establish. Displayed with the evidence so the
   * limitation travels with the number.
   */
  readonly caveat: string;
}

/**
 * Contract for anything that classifies network state. Deliberately unimplemented
 * in Phase 1.
 */
export interface StateInferenceModel {
  readonly modelId: string;
  readonly version: string;
  readonly states: readonly InferredStateId[];
  readonly describe: () => string;
}
