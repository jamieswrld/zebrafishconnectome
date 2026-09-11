import { identity, mat4, multiply, type Mat4 } from '@/renderer/math';
import { HEAD_END_U, SNOUT_X_UM } from './larva';
import { BODY_LENGTH_UM } from '@/core/transforms';
import type { BoneDescriptor } from '@/core/mesh';

/**
 * Skeletal deformation for the reference body.
 *
 * A larval zebrafish swims by passing a travelling wave of lateral curvature
 * down its body. In body rest space that is rotation about +Y (dorsoventral),
 * applied at each bone's head, inherited down the chain.
 *
 * Everything here is a PRESENTATION transform. It changes where tissue and
 * spinal neurons are DRAWN; it never touches a measured coordinate.
 */

/** Hard cap so the skinning uniform block has a fixed size on both backends. */
export const MAX_BONES = 16;

export interface FishPose {
  /** Lateral rotation per bone, radians, about the dorsoventral axis. */
  readonly boneAngles: Float32Array;
  /** Phase of the tail beat, radians. Diagnostic only. */
  readonly tailPhase: number;
  /** Peak lateral excursion of the tail tip in body units, diagnostic. */
  readonly tailAmplitude: number;
}

export function createRestPose(boneCount: number): FishPose {
  return {
    boneAngles: new Float32Array(boneCount),
    tailPhase: 0,
    tailAmplitude: 0,
  };
}

/**
 * Computes one skinning matrix per bone, mapping rest space to posed space.
 *
 * For bone i with rest head `h` and lateral angle `theta`:
 *   M_i = M_parent * T(h) * RotY(theta) * T(-h)
 *
 * Rotating about the bone's own rest head keeps the joint anchored, and
 * inheriting the parent's matrix makes curvature accumulate along the body, so
 * the tail sweeps much further than the trunk from the same per-bone angle.
 *
 * @param out Float32Array of MAX_BONES * 16, reused across frames.
 */
export function computeBoneMatrices(
  bones: readonly BoneDescriptor[],
  pose: FishPose,
  out: Float32Array,
): Float32Array {
  const scratch = mat4();
  const pivot = mat4();
  const matrices: Mat4[] = [];

  for (let i = 0; i < bones.length && i < MAX_BONES; i++) {
    const bone = bones[i];
    const theta = pose.boneAngles[i] ?? 0;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const [hx, hy, hz] = bone.headUm;

    // T(h) * RotY(theta) * T(-h), written directly.
    identity(pivot);
    pivot[0] = c;
    pivot[2] = -s;
    pivot[8] = s;
    pivot[10] = c;
    pivot[12] = hx - (c * hx + s * hz);
    pivot[13] = hy - hy;
    pivot[14] = hz - (-s * hx + c * hz);

    const local = mat4();
    if (bone.parent >= 0 && matrices[bone.parent]) {
      multiply(local, matrices[bone.parent], pivot);
    } else {
      local.set(pivot);
    }
    matrices[i] = local;
    out.set(local, i * 16);
  }

  // Any unused slots stay identity so a stray bone index cannot collapse a
  // vertex to the origin.
  for (let i = bones.length; i < MAX_BONES; i++) {
    identity(scratch);
    out.set(scratch, i * 16);
  }
  return out;
}

/** Applies the skinning matrices to a rest-space point on the CPU. */
export function skinPoint(
  restPoint: readonly [number, number, number],
  boneMatrices: Float32Array,
  indices: readonly [number, number],
  weights: readonly [number, number],
): [number, number, number] {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let k = 0; k < 2; k++) {
    const w = weights[k];
    if (w <= 0) continue;
    const o = indices[k] * 16;
    x +=
      w *
      (boneMatrices[o] * restPoint[0] +
        boneMatrices[o + 4] * restPoint[1] +
        boneMatrices[o + 8] * restPoint[2] +
        boneMatrices[o + 12]);
    y +=
      w *
      (boneMatrices[o + 1] * restPoint[0] +
        boneMatrices[o + 5] * restPoint[1] +
        boneMatrices[o + 9] * restPoint[2] +
        boneMatrices[o + 13]);
    z +=
      w *
      (boneMatrices[o + 2] * restPoint[0] +
        boneMatrices[o + 6] * restPoint[1] +
        boneMatrices[o + 10] * restPoint[2] +
        boneMatrices[o + 14]);
  }
  return [x, y, z];
}

/* -------------------------------------------------------------------------- */
/* Tail kinematics                                                            */
/* -------------------------------------------------------------------------- */

export interface TailWaveInput {
  /** Phase of the beat cycle, radians. */
  readonly phase: number;
  /** Overall beat amplitude, 0 at rest. */
  readonly amplitude: number;
  /**
   * Steady asymmetry added to the wave. This is what turns a symmetric forward
   * beat into a turn: real larval turns are produced by a biased beat, not by
   * rotating the animal directly.
   */
  readonly bias: number;
  /** Wavelength as a fraction of body length. */
  readonly wavelength?: number;
}

/**
 * Writes a travelling-wave pose into `pose.boneAngles`.
 *
 * Amplitude grows toward the tail (roughly quadratically), which is the
 * defining feature of anguilliform/subcarangiform larval swimming: the head
 * barely moves while the tail sweeps widely.
 */
export function applyTailWave(
  bones: readonly BoneDescriptor[],
  input: TailWaveInput,
  pose: FishPose,
): FishPose {
  const wavelength = input.wavelength ?? 0.75;
  const angles = pose.boneAngles;
  const spineSpan = BODY_LENGTH_UM - HEAD_END_U;

  // The head bone never bends; the body pivots around it.
  angles[0] = 0;

  let tipLateral = 0;
  for (let i = 1; i < bones.length && i < MAX_BONES; i++) {
    const u = SNOUT_X_UM - bones[i].headUm[0];
    // 0 at the head/trunk junction, 1 at the tail tip.
    const s = Math.min(Math.max((u - HEAD_END_U) / spineSpan, 0), 1);

    // Posterior bones contribute far more curvature.
    const envelope = s * s * 0.85 + s * 0.15;
    const travelling = Math.sin(input.phase - (s / wavelength) * Math.PI * 2);

    angles[i] = (travelling * input.amplitude + input.bias * envelope) * envelope * 0.55;
    tipLateral += Math.sin(angles[i]) * (spineSpan / bones.length);
  }

  return {
    boneAngles: angles,
    tailPhase: input.phase,
    tailAmplitude: Math.abs(tipLateral),
  };
}

/**
 * Net lateral asymmetry of the current pose.
 *
 * Used by the body physics to convert a biased beat into yaw, so turning is a
 * consequence of how the tail is actually shaped rather than an independent
 * number applied to the heading.
 */
export function poseAsymmetry(pose: FishPose, boneCount: number): number {
  let sum = 0;
  let weight = 0;
  for (let i = 1; i < boneCount && i < MAX_BONES; i++) {
    const w = i;
    sum += pose.boneAngles[i] * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : 0;
}
