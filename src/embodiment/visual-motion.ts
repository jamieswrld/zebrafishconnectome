import { SeededRandom } from '@/core/random';
import type { EvidenceProvenance } from '@/core/provenance';
import type { NeuralSensoryInput } from '@/neural/types';

/**
 * Visual motion stimulus and sensory encoder.
 *
 *   stimulus + fish pose  ->  VisualMotionEvidence  ->  NeuralSensoryInput
 *
 * SIMULATED SENSOR. This is a coherent-motion stimulus summarised into two
 * directional drives. It is NOT a retina: there are no photoreceptors, no
 * receptive fields and no direction-selective cells, and nothing here should be
 * described as retinal processing.
 *
 * WHERE THE RANDOMNESS LIVES
 *
 * In a motion-coherence task the trial-to-trial variability comes from the
 * stimulus itself: a finite number of dots, a fraction `coherence` of which move
 * together while the rest move randomly. Sampling that finite dot population is
 * what makes the evidence fluctuate, and it is why a psychometric function is
 * graded rather than a step. So the stimulus is modelled with an explicit dot
 * count and resampled every update, instead of handing the network a clean
 * number and adding fake noise afterwards.
 */

export type MotionDirection = 'left' | 'right';

export interface VisualMotionStimulus {
  readonly direction: MotionDirection;
  /** Fraction of dots moving coherently, 0..1. */
  readonly coherence: number;
  /** Angular speed of the pattern, radians per second. */
  readonly speed: number;
  /** Seconds the stimulus runs. */
  readonly duration: number;
  /** Extra sensory noise beyond finite-dot sampling, 0..1. */
  readonly noise: number;
  /** Michelson contrast of the pattern, 0..1. Scales effective drive. */
  readonly contrast: number;
  /** Number of dots sampled. Fewer dots means noisier evidence. */
  readonly dots: number;
}

export const DEFAULT_STIMULUS: VisualMotionStimulus = {
  direction: 'right',
  coherence: 0.6,
  speed: 0.6,
  duration: 12,
  noise: 0,
  contrast: 1,
  dots: 120,
};

/** What the fish's visual system reports. Simulated, and labelled as such. */
export interface VisualMotionEvidence {
  readonly time: number;
  /** 0..1 evidence favouring leftward motion. */
  readonly leftwardEvidence: number;
  readonly rightwardEvidence: number;
  /** Coherence of the stimulus that produced it. */
  readonly coherence: number;
  /**
   * Net angular velocity of the pattern across the retina, radians per second.
   * In closed loop this includes the fish's own rotation.
   */
  readonly angularVelocity: number;
  readonly provenance: Extract<EvidenceProvenance, 'simulated'>;
}

export const ZERO_EVIDENCE: VisualMotionEvidence = {
  time: 0,
  leftwardEvidence: 0,
  rightwardEvidence: 0,
  coherence: 0,
  angularVelocity: 0,
  provenance: 'simulated',
};

export type LoopMode = 'open' | 'closed';

/**
 * Turns a stimulus into evidence.
 *
 * OPEN LOOP   the pattern's retinal motion is the stimulus motion. Useful for
 *             validating the circuit, because the input is fully controlled.
 *
 * CLOSED LOOP the fish's own rotation subtracts from the pattern's motion, so
 *             turning toward the motion reduces the evidence driving the turn.
 *             This is the negative feedback that makes the loop a loop: without
 *             it the fish would spin forever.
 */
export class VisualMotionEncoder {
  private random = new SeededRandom(1);
  private stimulus: VisualMotionStimulus = DEFAULT_STIMULUS;
  private loopMode: LoopMode = 'closed';
  private elapsed = 0;
  private active = false;

  reset(seed: number): void {
    this.random.reset(seed);
    this.elapsed = 0;
    this.active = false;
  }

  start(stimulus: VisualMotionStimulus, loopMode: LoopMode): void {
    this.stimulus = stimulus;
    this.loopMode = loopMode;
    this.elapsed = 0;
    this.active = true;
  }

  stop(): void {
    this.active = false;
  }

  isActive(): boolean {
    return this.active && this.elapsed < this.stimulus.duration;
  }

  current(): VisualMotionStimulus {
    return this.stimulus;
  }

  mode(): LoopMode {
    return this.loopMode;
  }

  /** Seconds since this stimulus started. */
  elapsedSeconds(): number {
    return this.elapsed;
  }

  /**
   * @param dt              Seconds since the previous sensory update.
   * @param time            Simulation time, for the returned frame.
   * @param bodyAngularRate The fish's own yaw rate, radians per second.
   */
  sense(dt: number, time: number, bodyAngularRate: number): VisualMotionEvidence {
    if (!this.active) return { ...ZERO_EVIDENCE, time };
    this.elapsed += dt;
    if (this.elapsed >= this.stimulus.duration) {
      this.active = false;
      return { ...ZERO_EVIDENCE, time };
    }

    const stimulus = this.stimulus;
    const signed = stimulus.direction === 'right' ? 1 : -1;

    // In closed loop, rotating with the pattern cancels its retinal motion. A
    // positive yaw rate is a turn to the right, which reduces rightward flow.
    const retinalVelocity =
      this.loopMode === 'closed'
        ? signed * stimulus.speed - bodyAngularRate
        : signed * stimulus.speed;

    // Finite-dot sampling. Each dot is coherent with probability `coherence`
    // and otherwise moves in a random direction, so the measured fraction
    // fluctuates from update to update exactly as it would in a real stimulus.
    const dots = Math.max(1, Math.round(stimulus.dots));
    let net = 0;
    for (let i = 0; i < dots; i++) {
      const coherent = this.random.float() < stimulus.coherence;
      if (coherent) net += Math.sign(retinalVelocity) || 0;
      else net += this.random.float() < 0.5 ? 1 : -1;
    }
    let fraction = net / dots; // -1 .. 1

    if (stimulus.noise > 0) {
      fraction += this.random.gaussian() * stimulus.noise * 0.5;
    }

    // Faster patterns drive the system harder, up to a saturating speed.
    const speedFactor = Math.min(Math.abs(retinalVelocity) / 0.6, 1.5);
    const magnitude = Math.min(Math.abs(fraction) * stimulus.contrast * speedFactor, 1);
    const toRight = fraction >= 0;

    // Evidence is expressed as a balanced pair so a 50/50 stimulus delivers
    // equal drive to both sides rather than nothing to either.
    const bias = magnitude * 0.5;
    return {
      time,
      leftwardEvidence: Math.min(Math.max(0.5 - (toRight ? bias : -bias), 0), 1),
      rightwardEvidence: Math.min(Math.max(0.5 + (toRight ? bias : -bias), 0), 1),
      coherence: stimulus.coherence,
      angularVelocity: retinalVelocity,
      provenance: 'simulated',
    };
  }
}

/**
 * The one place visual evidence becomes circuit input.
 *
 * Kept as a separate named function because it is a scientific claim, not
 * plumbing: it asserts which side of the brain receives which evidence. See
 * SENSORY_INTERFACE in src/neural/network.ts for the justification and for what
 * is explicitly not known.
 */
export function evidenceToNeuralInput(evidence: VisualMotionEvidence): NeuralSensoryInput {
  return {
    leftDrive: evidence.leftwardEvidence,
    rightDrive: evidence.rightwardEvidence,
    coherence: evidence.coherence,
  };
}
