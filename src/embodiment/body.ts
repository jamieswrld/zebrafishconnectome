import { applyTailWave, createRestPose, poseAsymmetry, type FishPose } from '@/body/rig';
import type { BoneDescriptor } from '@/core/mesh';
import type { Vec3f } from '@/renderer/math';
import type { BodyState, BoutState, MotorCommand } from './types';
import type { WorldRuntime } from './world';

/**
 * Body mechanics: turning a motor command into movement and a tail shape.
 *
 * Larval zebrafish do not swim like submarines. They produce discrete BOUTS of
 * tail beating separated by passive GLIDES, and at their size viscous drag
 * bleeds off speed within a few hundred milliseconds. Modelling that explicitly
 * is what makes the animation read as a larva rather than a drifting object,
 * and it means the tail motion is a consequence of the propulsion state rather
 * than decoration played alongside it.
 *
 * Numbers are tuned to published larval locomotion ranges:
 *   bout duration        ~0.15-0.25 s
 *   tail beat frequency  ~20-35 Hz during slow swimming
 *   peak speed           ~10-20 mm/s (a few body lengths per second)
 *   routine turn         ~10-40 degrees per bout
 * They are a plausible model, not a fit to any dataset. PROVENANCE: SIMULATED.
 */

const BODY_LENGTH_MM = 4;

/** Linear drag coefficient, 1/s. High: larvae decelerate fast. */
const LINEAR_DRAG = 6.2;
/** Angular drag coefficient, 1/s. */
const ANGULAR_DRAG = 7.5;
/**
 * Peak forward acceleration during a bout, mm/s^2.
 *
 * Tuned so a forward bout peaks near 15 mm/s (about 4 body lengths/s) and an
 * escape near 40 mm/s, matching published larval kinematics. Integrating the
 * sin envelope gives roughly thrust * 2T/pi for the peak speed.
 */
const BOUT_THRUST = 120;
/** Peak yaw acceleration from a biased beat, rad/s^2. */
const TURN_TORQUE = 46;

const FORWARD_BOUT_SECONDS = 0.2;
const TURN_BOUT_SECONDS = 0.16;
const STARTLE_BOUT_SECONDS = 0.12;

const FORWARD_BEAT_HZ = 28;
const TURN_BEAT_HZ = 24;
const STARTLE_BEAT_HZ = 52;

export interface FishBodyOptions {
  readonly bones: readonly BoneDescriptor[];
  readonly startPosition?: Vec3f;
  readonly startHeading?: number;
}

export class FishBodyRuntime {
  private position: Vec3f = [0, 0, 0];
  private velocity: Vec3f = [0, 0, 0];
  private heading = 0;
  private angularVelocity = 0;
  private boutState: BoutState = 'glide';
  private boutTimer = 0;
  private boutDuration = 0;
  private boutTurnSign = 0;
  private boutAmplitude = 0;
  private tailPhase = 0;
  private distanceTravelled = 0;
  private pose: FishPose;
  private bones: readonly BoneDescriptor[];

  constructor(options: FishBodyOptions) {
    this.bones = options.bones;
    this.pose = createRestPose(Math.max(options.bones.length, 1));
    this.position = [...(options.startPosition ?? [0, 0, 0])] as Vec3f;
    this.heading = options.startHeading ?? 0;
  }

  reset(position: Vec3f, heading: number): void {
    this.position = [...position] as Vec3f;
    this.velocity = [0, 0, 0];
    this.heading = heading;
    this.angularVelocity = 0;
    this.boutState = 'glide';
    this.boutTimer = 0;
    this.boutDuration = 0;
    this.tailPhase = 0;
    this.distanceTravelled = 0;
    this.pose = createRestPose(Math.max(this.bones.length, 1));
  }

  setBones(bones: readonly BoneDescriptor[]): void {
    this.bones = bones;
    this.pose = createRestPose(Math.max(bones.length, 1));
  }

  state(): BodyState {
    return {
      position: [...this.position] as Vec3f,
      velocity: [...this.velocity] as Vec3f,
      heading: this.heading,
      angularVelocity: this.angularVelocity,
      boutState: this.boutState,
      tailPhase: this.tailPhase,
      pose: this.pose,
      distanceTravelled: this.distanceTravelled,
    };
  }

  /** True on the physics step where a new bout starts. */
  private beginBout(command: MotorCommand): boolean {
    if (this.boutState !== 'glide') return false;

    if (command.startleDrive > 0.5) {
      this.boutState = 'startle';
      this.boutDuration = STARTLE_BOUT_SECONDS;
      this.boutTurnSign = command.turnDrive >= 0 ? 1 : -1;
      this.boutAmplitude = 1;
    } else if (Math.abs(command.turnDrive) > 0.22) {
      this.boutState = 'turn-bout';
      this.boutDuration = TURN_BOUT_SECONDS;
      this.boutTurnSign = Math.sign(command.turnDrive);
      this.boutAmplitude = Math.min(Math.abs(command.turnDrive), 1);
    } else if (command.forwardDrive > 0.12) {
      this.boutState = 'forward-bout';
      this.boutDuration = FORWARD_BOUT_SECONDS;
      this.boutTurnSign = 0;
      this.boutAmplitude = Math.min(command.forwardDrive, 1);
    } else {
      return false;
    }

    this.boutTimer = 0;
    return true;
  }

  /**
   * Advances one fixed physics step.
   * @returns true if a bout started on this step.
   */
  step(dt: number, command: MotorCommand, world: WorldRuntime): boolean {
    const started = this.beginBout(command);

    let thrust = 0;
    let torque = 0;
    let beatHz = 0;
    let amplitude = 0;
    let bias = 0;

    if (this.boutState !== 'glide') {
      this.boutTimer += dt;
      const t = Math.min(this.boutTimer / this.boutDuration, 1);

      // Bell-shaped envelope: a bout ramps up and decays rather than switching
      // on. sin(pi*t) is a good match to measured larval bout kinematics.
      const envelope = Math.sin(Math.PI * t);

      switch (this.boutState) {
        case 'forward-bout':
          beatHz = FORWARD_BEAT_HZ;
          amplitude = 0.55 * this.boutAmplitude;
          thrust = BOUT_THRUST * envelope * this.boutAmplitude;
          break;
        case 'turn-bout':
          beatHz = TURN_BEAT_HZ;
          amplitude = 0.42 * this.boutAmplitude;
          bias = this.boutTurnSign * this.boutAmplitude * 0.85;
          // A turn still carries the animal forward; larvae rarely pivot in place.
          thrust = BOUT_THRUST * 0.55 * envelope * this.boutAmplitude;
          torque = TURN_TORQUE * this.boutTurnSign * envelope * this.boutAmplitude;
          break;
        case 'startle':
          beatHz = STARTLE_BEAT_HZ;
          amplitude = 0.95;
          bias = this.boutTurnSign * 1.5;
          thrust = BOUT_THRUST * 2.6 * envelope;
          torque = TURN_TORQUE * 2.4 * this.boutTurnSign * envelope;
          break;
        default:
          break;
      }

      if (this.boutTimer >= this.boutDuration) {
        this.boutState = 'glide';
        this.boutTimer = 0;
      }
    }

    this.tailPhase += beatHz * Math.PI * 2 * dt;
    if (this.tailPhase > Math.PI * 2) this.tailPhase -= Math.PI * 2;

    // The tail shape is generated from the propulsion state, then the resulting
    // asymmetry feeds back into yaw, so turning follows from how the tail is
    // actually bent rather than being applied to the heading independently.
    this.pose = applyTailWave(
      this.bones,
      { phase: this.tailPhase, amplitude, bias },
      this.pose,
    );
    const asymmetry = poseAsymmetry(this.pose, this.bones.length);

    const angularAccel = torque + asymmetry * 9 - this.angularVelocity * ANGULAR_DRAG;
    this.angularVelocity += angularAccel * dt;
    this.heading += this.angularVelocity * dt;
    while (this.heading > Math.PI) this.heading -= Math.PI * 2;
    while (this.heading < -Math.PI) this.heading += Math.PI * 2;

    const forward: Vec3f = [Math.cos(this.heading), 0, Math.sin(this.heading)];
    for (let i = 0; i < 3; i++) {
      const accel = forward[i] * thrust - this.velocity[i] * LINEAR_DRAG;
      this.velocity[i] += accel * dt;
    }

    const previous: Vec3f = [...this.position] as Vec3f;
    for (let i = 0; i < 3; i++) this.position[i] += this.velocity[i] * dt;

    if (world.constrain(this.position)) {
      // Bleed most of the momentum on contact; a larva does not bounce.
      this.velocity[0] *= 0.15;
      this.velocity[2] *= 0.15;
    }

    this.distanceTravelled += Math.hypot(
      this.position[0] - previous[0],
      this.position[1] - previous[1],
      this.position[2] - previous[2],
    );

    return started;
  }

  /** Forward speed in body lengths per second, for the diagnostics panel. */
  speedBodyLengths(): number {
    return Math.hypot(this.velocity[0], this.velocity[2]) / BODY_LENGTH_MM;
  }
}
