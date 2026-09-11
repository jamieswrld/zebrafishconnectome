/**
 * Simulation clock.
 *
 * Biology and agent timing must NOT be tied to requestAnimationFrame. A browser
 * frame is whatever the compositor feels like; a simulation step has to be a
 * fixed, reproducible quantity or nothing about the run is comparable.
 *
 * So: physics runs on a fixed timestep driven by an accumulator, behaviour runs
 * on a slower fixed rate, and rendering simply draws whatever the latest state
 * is. Time scale and pause affect simulation time only — never real time.
 */

export const PHYSICS_HZ = 120;
export const PHYSICS_DT = 1 / PHYSICS_HZ;

/**
 * Behaviour updates far slower than physics. Larval decision-making happens at
 * roughly bout frequency, not per millisecond, and it keeps the policy cheap.
 */
export const BEHAVIOR_HZ = 15;
export const BEHAVIOR_DT = 1 / BEHAVIOR_HZ;

/** Never simulate more than this much wall time in one frame. */
const MAX_FRAME_SECONDS = 0.25;

export const TIME_SCALES = [0, 0.25, 1, 4] as const;
export type TimeScale = (typeof TIME_SCALES)[number];

export interface ClockTick {
  /** Number of fixed physics steps to run this frame. */
  readonly physicsSteps: number;
  /** Number of behaviour steps to run this frame. */
  readonly behaviorSteps: number;
  /** Simulation time after this frame, seconds. */
  readonly simulationTime: number;
  /** Fraction into the next physics step, for render interpolation. */
  readonly alpha: number;
}

export class SimulationClock {
  private accumulator = 0;
  private behaviorAccumulator = 0;
  private simTime = 0;
  private realTime = 0;
  private scale: TimeScale = 1;
  private running = true;
  private steps = 0;

  /** Wall-clock seconds since the clock started. */
  realElapsed(): number {
    return this.realTime;
  }

  /** Simulation seconds elapsed. Affected by time scale and pause. */
  time(): number {
    return this.simTime;
  }

  totalSteps(): number {
    return this.steps;
  }

  timeScale(): TimeScale {
    return this.scale;
  }

  setTimeScale(scale: TimeScale): void {
    this.scale = scale;
  }

  paused(): boolean {
    return !this.running || this.scale === 0;
  }

  setPaused(paused: boolean): void {
    this.running = !paused;
  }

  reset(): void {
    this.accumulator = 0;
    this.behaviorAccumulator = 0;
    this.simTime = 0;
    this.realTime = 0;
    this.steps = 0;
  }

  /**
   * Advances by one rendered frame of real time.
   *
   * @param realDt Wall-clock seconds since the previous frame.
   */
  advance(realDt: number): ClockTick {
    // A long stall (tab backgrounded, GC pause) must not be simulated as a
    // burst of hundreds of steps; that would both spike the CPU and produce
    // physics that never happened smoothly.
    const clamped = Math.min(Math.max(realDt, 0), MAX_FRAME_SECONDS);
    // Real time is REAL: only the simulation is clamped. Clamping both would
    // make the organism's reported age quietly drift behind the wall clock
    // every time a frame stalled.
    this.realTime += Math.max(realDt, 0);

    if (this.paused()) {
      return {
        physicsSteps: 0,
        behaviorSteps: 0,
        simulationTime: this.simTime,
        alpha: 0,
      };
    }

    const simDelta = clamped * this.scale;
    this.accumulator += simDelta;
    this.behaviorAccumulator += simDelta;

    let physicsSteps = 0;
    while (this.accumulator >= PHYSICS_DT) {
      this.accumulator -= PHYSICS_DT;
      physicsSteps++;
    }
    this.simTime += physicsSteps * PHYSICS_DT;
    this.steps += physicsSteps;

    let behaviorSteps = 0;
    while (this.behaviorAccumulator >= BEHAVIOR_DT) {
      this.behaviorAccumulator -= BEHAVIOR_DT;
      behaviorSteps++;
    }

    return {
      physicsSteps,
      behaviorSteps,
      simulationTime: this.simTime,
      alpha: this.accumulator / PHYSICS_DT,
    };
  }
}
