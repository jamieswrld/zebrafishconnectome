import { HMI_CLASS_ORDER, type HmiClass } from '@/core/hmi';
import type { NeuralNetwork } from './network';
import type { Ablation } from './types';

/**
 * The dynamical model.
 *
 * A firing-rate network. Chosen over anything more elaborate for a reason
 * stated plainly: the measured data constrains connectivity, sign and synapse
 * count, and nothing else. There are no membrane recordings, no synaptic
 * conductances and no time constants in this dataset, so a
 * conductance-based or spiking model would require inventing far more
 * parameters than the data can support, and every one of them would be a free
 * knob that could be tuned until the demo worked.
 *
 * The equations, for every node i:
 *
 *   tau dx_i/dt = -x_i + sum_j W_ij r_j + P_i + I_i + sigma xi_i
 *   r_i = clamp(x_i, 0, 1)
 *
 * where
 *   W_ij  measured synaptic weight, signed by the presynaptic cell's published
 *         neurotransmitter under Dale's law, normalised per postsynaptic cell
 *   P_i   modeled population projections (see network.ts) - one term, ablatable
 *   I_i   sensory drive into the traced input layer
 *   xi_i  seeded Gaussian noise, so a run is reproducible but not sterile
 *
 * WHY THIS INTEGRATES
 *
 * Integration is not imposed by a long time constant. tau is 100 ms, which is a
 * membrane-like value, and the slow accumulation comes from the measured
 * recurrent Class I to Class I connectivity: 300 traced pairs, every one of
 * them within a single hemisphere. With incoming weights normalised per node,
 * the weight matrix has an infinity-norm of at most 1, so with recurrent gain g
 * the effective integration time constant is tau / (1 - g) - one second at the
 * default g = 0.9. Removing the recurrence shortens it back to tau, which is
 * exactly what the ablation test checks.
 */

/** Membrane-like time constant, seconds. */
export const TAU_SECONDS = 0.1;

/**
 * Fixed neural integration step, seconds. 200 Hz.
 *
 * tau / dt = 20, so forward Euler is comfortably stable, and the step is
 * decoupled from the render rate entirely.
 */
export const NEURAL_DT = 0.005;

/**
 * Noise standard deviation per unit time.
 *
 * Set so that genuinely ambiguous evidence produces a stochastic outcome rather
 * than a deterministic tie. Too little noise and a 50/50 stimulus sits forever
 * at exactly zero, which no real decision circuit does; too much and the
 * stimulus stops mattering. Scaled by sqrt(dt), so changing NEURAL_DT does not
 * change the noise statistics.
 */
export const NOISE_SIGMA = 0.25;

/** How hard sensory evidence drives the input layer. */
export const SENSORY_GAIN = 0.55;

/**
 * Decision threshold on the signed readout difference.
 *
 * Applies to (right readout - left readout), where the readouts are the mean
 * rate of the measured SPN_turning population on each side.
 *
 * A threshold is a free parameter of any decision model - it is the
 * speed-accuracy tradeoff, and no connectome can supply it. This value was
 * chosen against a stated criterion rather than tuned for appearance: it should
 * put decision latencies in the few-hundred-millisecond range over which larval
 * zebrafish actually make optomotor turns, and it should leave weak evidence
 * undecided rather than forcing a guess.
 *
 * Measured over 40 seeds per level (scripts/psychometric.mjs), the resulting
 * chronometric function is:
 *
 *   coherence 1.00   median latency 0.275 s
 *   coherence 0.70   median latency 0.355 s
 *   coherence 0.50   median latency 0.495 s
 *   coherence 0.40   median latency 0.675 s
 *   coherence 0.30   no decision within 10 s
 *
 * Latency falling monotonically with evidence strength is a property of the
 * model, not something imposed: nothing in the code consults coherence when
 * deciding when to fire. The threshold is adjustable in the UI.
 */
export const DECISION_THRESHOLD = 0.15;

/** A decision cannot be re-issued until this much simulated time has passed. */
export const DECISION_REFRACTORY_SECONDS = 1.2;

/** The measured population read out as motor intent. */
export const READOUT_CLASS: HmiClass = 'SPN_turning';

/**
 * Per-run masks derived from the active ablations.
 *
 * Kept as flat arrays rebuilt only when the ablation set changes, so the inner
 * loop never branches on ablation logic.
 */
export interface AblationMasks {
  /** Multiplies each node's output rate. 0 silences it. */
  readonly nodeMask: Float32Array;
  /** Multiplies each incoming-CSR entry. 0 removes that connection. */
  readonly edgeMask: Float32Array;
  /** Ids of modeled projections disabled by an ablation. */
  readonly disabledProjections: ReadonlySet<string>;
}

export function buildAblationMasks(
  network: NeuralNetwork,
  ablations: readonly Ablation[],
): AblationMasks {
  const nodeMask = new Float32Array(network.nodeCount).fill(1);
  const edgeMask = new Float32Array(network.inSources.length).fill(1);
  const disabledProjections = new Set<string>();

  const sideIndex = (side: 'left' | 'right') => (side === 'left' ? 0 : 1);

  for (const ablation of ablations) {
    const target = ablation.target;
    switch (target.kind) {
      case 'neuron': {
        if (target.node >= 0 && target.node < network.nodeCount) nodeMask[target.node] = 0;
        break;
      }
      case 'class': {
        const index = HMI_CLASS_ORDER.indexOf(target.className as HmiClass);
        if (index < 0) break;
        for (let n = 0; n < network.nodeCount; n++) {
          if (network.classIndex[n] !== index) continue;
          if (target.hemisphere && network.hemisphere[n] !== sideIndex(target.hemisphere))
            continue;
          nodeMask[n] = 0;
        }
        break;
      }
      case 'hemisphere': {
        const side = sideIndex(target.hemisphere);
        for (let n = 0; n < network.nodeCount; n++) {
          if (network.hemisphere[n] === side) nodeMask[n] = 0;
        }
        break;
      }
      case 'projection': {
        disabledProjections.add(target.projectionId);
        break;
      }
      case 'recurrence': {
        // Remove connections that both start and end in this class on the same
        // side. This is the ipsilateral recurrent loop, and removing it is the
        // cleanest test of where the integration actually comes from.
        const index = HMI_CLASS_ORDER.indexOf(target.className as HmiClass);
        if (index < 0) break;
        for (let post = 0; post < network.nodeCount; post++) {
          if (network.classIndex[post] !== index) continue;
          const start = network.inOffsets[post];
          const end = network.inOffsets[post + 1];
          for (let e = start; e < end; e++) {
            const pre = network.inSources[e];
            if (
              network.classIndex[pre] === index &&
              network.hemisphere[pre] === network.hemisphere[post]
            ) {
              edgeMask[e] = 0;
            }
          }
        }
        break;
      }
    }
  }

  return { nodeMask, edgeMask, disabledProjections };
}
