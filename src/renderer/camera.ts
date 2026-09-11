import {
  clamp,
  damp,
  dampAngle,
  lookAt,
  mat4,
  multiply,
  perspectiveNO,
  perspectiveZO,
  type Mat4,
  type Vec3f,
} from './math';

/**
 * Orbit camera.
 *
 * State is stored as a target point plus spherical offset, which keeps the
 * "focus on this neuron" interaction trivial and avoids gimbal problems at the
 * poles (pitch is hard-clamped just short of vertical).
 *
 * Every animated quantity is smoothed with a half-life rather than a fixed
 * per-frame lerp, so motion is identical at 30 and 144 Hz. Smoothing is
 * disabled entirely when the user prefers reduced motion.
 */

export interface CameraState {
  target: Vec3f;
  distance: number;
  /** Azimuth, radians. */
  yaw: number;
  /** Elevation, radians, clamped to +/- (pi/2 - epsilon). */
  pitch: number;
  fovY: number;
}

export interface CameraPreset {
  readonly id: string;
  readonly label: string;
  /** Anatomical name when the dataset documents its axes, else an axis name. */
  readonly yaw: number;
  readonly pitch: number;
}

const PITCH_LIMIT = Math.PI / 2 - 0.02;
const MIN_DISTANCE = 0.02;
const MAX_DISTANCE = 200;

export class OrbitCamera {
  /** Where the camera is heading. User input writes here. */
  readonly desired: CameraState;
  /** Where the camera actually is. Rendering reads here. */
  readonly current: CameraState;

  private readonly viewMatrix = mat4();
  private readonly projMatrix = mat4();
  private readonly viewProjMatrix = mat4();

  /** Set false to snap instantly (respects prefers-reduced-motion). */
  smoothing = true;
  /** Seconds for half the remaining distance to be covered. */
  halfLife = 0.08;

  constructor(initial?: Partial<CameraState>) {
    const base: CameraState = {
      target: [0, 0, 0],
      distance: 3.2,
      yaw: 0.6,
      pitch: 0.35,
      fovY: (38 * Math.PI) / 180,
      ...initial,
    };
    this.desired = { ...base, target: [...base.target] as Vec3f };
    this.current = { ...base, target: [...base.target] as Vec3f };
  }

  orbit(deltaYaw: number, deltaPitch: number): void {
    this.desired.yaw += deltaYaw;
    this.desired.pitch = clamp(this.desired.pitch + deltaPitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /** Pans in the camera plane; speed scales with distance so it feels constant. */
  pan(deltaX: number, deltaY: number): void {
    const { yaw, pitch, distance } = this.current;
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);
    const sp = Math.sin(pitch);
    const cp = Math.cos(pitch);

    // Camera basis vectors derived from the spherical offset.
    const right: Vec3f = [cy, 0, -sy];
    const up: Vec3f = [-sy * sp, cp, -cy * sp];

    const k = distance * Math.tan(this.current.fovY / 2) * 2;
    for (let i = 0; i < 3; i++) {
      this.desired.target[i] += (-right[i] * deltaX + up[i] * deltaY) * k;
    }
  }

  /** Multiplicative zoom keeps each wheel notch feeling equal at any scale. */
  zoom(factor: number): void {
    this.desired.distance = clamp(this.desired.distance * factor, MIN_DISTANCE, MAX_DISTANCE);
  }

  setDistance(d: number): void {
    this.desired.distance = clamp(d, MIN_DISTANCE, MAX_DISTANCE);
  }

  focus(point: Vec3f, distance?: number): void {
    this.desired.target = [point[0], point[1], point[2]];
    if (distance !== undefined) this.setDistance(distance);
  }

  applyPreset(preset: CameraPreset): void {
    this.desired.yaw = preset.yaw;
    this.desired.pitch = clamp(preset.pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  snap(): void {
    this.current.target = [...this.desired.target] as Vec3f;
    this.current.distance = this.desired.distance;
    this.current.yaw = this.desired.yaw;
    this.current.pitch = this.desired.pitch;
    this.current.fovY = this.desired.fovY;
  }

  /** Advances smoothing. Returns true while the camera is still moving. */
  update(dt: number): boolean {
    if (!this.smoothing) {
      const moved = this.isMoving();
      this.snap();
      return moved;
    }
    const c = this.current;
    const d = this.desired;
    const hl = this.halfLife;
    for (let i = 0; i < 3; i++) {
      c.target[i] = damp(c.target[i], d.target[i], hl, dt);
    }
    c.distance = damp(c.distance, d.distance, hl, dt);
    c.yaw = dampAngle(c.yaw, d.yaw, hl, dt);
    c.pitch = damp(c.pitch, d.pitch, hl, dt);
    c.fovY = damp(c.fovY, d.fovY, hl, dt);
    return this.isMoving();
  }

  private isMoving(): boolean {
    const c = this.current;
    const d = this.desired;
    const eps = 1e-5;
    return (
      Math.abs(c.distance - d.distance) > eps * d.distance ||
      Math.abs(c.yaw - d.yaw) > eps ||
      Math.abs(c.pitch - d.pitch) > eps ||
      Math.abs(c.target[0] - d.target[0]) > eps ||
      Math.abs(c.target[1] - d.target[1]) > eps ||
      Math.abs(c.target[2] - d.target[2]) > eps
    );
  }

  eye(): Vec3f {
    const { target, distance, yaw, pitch } = this.current;
    const cp = Math.cos(pitch);
    return [
      target[0] + distance * cp * Math.sin(yaw),
      target[1] + distance * Math.sin(pitch),
      target[2] + distance * cp * Math.cos(yaw),
    ];
  }

  /**
   * Near/far are derived from the orbit distance so precision stays usable
   * across the whole-brain-to-single-neuron zoom range.
   */
  clipPlanes(): [number, number] {
    const d = this.current.distance;
    return [Math.max(d * 0.002, 1e-4), d * 12 + 20];
  }

  matrices(
    aspect: number,
    depthZeroToOne: boolean,
  ): {
    view: Mat4;
    proj: Mat4;
    viewProj: Mat4;
  } {
    const [near, far] = this.clipPlanes();
    lookAt(this.viewMatrix, this.eye(), this.current.target, [0, 1, 0]);
    if (depthZeroToOne) {
      perspectiveZO(this.projMatrix, this.current.fovY, aspect, near, far);
    } else {
      perspectiveNO(this.projMatrix, this.current.fovY, aspect, near, far);
    }
    multiply(this.viewProjMatrix, this.projMatrix, this.viewMatrix);
    return { view: this.viewMatrix, proj: this.projMatrix, viewProj: this.viewProjMatrix };
  }

  serialize(): string {
    const c = this.desired;
    const r = (n: number) => Math.round(n * 1000) / 1000;
    return [
      r(c.target[0]),
      r(c.target[1]),
      r(c.target[2]),
      r(c.distance),
      r(c.yaw),
      r(c.pitch),
    ].join(',');
  }

  static deserialize(s: string): Partial<CameraState> | null {
    const parts = s.split(',').map(Number);
    if (parts.length !== 6 || parts.some((n) => !Number.isFinite(n))) return null;
    return {
      target: [parts[0], parts[1], parts[2]],
      distance: clamp(parts[3], MIN_DISTANCE, MAX_DISTANCE),
      yaw: parts[4],
      pitch: clamp(parts[5], -PITCH_LIMIT, PITCH_LIMIT),
    };
  }
}

/**
 * Axis-named presets. Anatomical labels are applied by the UI only when the
 * dataset documents its axis orientation - guessing "dorsal" from a raw voxel
 * axis would be an unsupported anatomical claim.
 */
export const AXIS_PRESETS: readonly CameraPreset[] = [
  { id: 'neg-z', label: '-Z', yaw: 0, pitch: 0 },
  { id: 'pos-z', label: '+Z', yaw: Math.PI, pitch: 0 },
  { id: 'pos-x', label: '+X', yaw: Math.PI / 2, pitch: 0 },
  { id: 'neg-x', label: '-X', yaw: -Math.PI / 2, pitch: 0 },
  { id: 'pos-y', label: '+Y', yaw: 0, pitch: Math.PI / 2 - 0.02 },
  { id: 'neg-y', label: '-Y', yaw: 0, pitch: -(Math.PI / 2 - 0.02) },
];

export const DEFAULT_VIEW: CameraPreset = {
  id: 'default',
  label: 'DEFAULT',
  yaw: 0.6,
  pitch: 0.35,
};
