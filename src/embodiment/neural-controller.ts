import type { HmiNeuralRuntime } from '@/neural/runtime';
import type { NeuralMotorIntent, PopulationState } from '@/neural/types';
import {
  evidenceToNeuralInput,
  VisualMotionEncoder,
  ZERO_EVIDENCE,
  type VisualMotionEvidence,
} from './visual-motion';
import {
  INITIAL_AGENT_STATE,
  type ActionProposal,
  type AgentState,
  type BehaviorController,
  type ControllerContext,
  type ControllerOutput,
  type Drive,
  type MotorCommand,
  type SelectedAction,
  type SensoryFrame,
} from './types';

/**
 * The connectome-driven controller.
 *
 * This is the seam Phase 2 built the `BehaviorController` interface for. It
 * replaces the procedural policy with one whose action selection is produced by
 * a simulated network whose connectivity is measured Fish1 anatomy.
 *
 * THE CHAIN, AND WHY EACH LINK MATTERS
 *
 *   world            the moving pattern, and the fish's own rotation
 *     -> encoder     finite-dot sampling produces fluctuating evidence
 *     -> network     evidence drives the traced input layer
 *     -> dynamics    measured recurrent Class I connectivity integrates it
 *     -> readout     measured SPN_turning population, left versus right
 *     -> intent      threshold crossing on the readout difference
 *     -> bridge      intent becomes a turn command
 *     -> body        the existing physical model executes a bout
 *
 * Nothing in this file inspects the stimulus direction to choose a turn. The
 * only way a turn is produced is a threshold crossing inside the network, and
 * if the neural runtime is removed this controller cannot act at all. That is
 * the difference between a connectome-driven decision and a demo.
 *
 * WHAT IS STILL NOT CONNECTOME-DRIVEN
 *
 * The bout itself. Spinal projection neurons are where the reconstruction ends;
 * the spinal pattern generator and the musculature are not in this dataset, so
 * the body executes movement procedurally. The UI says MOTOR PLANT: PROCEDURAL
 * for exactly this reason.
 */

/**
 * Scales the measured SPN_forward population rate into forward swim drive.
 *
 * Forward drive is taken from the simulated activity of the measured forward
 * spinal projection population rather than being a constant, so both motor
 * channels come out of the circuit. The factor converts a population rate of
 * order 0.1-0.3 into the 0.12-1.0 range the body's bout threshold expects.
 */
const FORWARD_DRIVE_SCALE = 2.4;

/** How long a decision holds the turn command, seconds. */
const TURN_COMMAND_SECONDS = 0.25;

export interface NeuralControllerOptions {
  readonly runtime: HmiNeuralRuntime;
  readonly encoder: VisualMotionEncoder;
}

export class NeuralHmiController implements BehaviorController {
  readonly id = 'neural-hmi-v1';
  readonly label = 'Connectome-driven HMI';
  readonly provenance = 'simulated' as const;
  /** True: measured Fish1 connectivity determines which action is selected. */
  readonly connectomeCoupled = true;

  private readonly runtime: HmiNeuralRuntime;
  private readonly encoder: VisualMotionEncoder;

  private agent: AgentState = { ...INITIAL_AGENT_STATE };
  private evidence: VisualMotionEvidence = ZERO_EVIDENCE;
  private populations: PopulationState | null = null;
  private lastIntent: NeuralMotorIntent | null = null;
  private turnCommandUntil = -Infinity;
  private turnCommandDrive = 0;
  private proposalCounter = 0;

  constructor(options: NeuralControllerOptions) {
    this.runtime = options.runtime;
    this.encoder = options.encoder;
  }

  reset(seed: number): void {
    this.runtime.reset(seed);
    this.encoder.reset(seed);
    this.agent = { ...INITIAL_AGENT_STATE };
    this.evidence = ZERO_EVIDENCE;
    this.populations = null;
    this.lastIntent = null;
    this.turnCommandUntil = -Infinity;
    this.turnCommandDrive = 0;
    this.proposalCounter = 0;
  }

  /** The evidence that drove the most recent step. For the UI and traces. */
  currentEvidence(): VisualMotionEvidence {
    return this.evidence;
  }

  currentPopulations(): PopulationState | null {
    return this.populations;
  }

  /** The most recent decision, retained for the action-explanation panel. */
  currentIntent(): NeuralMotorIntent | null {
    return this.lastIntent;
  }

  step(dt: number, sensory: SensoryFrame, context: ControllerContext): ControllerOutput {
    /* 1. world -> visual evidence (closed loop subtracts the fish's own yaw) */
    const evidence = this.encoder.sense(dt, sensory.time, context.body.angularVelocity);
    this.evidence = evidence;

    /* 2. evidence -> circuit input */
    this.runtime.setSensoryInput(evidenceToNeuralInput(evidence));

    /* 3. advance the network */
    const frame = this.runtime.step(dt);
    this.populations = frame.populations;

    /* 4. a threshold crossing becomes an intent, consumed exactly once */
    const intent = this.runtime.consumeMotorIntent();
    if (intent && intent.action !== 'none') {
      this.lastIntent = intent;
      this.turnCommandUntil = sensory.time + TURN_COMMAND_SECONDS;
      // Confidence scales the turn, so a marginal decision produces a smaller
      // turn than an emphatic one.
      const magnitude = 0.3 + 0.7 * Math.min(Math.max(intent.confidence, 0), 1);
      this.turnCommandDrive = intent.action === 'turn_right' ? magnitude : -magnitude;
    }

    /* 5. intent -> motor command */
    const motor = this.toMotorCommand(sensory.time, frame.populations);

    const drives = this.describeDrives(frame.populations);
    const proposals = this.describeProposals(sensory.time, frame.populations);
    const selected = this.describeSelection(sensory.time, proposals, motor);

    this.agent = this.updateAgentState(dt, sensory, frame.populations);

    return { motor, agent: this.agent, drives, selected, proposals };
  }

  /* ------------------------------------------------------------- bridge */

  /**
   * The motor bridge: NeuralMotorIntent -> MotorCommand.
   *
   * Deliberately the only place a neural quantity becomes a body command. The
   * neural runtime never touches the rig, the physics or a vertex, so the motor
   * plant can be replaced later without changing the circuit.
   */
  private toMotorCommand(time: number, populations: PopulationState): MotorCommand {
    const forwardPopulation = populations.populations.find((p) => p.id === 'SPN_forward');
    const forwardRate = forwardPopulation
      ? (forwardPopulation.left + forwardPopulation.right) * 0.5
      : 0;
    const forwardDrive = Math.min(forwardRate * FORWARD_DRIVE_SCALE, 1);

    const turning = time < this.turnCommandUntil;
    return {
      time,
      forwardDrive,
      turnDrive: turning ? this.turnCommandDrive : 0,
      // No startle pathway exists in this circuit. The Mauthner/escape system is
      // a different circuit and is not reconstructed here, so this stays zero
      // rather than being repurposed.
      startleDrive: 0,
      provenance: 'simulated',
    };
  }

  /* ---------------------------------------------------------- reporting */

  private describeDrives(populations: PopulationState): Drive[] {
    const readout = populations.populations.find((p) => p.id === 'SPN_turning');
    const integrator = populations.populations.find((p) => p.id === 'I');
    return [
      {
        id: 'explore',
        value: Math.min(Math.abs(populations.decisionVariable) / populations.threshold, 1),
        source: 'model',
        inputs: ['SPN_turning left', 'SPN_turning right'],
      },
      {
        id: 'seek-novelty',
        value: integrator ? Math.max(integrator.left, integrator.right) : 0,
        source: 'model',
        inputs: ['Class I population rate'],
      },
      {
        id: 'rest',
        value: readout ? 1 - Math.min(readout.left + readout.right, 1) : 1,
        source: 'model',
        inputs: ['SPN_turning population rate'],
      },
    ];
  }

  private describeProposals(time: number, populations: PopulationState): ActionProposal[] {
    // These are a faithful description of what the network state says, not a
    // separate decision process. The winner is whatever the circuit decided.
    const left = populations.populations.find((p) => p.id === 'SPN_turning')?.left ?? 0;
    const right = populations.populations.find((p) => p.id === 'SPN_turning')?.right ?? 0;
    const add = (action: ActionProposal['action'], utility: number, reason: string) => ({
      id: `n${++this.proposalCounter}`,
      action,
      utility,
      reason,
      source: 'Fish1 HMI simulation',
      time,
    });
    return [
      add('TURN_LEFT', left, `left SPN_turning population at ${left.toFixed(3)}`),
      add('TURN_RIGHT', right, `right SPN_turning population at ${right.toFixed(3)}`),
    ];
  }

  private describeSelection(
    time: number,
    proposals: ActionProposal[],
    motor: MotorCommand,
  ): SelectedAction | null {
    if (motor.turnDrive === 0) return null;
    const action = motor.turnDrive > 0 ? 'TURN_RIGHT' : 'TURN_LEFT';
    const winner = proposals.find((p) => p.action === action) ?? proposals[0];
    const intent = this.lastIntent;
    return {
      ...winner,
      action,
      reason: intent
        ? `decision variable ${intent.evidence.decisionVariable.toFixed(3)} crossed threshold ${intent.evidence.threshold.toFixed(2)} after ${intent.evidence.latency.toFixed(3)} s`
        : winner.reason,
      selectedAt: time,
      alternatives: proposals.filter((p) => p.action !== action),
    };
  }

  /**
   * Agent state under neural control.
   *
   * These remain simulation scalars and are not claims about the animal. Under
   * this controller they are derived from network state rather than from a
   * separate heuristic, so nothing competes with the circuit for control.
   */
  private updateAgentState(
    dt: number,
    sensory: SensoryFrame,
    populations: PopulationState,
  ): AgentState {
    const previous = this.agent;
    const integrator = populations.populations.find((p) => p.id === 'I');
    const activity = integrator ? Math.max(integrator.left, integrator.right) : 0;
    const exertion = sensory.internal.speed * 0.02;
    return {
      energy: Math.min(Math.max(previous.energy - exertion * dt + 0.015 * dt, 0), 1),
      novelty: Math.min(Math.max(this.evidence.coherence, 0), 1),
      arousal: Math.min(Math.max(activity * 2, 0), 1),
      threatEstimate: 0,
      explorationDrive: Math.min(
        Math.abs(populations.decisionVariable) / populations.threshold,
        1,
      ),
    };
  }
}
