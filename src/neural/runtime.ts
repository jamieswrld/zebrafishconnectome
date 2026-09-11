import { HMI_CLASS_ORDER, type HmiCircuit, type HmiClass } from '@/core/hmi';
import { SeededRandom } from '@/core/random';
import {
  buildAblationMasks,
  DECISION_REFRACTORY_SECONDS,
  DECISION_THRESHOLD,
  NEURAL_DT,
  NOISE_SIGMA,
  READOUT_CLASS,
  SENSORY_GAIN,
  TAU_SECONDS,
  type AblationMasks,
} from './model';
import { classNodes, SENSORY_INTERFACE, type NeuralNetwork } from './network';
import {
  ZERO_SENSORY_INPUT,
  type Ablation,
  type NeuralFrame,
  type NeuralModelProvenance,
  type NeuralMotorIntent,
  type NeuralRuntime,
  type NeuralSensoryInput,
  type PopulationState,
  type PopulationSummary,
} from './types';

/**
 * The connectome-constrained HMI runtime.
 *
 * Owns all simulated neural state as flat typed arrays and steps at a fixed
 * 200 Hz regardless of the render rate, so a slow frame changes nothing about
 * the result. Given the same seed, network and stimulus, two runs are
 * bit-identical - which is what makes ablation comparisons meaningful, because
 * any difference between a control run and an ablated run is caused by the
 * ablation and by nothing else.
 */

/** Populations summarised for the UI. Readouts, not the model's internal state. */
const SUMMARY_CLASSES: readonly { className: HmiClass; label: string }[] = [
  { className: 'I', label: 'Class I (ipsilateral)' },
  { className: 'II', label: 'Class II (crossing)' },
  { className: 'SPN_turning', label: 'Spinal projection (turning)' },
  { className: 'SPN_forward', label: 'Spinal projection (forward)' },
];

export interface HmiRuntimeOptions {
  readonly circuit: HmiCircuit;
  readonly network: NeuralNetwork;
  readonly seed?: number;
}

export class HmiNeuralRuntime implements NeuralRuntime {
  readonly id = 'fish1-hmi-rate-v1';
  readonly provenance: NeuralModelProvenance;
  readonly nodeCount: number;
  readonly network: NeuralNetwork;

  /* State. One allocation each, reused for the life of the runtime. */
  private readonly x: Float32Array;
  private readonly r: Float32Array;
  private readonly drive: Float32Array;
  private readonly noise: Float32Array;

  private masks: AblationMasks;
  private ablations: readonly Ablation[] = [];

  private readonly inputLeft: Uint32Array;
  private readonly inputRight: Uint32Array;
  private readonly readoutLeft: Uint32Array;
  private readonly readoutRight: Uint32Array;
  private readonly summaryNodes: {
    className: HmiClass;
    label: string;
    left: Uint32Array;
    right: Uint32Array;
  }[];
  /** Class II node lists, for the modeled crossed-inhibition term. */
  private readonly crossingLeft: Uint32Array;
  private readonly crossingRight: Uint32Array;
  private readonly classITargets: { left: Uint32Array; right: Uint32Array };

  private random: SeededRandom;
  /**
   * Box-Muller produces two independent normals per pair of uniforms, so the
   * spare one is cached. The inner loop draws one sample per node per step -
   * 6,920 per behaviour tick at 200 Hz - and halving that cost is the single
   * biggest saving in the model.
   */
  private spareNormal: number | null = null;
  private seed: number;
  private time = 0;
  private stepIndex = 0;
  private accumulator = 0;
  private input: NeuralSensoryInput = ZERO_SENSORY_INPUT;
  private intent: NeuralMotorIntent | null = null;
  private lastDecisionAt = -Infinity;
  private stimulusOnsetAt: number | null = null;
  private lastStepMs = 0;

  constructor(options: HmiRuntimeOptions) {
    this.network = options.network;
    this.nodeCount = options.network.nodeCount;
    this.seed = options.seed ?? 42;
    this.random = new SeededRandom(this.seed);

    this.x = new Float32Array(this.nodeCount);
    this.r = new Float32Array(this.nodeCount);
    this.drive = new Float32Array(this.nodeCount);
    this.noise = new Float32Array(this.nodeCount);
    this.masks = buildAblationMasks(options.network, []);

    const inputPopulation = options.network.populations.find(
      (p) => p.id === SENSORY_INTERFACE.populationId,
    );
    this.inputLeft = inputPopulation?.left ?? new Uint32Array(0);
    this.inputRight = inputPopulation?.right ?? new Uint32Array(0);

    this.readoutLeft = classNodes(options.network, READOUT_CLASS, 'left');
    this.readoutRight = classNodes(options.network, READOUT_CLASS, 'right');

    this.summaryNodes = SUMMARY_CLASSES.map((entry) => ({
      ...entry,
      left: classNodes(options.network, entry.className, 'left'),
      right: classNodes(options.network, entry.className, 'right'),
    }));

    this.crossingLeft = classNodes(options.network, 'II', 'left');
    this.crossingRight = classNodes(options.network, 'II', 'right');
    this.classITargets = {
      left: classNodes(options.network, 'I', 'left'),
      right: classNodes(options.network, 'I', 'right'),
    };

    const stats = options.network.stats;
    this.provenance = {
      modelId: this.id,
      modelVersion: '1.0.0',
      category: 'connectome_constrained_model',
      connectivitySource: `Fish1 HMI reconstruction (${options.circuit.datasetId} ${options.circuit.version}): ${stats.measuredEdges} traced directed pairs, ${options.circuit.synapseCount} synaptic contacts`,
      connectivityMeasured: true,
      weightsSource:
        'Synapse counts from the measured reconstruction, log1p-compressed and normalised per postsynaptic neuron. A synapse count is a structural proxy, not a physiological synaptic weight.',
      dynamicsSource:
        'Firing-rate dynamics chosen by this project. Not fitted to any recording, because no activity data for these cells exists in the Fish1 release.',
      activityMeasured: false,
      citations: [options.circuit.citation],
      caveats: [
        'Fish1 is a structural EM dataset. It contains no neural activity, so every rate here is simulated.',
        `The reconstruction is 94% unilateral (${options.circuit.hemispheres.length ? '' : ''}815 of 865 placed cells on one side). The opposite hemisphere is a mirror construction, not measured cells.`,
        'Class II has zero traced outgoing contacts. Its crossing inhibition is a modeled population-level term justified by measured morphology and molecular identity, and it is individually ablatable.',
        'Outgoing contacts were traced from only 46 seed cells, so the graph is sparse and star-like rather than a complete wiring diagram.',
        'Spinal projection neurons are the measured output of this circuit, but the spinal pattern generator and the muscles are not reconstructed. Movement is executed by a procedural body model.',
      ],
    };
  }

  /* ------------------------------------------------------------- control */

  reset(seed = this.seed): void {
    this.seed = seed;
    this.random = new SeededRandom(seed);
    this.spareNormal = null;
    this.x.fill(0);
    this.r.fill(0);
    this.drive.fill(0);
    this.noise.fill(0);
    this.time = 0;
    this.stepIndex = 0;
    this.accumulator = 0;
    this.input = ZERO_SENSORY_INPUT;
    this.intent = null;
    this.lastDecisionAt = -Infinity;
    this.stimulusOnsetAt = null;
    this.lastStepMs = 0;
  }

  setSensoryInput(input: NeuralSensoryInput): void {
    const active = input.leftDrive > 0 || input.rightDrive > 0;
    const wasActive = this.input.leftDrive > 0 || this.input.rightDrive > 0;
    if (active && !wasActive) this.stimulusOnsetAt = this.time;
    if (!active) this.stimulusOnsetAt = null;
    this.input = input;
  }

  setAblations(ablations: readonly Ablation[]): void {
    this.ablations = ablations;
    this.masks = buildAblationMasks(this.network, ablations);
  }

  getAblations(): readonly Ablation[] {
    return this.ablations;
  }

  /* ---------------------------------------------------------------- step */

  step(dt: number): NeuralFrame {
    const started = performance.now();
    // Clamp the accumulator so a stalled tab cannot make the model run a
    // thousand catch-up steps and produce a different trajectory.
    this.accumulator = Math.min(this.accumulator + dt, 0.25);
    while (this.accumulator >= NEURAL_DT) {
      this.integrate(NEURAL_DT);
      this.accumulator -= NEURAL_DT;
    }
    // Exponential moving average. At high frame rates most frames run zero
    // neural steps, so a single sample says nothing; the average is the honest
    // per-frame cost.
    const elapsed = performance.now() - started;
    this.lastStepMs = this.lastStepMs === 0 ? elapsed : this.lastStepMs * 0.9 + elapsed * 0.1;
    const populations = this.getPopulationState();
    this.updateIntent(populations);
    return {
      time: this.time,
      step: this.stepIndex,
      rates: this.r,
      populations,
      intent: this.intent,
    };
  }

  private integrate(dt: number): void {
    const net = this.network;
    const { nodeMask, edgeMask, disabledProjections } = this.masks;
    const x = this.x;
    const r = this.r;
    const drive = this.drive;

    /* ------------------------------------------------- sensory injection */
    drive.fill(0);
    const gain = SENSORY_GAIN;
    for (let i = 0; i < this.inputLeft.length; i++) {
      drive[this.inputLeft[i]] = this.input.leftDrive * gain;
    }
    for (let i = 0; i < this.inputRight.length; i++) {
      drive[this.inputRight[i]] = this.input.rightDrive * gain;
    }

    /* --------------------------------------- modeled population projection */
    // Class II on one side inhibits Class I on the other. Population-level and
    // explicitly labelled, because no individual Class II output was traced.
    for (const projection of net.projections) {
      if (disabledProjections.has(projection.id)) continue;
      if (projection.sourceClass !== 'II' || projection.targetClass !== 'I') continue;
      const meanLeft = this.meanRate(this.crossingLeft);
      const meanRight = this.meanRate(this.crossingRight);
      const toRight = projection.sign * projection.gain * meanLeft;
      const toLeft = projection.sign * projection.gain * meanRight;
      const targetsRight = this.classITargets.right;
      const targetsLeft = this.classITargets.left;
      for (let i = 0; i < targetsRight.length; i++) drive[targetsRight[i]] += toRight;
      for (let i = 0; i < targetsLeft.length; i++) drive[targetsLeft[i]] += toLeft;
    }

    /* ------------------------------------------------------- integration */
    const decay = dt / TAU_SECONDS;
    const noiseScale = NOISE_SIGMA * Math.sqrt(dt);
    for (let n = 0; n < net.nodeCount; n++) {
      let sum = drive[n];
      const start = net.inOffsets[n];
      const end = net.inOffsets[n + 1];
      for (let e = start; e < end; e++) {
        sum += net.inWeights[e] * edgeMask[e] * r[net.inSources[e]];
      }
      sum += this.nextNormal() * noiseScale;
      x[n] += (-x[n] + sum) * decay;
    }

    // Rectify and saturate. Bounded output is what guarantees no NaN or Inf can
    // propagate regardless of the weights.
    for (let n = 0; n < net.nodeCount; n++) {
      const value = x[n];
      r[n] = value <= 0 ? 0 : value >= 1 ? 1 : value;
      r[n] *= nodeMask[n];
    }

    this.time += dt;
    this.stepIndex++;
  }

  /** Standard normal, reusing the spare half of each Box-Muller pair. */
  private nextNormal(): number {
    const spare = this.spareNormal;
    if (spare !== null) {
      this.spareNormal = null;
      return spare;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = this.random.float();
    while (v === 0) v = this.random.float();
    const radius = Math.sqrt(-2 * Math.log(u));
    const angle = 2 * Math.PI * v;
    this.spareNormal = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  }

  private meanRate(nodes: Uint32Array): number {
    if (nodes.length === 0) return 0;
    let total = 0;
    for (let i = 0; i < nodes.length; i++) total += this.r[nodes[i]];
    return total / nodes.length;
  }

  /* ------------------------------------------------------------ readout */

  getPopulationState(): PopulationState {
    const populations: PopulationSummary[] = this.summaryNodes.map((entry) => ({
      id: entry.className,
      label: entry.label,
      left: this.meanRate(entry.left),
      right: this.meanRate(entry.right),
      neuronCount: entry.left.length + entry.right.length,
    }));

    const left = this.meanRate(this.readoutLeft);
    const right = this.meanRate(this.readoutRight);
    return {
      time: this.time,
      populations,
      decisionVariable: right - left,
      threshold: DECISION_THRESHOLD,
      provenance: 'simulated',
    };
  }

  private updateIntent(state: PopulationState): void {
    const magnitude = Math.abs(state.decisionVariable);
    if (magnitude < DECISION_THRESHOLD) return;
    if (this.time - this.lastDecisionAt < DECISION_REFRACTORY_SECONDS) return;

    const left = this.meanRate(this.readoutLeft);
    const right = this.meanRate(this.readoutRight);
    this.lastDecisionAt = this.time;
    const latency = this.stimulusOnsetAt === null ? 0 : this.time - this.stimulusOnsetAt;
    // A decision closes the current accumulation epoch. Without this, a stimulus
    // that keeps running reports an ever-growing "latency" for every repeat
    // turn, which is not what the word means.
    this.stimulusOnsetAt = this.time;
    this.intent = {
      time: this.time,
      source: 'connectome',
      action: state.decisionVariable > 0 ? 'turn_right' : 'turn_left',
      confidence: Math.min((magnitude - DECISION_THRESHOLD) / DECISION_THRESHOLD, 1),
      evidence: {
        leftReadout: left,
        rightReadout: right,
        decisionVariable: state.decisionVariable,
        threshold: DECISION_THRESHOLD,
        latency,
        input: this.input,
      },
      circuit: 'Fish1 HMI',
    };
  }

  getNeuronStateBuffer(): Float32Array {
    return this.r;
  }

  getMotorIntent(): NeuralMotorIntent | null {
    return this.intent;
  }

  /** Clears a consumed intent so one decision drives exactly one movement. */
  consumeMotorIntent(): NeuralMotorIntent | null {
    const intent = this.intent;
    this.intent = null;
    return intent;
  }

  simulationTime(): number {
    return this.time;
  }

  lastStepDurationMs(): number {
    return this.lastStepMs;
  }

  /** Per-node rate for one class, for inspection panels. */
  nodeRate(node: number): number {
    return this.r[node] ?? 0;
  }

  className(node: number): HmiClass {
    return HMI_CLASS_ORDER[this.network.classIndex[node]] ?? 'unclassified';
  }
}
