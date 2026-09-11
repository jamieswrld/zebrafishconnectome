import type { BoneDescriptor } from '@/core/mesh';
import type { Vec3f } from '@/renderer/math';
import { BEHAVIOR_DT, PHYSICS_DT, SimulationClock, type TimeScale } from './clock';
import { FishBodyRuntime } from './body';
import { BaselineLocomotionController } from './controller';
import { AgentEventBus } from './events';
import { SensorRuntime } from './sensors';
import { WorldRuntime } from './world';
import {
  CapabilityGateway,
  SANDBOX_ECHO_CAPABILITY,
  SANDBOX_ECHO_EXECUTOR,
} from './capabilities';
import {
  IDLE_MOTOR_COMMAND,
  INITIAL_AGENT_STATE,
  type AgentState,
  type BehaviorController,
  type BodyState,
  type Drive,
  type MotorCommand,
  type SelectedAction,
  type SensoryFrame,
} from './types';

/**
 * The embodied runtime: one object that owns the closed loop.
 *
 *   world -> sensors -> controller -> motor -> body -> world
 *
 * Physics and behaviour run on their own fixed rates, independent of the render
 * frame rate, so results are reproducible and a slow frame cannot change the
 * simulation. Rendering reads whatever the latest state is.
 *
 * A future `NeuralRuntime` slots in by replacing `controller`. Nothing else in
 * this class needs to know.
 */

export interface EmbodiedRuntimeOptions {
  readonly bones: readonly BoneDescriptor[];
  readonly seed?: number;
}

export interface RuntimeSnapshot {
  readonly simulationTime: number;
  readonly realTime: number;
  readonly timeScale: TimeScale;
  readonly paused: boolean;
  readonly body: BodyState;
  readonly agent: AgentState;
  readonly drives: readonly Drive[];
  readonly motor: MotorCommand;
  readonly selected: SelectedAction | null;
  readonly sensory: SensoryFrame | null;
  readonly physicsSteps: number;
  readonly behaviorSteps: number;
  /** Milliseconds spent inside the last simulation update. */
  readonly updateMs: number;
}

export class EmbodiedRuntime {
  readonly clock = new SimulationClock();
  readonly world: WorldRuntime;
  readonly sensors = new SensorRuntime();
  readonly events = new AgentEventBus();
  readonly capabilities: CapabilityGateway;
  readonly body: FishBodyRuntime;

  controller: BehaviorController;

  private agent: AgentState = { ...INITIAL_AGENT_STATE };
  private drives: readonly Drive[] = [];
  private motor: MotorCommand = IDLE_MOTOR_COMMAND;
  private selected: SelectedAction | null = null;
  private sensory: SensoryFrame | null = null;
  private seed: number;
  private updateMs = 0;
  private actionsTaken = 0;
  private lastBehaviourAction: string | null = null;

  constructor(options: EmbodiedRuntimeOptions) {
    this.seed = options.seed ?? 20250610;
    this.world = new WorldRuntime({ seed: this.seed });
    this.body = new FishBodyRuntime({
      bones: options.bones,
      startPosition: [0, 0, 0],
      startHeading: 0,
    });
    this.controller = new BaselineLocomotionController();
    this.controller.reset(this.seed);

    this.events = this.events;
    this.capabilities = new CapabilityGateway(this.events);
    // The only registered capability performs no I/O of any kind. External
    // access is architecture here, not a feature.
    this.capabilities.register(SANDBOX_ECHO_CAPABILITY, SANDBOX_ECHO_EXECUTOR, 'observe');
  }

  setBones(bones: readonly BoneDescriptor[]): void {
    this.body.setBones(bones);
  }

  reset(seed = this.seed): void {
    this.seed = seed;
    this.clock.reset();
    this.world.reset(seed);
    this.sensors.reset();
    this.body.reset([0, 0, 0], 0);
    this.controller.reset(seed);
    this.events.clear();
    this.agent = { ...INITIAL_AGENT_STATE };
    this.drives = [];
    this.motor = IDLE_MOTOR_COMMAND;
    this.selected = null;
    this.sensory = null;
    this.actionsTaken = 0;
    this.lastBehaviourAction = null;
  }

  setTimeScale(scale: TimeScale): void {
    this.clock.setTimeScale(scale);
  }

  setPaused(paused: boolean): void {
    this.clock.setPaused(paused);
  }

  /**
   * Advances the simulation by one rendered frame of real time.
   *
   * @param realDt Wall-clock seconds since the previous frame.
   */
  update(realDt: number): RuntimeSnapshot {
    const started = performance.now();
    const tick = this.clock.advance(realDt);

    for (let b = 0; b < tick.behaviorSteps; b++) {
      this.stepBehaviour();
    }

    for (let p = 0; p < tick.physicsSteps; p++) {
      this.world.step(PHYSICS_DT);
      const boutStarted = this.body.step(PHYSICS_DT, this.motor, this.world);
      if (boutStarted) {
        this.sensors.noteBout(this.clock.time());
        this.actionsTaken++;
        this.events.emit({
          type: 'motor_command',
          timestamp: this.clock.time(),
          summary: `${this.body.state().boutState} started (forward ${this.motor.forwardDrive.toFixed(2)}, turn ${this.motor.turnDrive.toFixed(2)})`,
          payload: { motor: this.motor },
        });
      }
    }

    this.updateMs = performance.now() - started;
    return this.snapshot(tick.physicsSteps, tick.behaviorSteps);
  }

  private stepBehaviour(): void {
    const worldState = this.world.state();
    const bodyState = this.body.state();
    const sensory = this.sensors.sense(this.world, worldState, bodyState, BEHAVIOR_DT);
    this.sensory = sensory;

    if (sensory.contact.touching) {
      this.events.emit({
        type: 'boundary_contact',
        timestamp: sensory.time,
        summary: `Contact with the tank wall at ${sensory.contact.nearestBoundaryDistance.toFixed(2)} mm`,
        payload: { contact: sensory.contact },
      });
    }

    const output = this.controller.step(BEHAVIOR_DT, sensory, {
      agent: this.agent,
      world: worldState,
      body: bodyState,
    });

    this.agent = output.agent;
    this.drives = output.drives;
    this.motor = output.motor;
    this.selected = output.selected;

    // Only log a decision when it actually changes, otherwise the feed is
    // thousands of identical GLIDE lines and stops being readable.
    if (output.selected && output.selected.action !== this.lastBehaviourAction) {
      this.lastBehaviourAction = output.selected.action;
      for (const proposal of output.proposals) {
        this.events.emit({
          type: 'action_proposed',
          timestamp: sensory.time,
          summary: `${proposal.action} proposed (utility ${proposal.utility.toFixed(2)}) - ${proposal.reason}`,
          payload: { proposal },
        });
      }
      this.events.emit({
        type: 'action_selected',
        timestamp: sensory.time,
        summary: `${output.selected.action} selected - ${output.selected.reason}`,
        payload: { selected: output.selected, source: output.selected.source },
      });
    }
  }

  snapshot(physicsSteps = 0, behaviorSteps = 0): RuntimeSnapshot {
    return {
      simulationTime: this.clock.time(),
      realTime: this.clock.realElapsed(),
      timeScale: this.clock.timeScale(),
      paused: this.clock.paused(),
      body: this.body.state(),
      agent: this.agent,
      drives: this.drives,
      motor: this.motor,
      selected: this.selected,
      sensory: this.sensory,
      physicsSteps,
      behaviorSteps,
      updateMs: this.updateMs,
    };
  }

  totalActions(): number {
    return this.actionsTaken;
  }

  /** Organism position in world millimetres, for the follow camera. */
  position(): Vec3f {
    return this.body.state().position;
  }
}
