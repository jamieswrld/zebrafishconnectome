import type { EvidenceProvenance } from '@/core/provenance';
import type { Vec3f } from '@/renderer/math';
import type { FishPose } from '@/body/rig';

/**
 * The embodiment loop's data contracts.
 *
 *   WORLD -> SENSORS -> PERCEPTION -> POLICY -> MOTOR -> BODY -> WORLD
 *
 * Each stage is a separate interface on purpose. A single `FishAI` class would
 * make it impossible to later swap the policy for a neural readout, or to show
 * a user which stage produced which number.
 *
 * PROVENANCE, stated once and enforced throughout: everything in this module is
 * SIMULATED. None of it is measured from Fish1, none of it is a claim about
 * what a real animal senses, wants, or decides.
 */

/* -------------------------------------------------------------------------- */
/* Sensing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A coarse visual summary, NOT a retina.
 *
 * Phase 2 exposes bearings and angular sizes rather than pixels, because a
 * first sensory system should be honest about being a proxy. The interface is
 * shaped so a real retinal encoder can replace it without changing the
 * controller: add fields, do not reinterpret existing ones.
 */
export interface VisualSensoryFrame {
  /** Bearing to the nearest visual target, radians relative to heading. */
  readonly targetBearing: number | null;
  /** Angular size of that target, radians. Grows as it approaches. */
  readonly targetAngularSize: number;
  /**
   * Rate of change of angular size. The looming cue: this is the quantity a
   * future looming-threat experiment drives.
   */
  readonly targetLoomRate: number;
  /** Mean scene luminance, 0..1. */
  readonly luminance: number;
  /** Left/right luminance difference, negative = brighter to the left. */
  readonly luminanceGradient: number;
}

export interface FlowSensoryFrame {
  /** Translational optic-flow proxy, body lengths per second. */
  readonly forwardFlow: number;
  /** Rotational flow proxy, radians per second. */
  readonly rotationalFlow: number;
}

export interface ContactSensoryFrame {
  /** Distance to the nearest boundary, millimetres. */
  readonly nearestBoundaryDistance: number;
  /** Bearing to that boundary, radians relative to heading. */
  readonly nearestBoundaryBearing: number;
  readonly touching: boolean;
}

export interface InternalSensoryFrame {
  readonly speed: number;
  readonly turnRate: number;
  /** Seconds since the last swim bout ended. */
  readonly timeSinceBout: number;
}

export interface SensoryFrame {
  /** Simulation time, seconds. */
  readonly time: number;
  readonly visual: VisualSensoryFrame;
  readonly flow: FlowSensoryFrame;
  readonly contact: ContactSensoryFrame;
  readonly internal: InternalSensoryFrame;
  readonly provenance: Extract<EvidenceProvenance, 'simulated'>;
}

/* -------------------------------------------------------------------------- */
/* Acting                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the policy asks the body to do.
 *
 * Deliberately small and physical. A neural controller must be able to produce
 * exactly this from population readouts, with nothing policy-shaped left over.
 */
export interface MotorCommand {
  readonly time: number;
  /** 0..1 forward swim drive. */
  readonly forwardDrive: number;
  /** -1..1, negative = left. */
  readonly turnDrive: number;
  /** 0..1 escape/startle drive; produces a fast, high-amplitude bout. */
  readonly startleDrive: number;
  readonly provenance: Extract<EvidenceProvenance, 'simulated'>;
}

export const IDLE_MOTOR_COMMAND: MotorCommand = {
  time: 0,
  forwardDrive: 0,
  turnDrive: 0,
  startleDrive: 0,
  provenance: 'simulated',
};

/** Discrete swim state. Larval locomotion is bouts separated by glides. */
export type BoutState = 'glide' | 'forward-bout' | 'turn-bout' | 'startle';

export interface BodyState {
  /** Position in the tank, millimetres. */
  readonly position: Vec3f;
  readonly velocity: Vec3f;
  /** Heading in the horizontal plane, radians. */
  readonly heading: number;
  readonly angularVelocity: number;
  readonly boutState: BoutState;
  /** Phase of the tail beat, radians. */
  readonly tailPhase: number;
  readonly pose: FishPose;
  /** Total path length swum, millimetres. */
  readonly distanceTravelled: number;
}

/* -------------------------------------------------------------------------- */
/* World                                                                      */
/* -------------------------------------------------------------------------- */

export interface TankBounds {
  /** Half-extent in x and z, millimetres. */
  readonly halfWidth: number;
  readonly halfDepth: number;
  /** Water column height, millimetres. */
  readonly height: number;
}

export interface VisualTarget {
  readonly id: string;
  readonly position: Vec3f;
  /** Physical radius, millimetres. */
  readonly radius: number;
  /** 0 = dark object on light ground, 1 = bright. */
  readonly brightness: number;
}

export interface WorldState {
  readonly time: number;
  readonly bounds: TankBounds;
  readonly targets: readonly VisualTarget[];
  /** Ambient illumination, 0..1. */
  readonly ambientLight: number;
  /** Direction the key light comes from, for phototaxis experiments. */
  readonly lightDirection: Vec3f;
  readonly provenance: Extract<EvidenceProvenance, 'simulated'>;
}

/* -------------------------------------------------------------------------- */
/* Agent                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Simulation variables describing the artificial agent's internal state.
 *
 * THESE ARE NOT MEASUREMENTS AND NOT EMOTIONS. They are scalars in a control
 * system, displayed under an explicit "AGENT STATE - SIMULATED" heading. A
 * value of `threatEstimate: 0.8` means a number in this program is 0.8; it says
 * nothing about any animal.
 */
export interface AgentState {
  /** 0..1, depletes while swimming, recovers while gliding. */
  readonly energy: number;
  /** 0..1, how unfamiliar recent observations are. */
  readonly novelty: number;
  /** 0..1, general responsiveness; scales bout frequency. */
  readonly arousal: number;
  /** 0..1, the controller's own estimate of threat from looming cues. */
  readonly threatEstimate: number;
  /** 0..1, tendency to move rather than hold position. */
  readonly explorationDrive: number;
}

export const INITIAL_AGENT_STATE: AgentState = {
  energy: 1,
  novelty: 0.5,
  arousal: 0.35,
  threatEstimate: 0,
  explorationDrive: 0.5,
};

export type DriveId =
  'explore' | 'avoid-threat' | 'avoid-boundary' | 'seek-light' | 'seek-novelty' | 'rest';

export interface Drive {
  readonly id: DriveId;
  /** Current strength, 0..1. */
  readonly value: number;
  readonly source: 'simulated' | 'derived' | 'model';
  /** Which sensory/state fields fed this value. Shown in the UI. */
  readonly inputs: readonly string[];
}

/** Physical actions the organism can take. */
export type ActionId =
  | 'SWIM_FORWARD'
  | 'TURN_LEFT'
  | 'TURN_RIGHT'
  | 'GLIDE'
  | 'STOP'
  | 'ORIENT_TO_TARGET'
  | 'AVOID_TARGET'
  | 'ESCAPE';

export interface ActionProposal {
  readonly id: string;
  readonly action: ActionId;
  /** Higher wins. Comparable only within one selection round. */
  readonly utility: number;
  /** Plain-language justification, surfaced in the action log. */
  readonly reason: string;
  /** Which subsystem proposed it. */
  readonly source: string;
  readonly time: number;
}

export interface SelectedAction extends ActionProposal {
  readonly selectedAt: number;
  /** The proposals that lost, so a decision can be audited. */
  readonly alternatives: readonly ActionProposal[];
}

/* -------------------------------------------------------------------------- */
/* Controller                                                                 */
/* -------------------------------------------------------------------------- */

export interface ControllerContext {
  readonly agent: AgentState;
  readonly world: WorldState;
  readonly body: BodyState;
}

export interface ControllerOutput {
  readonly motor: MotorCommand;
  readonly agent: AgentState;
  readonly drives: readonly Drive[];
  readonly selected: SelectedAction | null;
  readonly proposals: readonly ActionProposal[];
}

/**
 * A swappable policy.
 *
 * Phase 2 ships exactly one implementation, a procedural locomotion model. The
 * point of the interface is that a `NeuralBehaviorController` reading motor
 * population activity can replace it later without touching the body, the
 * world, or the UI.
 */
export interface BehaviorController {
  readonly id: string;
  readonly label: string;
  readonly provenance: EvidenceProvenance;
  /** Whether measured connectome data influences this controller at all. */
  readonly connectomeCoupled: boolean;
  reset(seed: number): void;
  step(dt: number, sensory: SensoryFrame, context: ControllerContext): ControllerOutput;
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

export type AgentEventType =
  | 'sensory_input'
  | 'state_changed'
  | 'action_proposed'
  | 'action_selected'
  | 'motor_command'
  | 'movement'
  | 'boundary_contact'
  | 'external_action_requested'
  | 'external_action_approved'
  | 'external_action_denied'
  | 'external_action_executed'
  | 'external_action_result';

export interface AgentEvent {
  readonly id: string;
  /** Simulation time, seconds. */
  readonly timestamp: number;
  /** Wall-clock time, for the live feed. */
  readonly wallClock: number;
  readonly type: AgentEventType;
  readonly provenance: EvidenceProvenance;
  /** One-line human-readable summary for the activity feed. */
  readonly summary: string;
  readonly payload: unknown;
}
