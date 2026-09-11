import {
  neuronClass,
  neuronClassProvenance,
  neuronHemisphere,
  neuronTransmitter,
  neuronTransmitterProvenance,
  type ClassificationProvenance,
  type Hemisphere,
  type HmiCircuit,
  type HmiClass,
  type HmiPopulations,
  type HmiTransmitter,
} from '@/core/hmi';
import type { NeuronIndex } from '@/core/types';
import {
  buildNetwork,
  DEFAULT_BUILD_OPTIONS,
  MODELED_PROJECTIONS,
  SENSORY_INTERFACE,
  type NetworkBuildOptions,
  type NeuralNetwork,
} from '@/neural/network';
import { HmiNeuralRuntime } from '@/neural/runtime';
import { ExperimentTrace, NeuronTrace } from '@/neural/trace';
import type {
  Ablation,
  NeuralModelProvenance,
  NeuralMotorIntent,
  PopulationState,
} from '@/neural/types';
import { populationMap } from '@/neural/loader';
import { BaselineLocomotionController } from './controller';
import { NeuralHmiController } from './neural-controller';
import type { EmbodiedRuntime, RuntimeSnapshot } from './runtime';
import {
  DEFAULT_STIMULUS,
  VisualMotionEncoder,
  type LoopMode,
  type VisualMotionEvidence,
  type VisualMotionStimulus,
} from './visual-motion';

/**
 * The VISUAL MOTION DECISION experiment.
 *
 * Owns the full closed loop and everything needed to reproduce a run:
 *
 *   stimulus -> encoder -> HMI network -> readout -> intent -> body -> stimulus
 *
 * Reproducibility is the point. A configuration plus a seed determines the
 * entire trajectory, which is what makes an ablation comparison a controlled
 * experiment rather than an anecdote.
 */

export type ControllerMode = 'baseline' | 'neural' | 'manual';

export const CONTROLLER_MODE_INFO: Record<
  ControllerMode,
  { label: string; description: string; connectomeCoupled: boolean }
> = {
  baseline: {
    label: 'BASELINE',
    description: 'Procedural larval locomotion. No connectome involvement of any kind.',
    connectomeCoupled: false,
  },
  neural: {
    label: 'NEURAL HMI',
    description:
      'Action selection produced by a simulated network whose connectivity is measured Fish1 anatomy.',
    connectomeCoupled: true,
  },
  manual: {
    label: 'MANUAL',
    description: 'The stimulus is under direct control and the body does not act on decisions.',
    connectomeCoupled: false,
  },
};

export interface ExperimentConfig {
  readonly seed: number;
  readonly stimulus: VisualMotionStimulus;
  readonly loopMode: LoopMode;
  readonly ablations: readonly Ablation[];
  readonly network: NetworkBuildOptions;
}

export const DEFAULT_EXPERIMENT_CONFIG: ExperimentConfig = {
  seed: 42,
  stimulus: DEFAULT_STIMULUS,
  loopMode: 'closed',
  ablations: [],
  network: DEFAULT_BUILD_OPTIONS,
};

export interface ExperimentSnapshot {
  readonly runtime: RuntimeSnapshot;
  readonly evidence: VisualMotionEvidence;
  readonly populations: PopulationState | null;
  readonly intent: NeuralMotorIntent | null;
  readonly stimulusActive: boolean;
  readonly stimulusElapsed: number;
  readonly controllerMode: ControllerMode;
  readonly connectomeCoupled: boolean;
  /** Milliseconds inside the neural model on the last update. */
  readonly neuralStepMs: number;
  readonly traceSamples: number;
}

/** A versioned, downloadable record of one run. */
export interface ExperimentResult {
  readonly schemaVersion: 1;
  readonly experimentId: string;
  readonly experimentType: 'visual-motion-decision';
  readonly startedAt: string;
  readonly simulationDuration: number;
  readonly dataset: {
    readonly id: string;
    readonly version: string;
    readonly neuronCount: number;
    readonly edgeCount: number;
    readonly synapseCount: number;
    readonly citation: string;
  };
  readonly neuralModel: NeuralModelProvenance;
  readonly network: {
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly measuredNodes: number;
    readonly mirroredNodes: number;
    readonly excitatoryEdges: number;
    readonly inhibitoryEdges: number;
    readonly unsignedEdges: number;
    readonly options: NetworkBuildOptions;
    readonly modeledProjections: readonly string[];
    readonly sensoryInterface: string;
  };
  readonly seed: number;
  readonly stimulus: VisualMotionStimulus;
  readonly loopMode: LoopMode;
  readonly ablations: readonly Ablation[];
  readonly decision: {
    readonly action: NeuralMotorIntent['action'];
    readonly latency: number;
    readonly confidence: number;
    readonly decisionVariable: number;
    readonly threshold: number;
  } | null;
  readonly decisionCount: number;
  readonly bodyOutcome: {
    readonly headingChangeDegrees: number;
    readonly distanceTravelledMm: number;
    readonly finalHeadingDegrees: number;
  };
  readonly provenance: {
    readonly neuronPositions: 'measured';
    readonly connectivity: 'measured';
    readonly neurotransmitter: string;
    readonly functionalClass: string;
    readonly neuralActivity: 'simulated';
    readonly visualInput: 'simulated';
    readonly bodyMovement: 'simulated';
  };
  readonly traceSamples: number;
}

/**
 * One circuit neuron, with measured and simulated properties kept apart.
 *
 * `simulatedRate` and `history` are model output. Everything above them is from
 * the reconstruction. The inspector renders them under separate headings so a
 * simulated trace can never be read as a recording.
 */
export interface InspectedNeuron {
  readonly node: number;
  readonly loreId: number;
  readonly rootId: string;
  readonly positionVoxels: readonly [number, number, number];
  readonly hemisphere: Hemisphere;
  readonly className: HmiClass;
  readonly classProvenance: ClassificationProvenance;
  readonly classConfidence: number;
  readonly transmitter: HmiTransmitter;
  readonly transmitterProvenance: ClassificationProvenance;
  readonly incoming: number;
  readonly outgoing: number;
  readonly incomingSynapses: number;
  readonly outgoingSynapses: number;
  readonly simulatedRate: number;
  readonly modelSign: number;
  readonly signConfidence: number;
  readonly history: Float32Array;
}

export interface VisualMotionExperimentOptions {
  readonly embodied: EmbodiedRuntime;
  readonly circuit: HmiCircuit;
  readonly populations: HmiPopulations;
  /** The loaded structural index, used to paint activity on measured neurons. */
  readonly neuronIndex: NeuronIndex | null;
}

export class VisualMotionExperiment {
  readonly circuit: HmiCircuit;
  readonly trace = new ExperimentTrace();
  readonly neuronTrace = new NeuronTrace();

  private readonly embodied: EmbodiedRuntime;
  private readonly populations: HmiPopulations;
  private readonly baseline = new BaselineLocomotionController();
  private readonly encoder = new VisualMotionEncoder();

  private network: NeuralNetwork;
  private neural: HmiNeuralRuntime;
  private neuralController: NeuralHmiController;

  private config: ExperimentConfig = DEFAULT_EXPERIMENT_CONFIG;
  private mode: ControllerMode = 'neural';
  private running = false;
  private startedAt = new Date().toISOString();
  private startHeading = 0;
  private decisions: NeuralMotorIntent[] = [];

  /**
   * Node index -> index in the loaded NeuronIndex, for the activity layer.
   *
   * Only MEASURED nodes appear here. Mirror nodes have no corresponding cell in
   * the dataset, because they are a construction rather than reconstructed
   * cells, so they are never painted onto the anatomy.
   */
  private activityTargets: Int32Array = new Int32Array(0);
  private activitySources: Int32Array = new Int32Array(0);
  private activityValues: Float32Array = new Float32Array(0);
  /** NeuronIndex index -> HMI node, the inverse of the activity mapping. */
  private nodeByNeuronIndex = new Map<number, number>();
  /** Circuit node -> dataset index, built lazily for the signal-flow overlay. */
  private datasetIndexByNode: Int32Array | null = null;

  constructor(options: VisualMotionExperimentOptions) {
    this.embodied = options.embodied;
    this.circuit = options.circuit;
    this.populations = options.populations;

    this.network = buildNetwork(
      options.circuit,
      populationMap(options.populations),
      DEFAULT_EXPERIMENT_CONFIG.network,
    );
    this.neural = new HmiNeuralRuntime({
      circuit: options.circuit,
      network: this.network,
      seed: DEFAULT_EXPERIMENT_CONFIG.seed,
    });
    this.neuralController = new NeuralHmiController({
      runtime: this.neural,
      encoder: this.encoder,
    });

    this.setNeuronIndex(options.neuronIndex);
    this.setControllerMode('neural');
  }

  /* ------------------------------------------------------------ wiring */

  /**
   * Builds the node-to-neuron mapping by stable lore id.
   *
   * A lore id is the only durable identifier across artefacts; matching on
   * position or order would silently break the moment either export changed.
   */
  setNeuronIndex(index: NeuronIndex | null): void {
    if (!index) {
      this.activityTargets = new Int32Array(0);
      this.activitySources = new Int32Array(0);
      this.activityValues = new Float32Array(0);
      return;
    }
    const byLore = new Map<number, number>();
    for (let i = 0; i < index.count; i++) byLore.set(index.loreIds[i], i);

    const targets: number[] = [];
    const sources: number[] = [];
    for (let node = 0; node < this.circuit.neuronCount; node++) {
      const target = byLore.get(this.circuit.loreIds[node]);
      if (target === undefined) continue;
      sources.push(node);
      targets.push(target);
    }
    this.activitySources = Int32Array.from(sources);
    this.activityTargets = Int32Array.from(targets);
    this.activityValues = new Float32Array(targets.length);
    this.nodeByNeuronIndex = new Map();
    this.datasetIndexByNode = null;
    for (let i = 0; i < targets.length; i++) {
      this.nodeByNeuronIndex.set(targets[i], sources[i]);
    }
  }

  /** How many HMI cells could be located in the currently loaded dataset. */
  mappedNeuronCount(): number {
    return this.activityTargets.length;
  }

  setControllerMode(mode: ControllerMode): void {
    this.mode = mode;
    // Switching controllers resets state on both sides, so no neural activity
    // or procedural momentum can leak across a mode change.
    this.baseline.reset(this.config.seed);
    this.neuralController.reset(this.config.seed);
    this.embodied.controller = mode === 'neural' ? this.neuralController : this.baseline;
    this.clearActivityValues();
  }

  controllerMode(): ControllerMode {
    return this.mode;
  }

  isConnectomeCoupled(): boolean {
    // Determined from actual runtime state, never from a UI flag.
    return this.embodied.controller.connectomeCoupled === true && this.mode === 'neural';
  }

  /* ----------------------------------------------------------- control */

  configure(config: ExperimentConfig): void {
    const rebuild =
      config.network.signPolicy !== this.config.network.signPolicy ||
      config.network.weightScheme !== this.config.network.weightScheme ||
      config.network.synapticGain !== this.config.network.synapticGain ||
      config.network.enabledProjections.join() !==
        this.config.network.enabledProjections.join();

    this.config = config;

    if (rebuild) {
      this.network = buildNetwork(
        this.circuit,
        populationMap(this.populations),
        config.network,
      );
      this.neural = new HmiNeuralRuntime({
        circuit: this.circuit,
        network: this.network,
        seed: config.seed,
      });
      this.neuralController = new NeuralHmiController({
        runtime: this.neural,
        encoder: this.encoder,
      });
      if (this.mode === 'neural') this.embodied.controller = this.neuralController;
    }
    this.neural.setAblations(config.ablations);
  }

  currentConfig(): ExperimentConfig {
    return this.config;
  }

  networkStats(): NeuralNetwork['stats'] {
    return this.network.stats;
  }

  currentNetwork(): NeuralNetwork {
    return this.network;
  }

  modelProvenance(): NeuralModelProvenance {
    return this.neural.provenance;
  }

  start(): void {
    this.reset();
    this.encoder.start(this.config.stimulus, this.config.loopMode);
    this.running = true;
    this.startedAt = new Date().toISOString();
    this.embodied.events.emit({
      type: 'neural_simulation_started',
      timestamp: 0,
      summary: `Visual motion decision: ${this.config.stimulus.direction}ward, coherence ${(this.config.stimulus.coherence * 100).toFixed(0)}%, seed ${this.config.seed}, ${this.config.loopMode} loop`,
      payload: { config: this.config, model: this.neural.provenance.modelId },
    });
  }

  pause(): void {
    this.running = false;
    this.embodied.setPaused(true);
  }

  resume(): void {
    this.running = true;
    this.embodied.setPaused(false);
  }

  isRunning(): boolean {
    return this.running;
  }

  reset(): void {
    this.embodied.reset(this.config.seed);
    this.embodied.setPaused(false);
    this.neural.reset(this.config.seed);
    this.neural.setAblations(this.config.ablations);
    this.neuralController.reset(this.config.seed);
    this.baseline.reset(this.config.seed);
    this.encoder.reset(this.config.seed);
    this.encoder.stop();
    this.trace.reset();
    this.neuronTrace.reset();
    this.decisions = [];
    this.running = false;
    this.startHeading = this.embodied.snapshot().body.heading;
    this.clearActivityValues();
  }

  /* -------------------------------------------------------------- step */

  update(realDt: number): ExperimentSnapshot {
    const runtime = this.embodied.update(realDt);
    const evidence = this.neuralController.currentEvidence();
    const populations = this.neuralController.currentPopulations();
    const intent = this.neuralController.currentIntent();

    if (intent && this.decisions.at(-1)?.time !== intent.time) {
      this.decisions.push(intent);
      this.trace.mark(intent);
      this.embodied.events.emit({
        type: 'connectome_action_selected',
        timestamp: intent.time,
        summary: `${intent.action === 'turn_right' ? 'TURN RIGHT' : 'TURN LEFT'} selected by the Fish1 HMI simulation (decision variable ${intent.evidence.decisionVariable.toFixed(3)}, latency ${intent.evidence.latency.toFixed(3)} s)`,
        payload: { intent },
      });
    }

    if (populations && this.mode === 'neural') {
      const find = (id: string) => populations.populations.find((p) => p.id === id);
      const classI = find('I');
      const classII = find('II');
      const readout = find('SPN_turning');
      this.trace.sample({
        time: populations.time,
        stimulus: evidence.rightwardEvidence - evidence.leftwardEvidence,
        classILeft: classI?.left ?? 0,
        classIRight: classI?.right ?? 0,
        classIILeft: classII?.left ?? 0,
        classIIRight: classII?.right ?? 0,
        readoutLeft: readout?.left ?? 0,
        readoutRight: readout?.right ?? 0,
        decisionVariable: populations.decisionVariable,
        bodyYaw: runtime.body.heading,
      });
      const followed = this.neuronTrace.following();
      if (followed >= 0) this.neuronTrace.push(this.neural.nodeRate(followed));
    }

    return {
      runtime,
      evidence,
      populations,
      intent,
      stimulusActive: this.encoder.isActive(),
      stimulusElapsed: this.encoder.elapsedSeconds(),
      controllerMode: this.mode,
      connectomeCoupled: this.isConnectomeCoupled(),
      neuralStepMs: this.neural.lastStepDurationMs(),
      traceSamples: this.trace.length(),
    };
  }

  /* ---------------------------------------------------------- activity */

  /**
   * Current simulated rates for measured neurons, in NeuronIndex indices.
   *
   * Returns views owned by the experiment; the caller uploads them and must not
   * retain them.
   */
  activityUpdate(): { indices: Int32Array; values: Float32Array } {
    const rates = this.neural.getNeuronStateBuffer();
    for (let i = 0; i < this.activitySources.length; i++) {
      this.activityValues[i] = rates[this.activitySources[i]];
    }
    return { indices: this.activityTargets, values: this.activityValues };
  }

  private clearActivityValues(): void {
    this.activityValues.fill(0);
  }

  /**
   * The HMI node a picked neuron corresponds to, or null if that neuron is not
   * part of the reconstructed circuit.
   *
   * Most of the 30,346 loaded soma are NOT HMI cells. Clicking one has to say
   * so, rather than quietly showing circuit state for a cell that has none.
   */
  nodeForNeuronIndex(index: number): number | null {
    return this.nodeByNeuronIndex.get(index) ?? null;
  }

  /** Everything known about one circuit neuron, measured and simulated apart. */
  inspect(node: number): InspectedNeuron | null {
    if (node < 0 || node >= this.circuit.neuronCount) return null;
    const circuit = this.circuit;
    let incoming = 0;
    let outgoing = 0;
    let incomingSynapses = 0;
    let outgoingSynapses = 0;
    for (let e = 0; e < circuit.edgeCount; e++) {
      if (circuit.edgePost[e] === node) {
        incoming++;
        incomingSynapses += circuit.edgeSynapses[e];
      }
      if (circuit.edgePre[e] === node) {
        outgoing++;
        outgoingSynapses += circuit.edgeSynapses[e];
      }
    }
    this.neuronTrace.follow(node);
    return {
      node,
      loreId: circuit.loreIds[node],
      rootId: circuit.rootIds[node].toString(),
      positionVoxels: [
        circuit.positions[node * 3],
        circuit.positions[node * 3 + 1],
        circuit.positions[node * 3 + 2],
      ],
      hemisphere: neuronHemisphere(circuit, node),
      className: neuronClass(circuit, node),
      classProvenance: neuronClassProvenance(circuit, node),
      classConfidence: circuit.classConfidence[node],
      transmitter: neuronTransmitter(circuit, node),
      transmitterProvenance: neuronTransmitterProvenance(circuit, node),
      incoming,
      outgoing,
      incomingSynapses,
      outgoingSynapses,
      simulatedRate: this.neural.nodeRate(node),
      modelSign: this.network.sign[node],
      signConfidence: this.network.signConfidence[node],
      history: this.neuronTrace.history(),
    };
  }

  /**
   * Measured HMI edges, brightened by how much each is currently carrying.
   *
   * SIMULATED PROPAGATION. The lines are MEASURED synaptic contacts, drawn
   * between the measured soma positions of real cells. What varies is only the
   * alpha, and it is a model quantity:
   *
   *     contribution = presynaptic simulated rate x log1p(synapse count)
   *
   * The animation therefore represents MODEL DYNAMICS. It is not experimentally
   * measured conduction latency, and nothing here is a random pulse: an edge is
   * visible exactly when the model is driving it.
   *
   * Only measured edges appear. Mirror-hemisphere edges have no soma to connect
   * on the real anatomy and are never drawn.
   *
   * @param worldPositionOf Render-space position of a neuron, by dataset index.
   */
  signalFlow(
    worldPositionOf: (index: number) => readonly [number, number, number] | null,
  ): { segmentCount: number; positions: Float32Array; colors: Float32Array } | null {
    const circuit = this.circuit;
    if (this.activityTargets.length === 0) return null;

    // Dataset index per circuit node, built once and reused.
    if (!this.datasetIndexByNode) {
      this.datasetIndexByNode = new Int32Array(circuit.neuronCount).fill(-1);
      for (let i = 0; i < this.activitySources.length; i++) {
        this.datasetIndexByNode[this.activitySources[i]] = this.activityTargets[i];
      }
    }
    const datasetIndex = this.datasetIndexByNode;
    const rates = this.neural.getNeuronStateBuffer();

    let maxWeight = 1;
    for (let e = 0; e < circuit.edgeCount; e++) {
      maxWeight = Math.max(maxWeight, Math.log1p(circuit.edgeSynapses[e]));
    }

    const positions: number[] = [];
    const colors: number[] = [];
    let segments = 0;
    for (let e = 0; e < circuit.edgeCount; e++) {
      const pre = circuit.edgePre[e];
      const post = circuit.edgePost[e];
      const a = datasetIndex[pre];
      const b = datasetIndex[post];
      if (a < 0 || b < 0) continue;

      const contribution = rates[pre] * (Math.log1p(circuit.edgeSynapses[e]) / maxWeight);
      if (contribution < 0.01) continue;

      const from = worldPositionOf(a);
      const to = worldPositionOf(b);
      if (!from || !to) continue;

      positions.push(from[0], from[1], from[2], to[0], to[1], to[2]);
      // Excitatory and inhibitory are distinguishable, because the sign is a
      // measured property of the presynaptic cell.
      const sign = this.network.sign[pre];
      const r = sign < 0 ? 0.95 : 0.35;
      const g = sign < 0 ? 0.35 : 0.85;
      const bch = sign < 0 ? 0.85 : 0.95;
      const alpha = Math.min(contribution * 2.2, 0.9);
      colors.push(r, g, bch, alpha, r, g, bch, alpha);
      segments++;
    }
    if (segments === 0) return null;
    return {
      segmentCount: segments,
      positions: Float32Array.from(positions),
      colors: Float32Array.from(colors),
    };
  }

  neuralRuntime(): HmiNeuralRuntime {
    return this.neural;
  }

  encoderRuntime(): VisualMotionEncoder {
    return this.encoder;
  }

  /* ------------------------------------------------------------ result */

  result(): ExperimentResult {
    const snapshot = this.embodied.snapshot();
    // The FIRST decision, not the most recent: it is the one comparable across
    // runs, because a stimulus that keeps running produces repeat turns.
    const last = this.decisions[0] ?? null;
    const headingChange = ((snapshot.body.heading - this.startHeading) * 180) / Math.PI;
    const purity = this.circuit.classTransmitterPurity;
    const labelled = Object.values(purity).reduce((sum, p) => sum + p.labelled, 0);

    return {
      schemaVersion: 1,
      experimentId: `vmd-${this.config.seed}-${this.startedAt}`,
      experimentType: 'visual-motion-decision',
      startedAt: this.startedAt,
      simulationDuration: snapshot.simulationTime,
      dataset: {
        id: this.circuit.datasetId,
        version: this.circuit.version,
        neuronCount: this.circuit.neuronCount,
        edgeCount: this.circuit.edgeCount,
        synapseCount: this.circuit.synapseCount,
        citation: this.circuit.citation,
      },
      neuralModel: this.neural.provenance,
      network: {
        nodeCount: this.network.nodeCount,
        edgeCount: this.network.edgeCount,
        measuredNodes: this.network.stats.measuredNodes,
        mirroredNodes: this.network.stats.mirroredNodes,
        excitatoryEdges: this.network.stats.excitatoryEdges,
        inhibitoryEdges: this.network.stats.inhibitoryEdges,
        unsignedEdges: this.network.stats.unsignedEdges,
        options: this.network.options,
        modeledProjections: this.network.projections.map((p) => p.id),
        sensoryInterface: SENSORY_INTERFACE.justification,
      },
      seed: this.config.seed,
      stimulus: this.config.stimulus,
      loopMode: this.config.loopMode,
      ablations: this.config.ablations,
      decision: last
        ? {
            action: last.action,
            latency: last.evidence.latency,
            confidence: last.confidence,
            decisionVariable: last.evidence.decisionVariable,
            threshold: last.evidence.threshold,
          }
        : null,
      decisionCount: this.decisions.length,
      bodyOutcome: {
        headingChangeDegrees: headingChange,
        distanceTravelledMm: snapshot.body.distanceTravelled,
        finalHeadingDegrees: (snapshot.body.heading * 180) / Math.PI,
      },
      provenance: {
        neuronPositions: 'measured',
        connectivity: 'measured',
        neurotransmitter: `measured for ${labelled} of ${this.circuit.neuronCount} cells; the rest are unknown and, under the ${this.network.options.signPolicy} policy, contribute no signed drive`,
        functionalClass:
          'published morphological classifier (a prediction, not a functional recording)',
        neuralActivity: 'simulated',
        visualInput: 'simulated',
        bodyMovement: 'simulated',
      },
      traceSamples: this.trace.length(),
    };
  }

  /** Modeled projections available for ablation. */
  static projections(): typeof MODELED_PROJECTIONS {
    return MODELED_PROJECTIONS;
  }
}
