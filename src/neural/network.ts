import {
  HMI_CLASS_ORDER,
  HMI_TRANSMITTER_ORDER,
  transmitterSign,
  type HmiCircuit,
  type HmiClass,
  type HmiTransmitter,
} from '@/core/hmi';
import type { EvidenceProvenance } from '@/core/provenance';
import {
  CLASS_IMPUTATION_MIN_LABELLED,
  CLASS_IMPUTATION_MIN_PURITY,
  type SignPolicy,
  type WeightScheme,
} from './types';

/**
 * Builds the simulated network from the measured HMI circuit.
 *
 * Three things happen here, and each is a separate, labelled claim.
 *
 * 1. BILATERAL COMPLETION (derived)
 *    The released reconstruction is 94% one hemisphere: 815 of 865 placed
 *    cells lie on one side of the fitted midline. A decision circuit needs two
 *    hemispheres to compete, so every measured cell is given a mirror twin
 *    reflected through the midline, and every measured edge is duplicated
 *    between the twins. The result is exactly bilaterally symmetric, which is
 *    also what makes "symmetric input produces no directional bias" a
 *    meaningful test rather than a coincidence.
 *
 *    This is OUR construction. Mirror nodes are flagged and are never described
 *    as measured cells.
 *
 * 2. MEASURED EDGES (measured)
 *    1,235 traced contacts with synapse counts. Sign comes from the
 *    presynaptic neuron's published neurotransmitter under Dale's law - the
 *    sign is a property of the cell, not of the edge.
 *
 * 3. MODELED POPULATION PROJECTIONS (inferred)
 *    The release traced outputs from only 46 cells, and none of them are
 *    Class II. So Class II - the population whose axon crosses the midline and
 *    which is 92% Gad1b - has zero traced outgoing contacts, and without it
 *    there is no interhemispheric competition and therefore no decision.
 *
 *    Rather than fabricate synapses, the crossing inhibition is added as a
 *    POPULATION-LEVEL term: contralateral Class II mean rate inhibits Class I.
 *    This deliberately cannot be mistaken for measured connectivity - it never
 *    becomes an edge, so it never draws a line between two real neurons. It is
 *    individually ablatable, and running with it disabled is the honest way to
 *    see how much of the behaviour rests on it.
 */

/* -------------------------------------------------------------------------- */
/* Projections                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A population-level projection the measured reconstruction does not contain.
 *
 * `evidence` lists the MEASURED facts that justify asserting this pathway
 * exists at all. They justify its existence, direction and sign. They do not
 * establish which individual cells connect, which is why this is a population
 * term and not a set of edges.
 */
export interface ModeledProjection {
  readonly id: string;
  readonly label: string;
  readonly sourceClass: HmiClass;
  readonly targetClass: HmiClass;
  /** Which hemisphere the source population sits in, relative to the target. */
  readonly side: 'same' | 'opposite';
  readonly sign: -1 | 1;
  /** Strength relative to the normalised measured input a neuron receives. */
  readonly gain: number;
  readonly justification: string;
  readonly evidence: readonly string[];
  readonly provenance: EvidenceProvenance;
}

/**
 * The complete list of pathways this model adds to the measured connectome.
 *
 * It is one entry long, on purpose. Every other pathway the circuit needs -
 * sensory input to Class I, recurrent Class I integration, Class I to spinal
 * projection neurons - is present in the measured reconstruction.
 */
export const MODELED_PROJECTIONS: readonly ModeledProjection[] = [
  {
    id: 'modeled-classII-crossed-inhibition',
    label: 'Class II crossed inhibition',
    sourceClass: 'II',
    targetClass: 'I',
    side: 'opposite',
    sign: -1,
    gain: 0.9,
    justification:
      'Class II cells receive 378 measured contacts from Class I but have zero traced outgoing contacts, because outputs were traced from only 46 seed cells. Their crossing inhibitory projection is asserted from measured morphology and measured molecular identity, at population level only.',
    evidence: [
      "Published morphological classifier for Class II is 'contralateral axon': the axon crosses the midline (measured morphology).",
      '92% of labelled Class II cells are Gad1b, i.e. inhibitory (measured molecular identity, 77 labelled cells).',
      'Class I drives Class II with 378 measured contacts, so the population is driven by the ipsilateral integrator (measured connectivity).',
    ],
    provenance: 'inferred',
  },
];

/* -------------------------------------------------------------------------- */
/* Sensory interface                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Where visual evidence enters the circuit.
 *
 * MODELED SENSORY INTERFACE. The released reconstruction contains no
 * identified pretectal or tectal visual-input neurons, so there is no measured
 * retina-to-hindbrain mapping to use, and inventing one would be exactly the
 * kind of fabrication this project refuses.
 *
 * What the release does contain is a traced input layer: cells found by
 * tracing the presynaptic partners of the seed cells, labelled `input_one` in
 * `network_level`. Those cells make 100 measured contacts onto Class I. Driving
 * them is therefore an injection into a structurally identified input layer,
 * not into an arbitrary set of cells - but the claim stops there.
 */
export const SENSORY_INTERFACE = {
  populationId: 'input-layer',
  label: 'Traced input layer',
  justification:
    "Cells whose published network_level includes an 'input_one' tracing label: the reconstruction's own presynaptic layer, making 100 measured contacts onto Class I.",
  convention:
    'Rightward visual motion drives the right-hemisphere input layer. Combined with the measured ipsilateral organisation (Class I to same-side spinal projection neurons), this produces a turn toward the motion, which is the optomotor response. The actual pretectal to hindbrain wiring is not in this reconstruction, so the side assignment is a stated convention, not a measurement.',
  provenance: 'inferred' as EvidenceProvenance,
} as const;

/* -------------------------------------------------------------------------- */
/* Network                                                                    */
/* -------------------------------------------------------------------------- */

export interface NetworkBuildOptions {
  readonly signPolicy: SignPolicy;
  readonly weightScheme: WeightScheme;
  /**
   * Global synaptic gain, 0..1 exclusive.
   *
   * Scales every measured weight. Because incoming weights are normalised per
   * postsynaptic neuron, the weight matrix has an infinity-norm of at most 1,
   * so its spectral radius is at most 1 and any gain below 1 is provably
   * stable - the model cannot blow up regardless of the graph.
   *
   * Acting through the measured recurrent loop, it sets the effective
   * integration time constant to tau / (1 - gain): one second at the default.
   * This is the single scalar that puts the network in an integrating rather
   * than a saturating regime, and it is the only parameter of the dynamics that
   * is not read from the data.
   */
  readonly synapticGain: number;
  /** Which modeled projections are enabled. */
  readonly enabledProjections: readonly string[];
}

export const DEFAULT_BUILD_OPTIONS: NetworkBuildOptions = {
  signPolicy: 'strict',
  weightScheme: 'log1p',
  synapticGain: 0.9,
  enabledProjections: MODELED_PROJECTIONS.map((p) => p.id),
};

export interface NetworkPopulation {
  readonly id: string;
  readonly label: string;
  /** Node indices on each side. */
  readonly left: Uint32Array;
  readonly right: Uint32Array;
}

export interface NetworkStats {
  readonly measuredEdges: number;
  readonly mirroredEdges: number;
  readonly excitatoryEdges: number;
  readonly inhibitoryEdges: number;
  /** Edges present in the graph that contribute no signed drive. */
  readonly unsignedEdges: number;
  readonly imputedEdges: number;
  readonly measuredNodes: number;
  readonly mirroredNodes: number;
}

/**
 * The simulated network.
 *
 * Incoming CSR, because the model's inner loop aggregates over presynaptic
 * partners. Outgoing CSR is kept too, for the signal-flow visualisation, which
 * pushes from active cells forward.
 */
export interface NeuralNetwork {
  readonly nodeCount: number;
  readonly edgeCount: number;

  /* Node properties */
  /** Index into the source HmiCircuit. Mirror twins share a source index. */
  readonly sourceIndex: Uint32Array;
  /** 1 if this node is a mirror construction rather than a measured cell. */
  readonly mirrored: Uint8Array;
  /** 0 = left, 1 = right. */
  readonly hemisphere: Uint8Array;
  readonly classIndex: Uint8Array;
  /** -1, 0 or +1 under the active sign policy. */
  readonly sign: Int8Array;
  /** Confidence in the sign: 1 for measured, class purity for imputed, 0 for unknown. */
  readonly signConfidence: Float32Array;
  /** Render-space position in source voxels, xyz interleaved. Mirrors are reflected. */
  readonly positions: Int32Array;

  /* Incoming CSR */
  readonly inOffsets: Uint32Array;
  readonly inSources: Uint32Array;
  readonly inWeights: Float32Array;

  /* Outgoing CSR, for flow visualisation */
  readonly outOffsets: Uint32Array;
  readonly outTargets: Uint32Array;
  readonly outWeights: Float32Array;

  readonly populations: readonly NetworkPopulation[];
  readonly projections: readonly ModeledProjection[];
  readonly options: NetworkBuildOptions;
  readonly stats: NetworkStats;
}

function rawWeight(synapses: number, scheme: WeightScheme): number {
  if (scheme === 'binary') return 1;
  if (scheme === 'linear') return synapses;
  return Math.log1p(synapses);
}

/**
 * Resolves each neuron's sign under the active policy.
 *
 * Returns the sign and a confidence. Confidence is what stops an imputed sign
 * from behaving like a measured one: an edge out of an imputed neuron is scaled
 * by its class purity, so a 70%-pure guess carries 70% of the weight.
 */
function resolveSigns(
  circuit: HmiCircuit,
  policy: SignPolicy,
): { sign: Int8Array; confidence: Float32Array; imputed: number } {
  const count = circuit.neuronCount;
  const sign = new Int8Array(count);
  const confidence = new Float32Array(count);
  let imputed = 0;

  // Class-level purity, as published by the pipeline from the measured labels.
  const purityByClass = new Map<string, { majority: HmiTransmitter; purity: number }>();
  if (policy === 'class-imputed') {
    for (const [className, entry] of Object.entries(circuit.classTransmitterPurity)) {
      if (
        entry.labelled >= CLASS_IMPUTATION_MIN_LABELLED &&
        entry.purity >= CLASS_IMPUTATION_MIN_PURITY &&
        entry.majority !== 'unknown'
      ) {
        purityByClass.set(className, { majority: entry.majority, purity: entry.purity });
      }
    }
  }

  for (let i = 0; i < count; i++) {
    const transmitter = HMI_TRANSMITTER_ORDER[circuit.transmitters[i]] ?? 'unknown';
    if (transmitter !== 'unknown') {
      sign[i] = transmitterSign(transmitter);
      confidence[i] = 1;
      continue;
    }
    if (policy === 'class-imputed') {
      const className = HMI_CLASS_ORDER[circuit.classIndices[i]] ?? 'unclassified';
      const entry = purityByClass.get(className);
      if (entry) {
        sign[i] = transmitterSign(entry.majority);
        confidence[i] = entry.purity;
        imputed++;
        continue;
      }
    }
    // Strict, or a class too impure to impute from: contributes nothing.
    sign[i] = 0;
    confidence[i] = 0;
  }

  return { sign, confidence, imputed };
}

export function buildNetwork(
  circuit: HmiCircuit,
  populationsByLore: ReadonlyMap<string, readonly number[]>,
  options: NetworkBuildOptions = DEFAULT_BUILD_OPTIONS,
): NeuralNetwork {
  const measured = circuit.neuronCount;
  const nodeCount = measured * 2;
  const midline = circuit.midline.voxels;

  const resolved = resolveSigns(
    circuit,
    options.signPolicy === 'strict' ? 'strict' : options.signPolicy,
  );

  const sourceIndex = new Uint32Array(nodeCount);
  const mirrored = new Uint8Array(nodeCount);
  const hemisphere = new Uint8Array(nodeCount);
  const classIndex = new Uint8Array(nodeCount);
  const sign = new Int8Array(nodeCount);
  const signConfidence = new Float32Array(nodeCount);
  const positions = new Int32Array(nodeCount * 3);

  for (let i = 0; i < measured; i++) {
    const twin = i + measured;
    sourceIndex[i] = i;
    sourceIndex[twin] = i;
    mirrored[i] = 0;
    mirrored[twin] = 1;
    hemisphere[i] = circuit.hemispheres[i];
    hemisphere[twin] = circuit.hemispheres[i] === 0 ? 1 : 0;
    classIndex[i] = circuit.classIndices[i];
    classIndex[twin] = circuit.classIndices[i];
    sign[i] = resolved.sign[i];
    sign[twin] = resolved.sign[i];
    signConfidence[i] = resolved.confidence[i];
    signConfidence[twin] = resolved.confidence[i];

    const x = circuit.positions[i * 3];
    const y = circuit.positions[i * 3 + 1];
    const z = circuit.positions[i * 3 + 2];
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    // Reflection through the fitted midline. Only y changes.
    positions[twin * 3] = x;
    positions[twin * 3 + 1] = 2 * midline - y;
    positions[twin * 3 + 2] = z;
  }

  /* ------------------------------------------------------------- edges */
  const measuredEdges = circuit.edgeCount;
  const edgeCount = measuredEdges * 2;
  const pre = new Uint32Array(edgeCount);
  const post = new Uint32Array(edgeCount);
  const weight = new Float32Array(edgeCount);

  for (let e = 0; e < measuredEdges; e++) {
    const a = circuit.edgePre[e];
    const b = circuit.edgePost[e];
    const w = rawWeight(circuit.edgeSynapses[e], options.weightScheme);
    pre[e] = a;
    post[e] = b;
    weight[e] = w;
    pre[e + measuredEdges] = a + measured;
    post[e + measuredEdges] = b + measured;
    weight[e + measuredEdges] = w;
  }

  /* --------------------------------------------------- normalise by row */
  // Total absolute incoming weight per postsynaptic node, so no node can be
  // driven harder simply because more of its partners happened to be traced.
  const incomingTotal = new Float32Array(nodeCount);
  for (let e = 0; e < edgeCount; e++) {
    incomingTotal[post[e]] += weight[e];
  }

  let excitatory = 0;
  let inhibitory = 0;
  let unsigned = 0;
  const signedWeight = new Float32Array(edgeCount);
  for (let e = 0; e < edgeCount; e++) {
    const presynaptic = pre[e];
    const s = sign[presynaptic];
    const total = incomingTotal[post[e]];
    const normalised = total > 0 ? weight[e] / total : 0;
    signedWeight[e] = s * normalised * signConfidence[presynaptic] * options.synapticGain;
    if (s > 0) excitatory++;
    else if (s < 0) inhibitory++;
    else unsigned++;
  }

  /* ----------------------------------------------------------- build CSR */
  const inOffsets = new Uint32Array(nodeCount + 1);
  const outOffsets = new Uint32Array(nodeCount + 1);
  for (let e = 0; e < edgeCount; e++) {
    inOffsets[post[e] + 1]++;
    outOffsets[pre[e] + 1]++;
  }
  for (let n = 0; n < nodeCount; n++) {
    inOffsets[n + 1] += inOffsets[n];
    outOffsets[n + 1] += outOffsets[n];
  }
  const inSources = new Uint32Array(edgeCount);
  const inWeights = new Float32Array(edgeCount);
  const outTargets = new Uint32Array(edgeCount);
  const outWeights = new Float32Array(edgeCount);
  const inCursor = inOffsets.slice(0, nodeCount);
  const outCursor = outOffsets.slice(0, nodeCount);
  for (let e = 0; e < edgeCount; e++) {
    const i = inCursor[post[e]]++;
    inSources[i] = pre[e];
    inWeights[i] = signedWeight[e];
    const o = outCursor[pre[e]]++;
    outTargets[o] = post[e];
    outWeights[o] = signedWeight[e];
  }

  /* ------------------------------------------------------- populations */
  const loreToNode = new Map<number, number>();
  for (let i = 0; i < measured; i++) loreToNode.set(circuit.loreIds[i], i);

  const populations: NetworkPopulation[] = [];
  const addPopulation = (id: string, label: string, nodes: number[]) => {
    const left: number[] = [];
    const right: number[] = [];
    for (const node of nodes) {
      (hemisphere[node] === 0 ? left : right).push(node);
    }
    populations.push({
      id,
      label,
      left: Uint32Array.from(left),
      right: Uint32Array.from(right),
    });
  };

  for (const [id, loreIds] of populationsByLore) {
    const nodes: number[] = [];
    for (const lore of loreIds) {
      const base = loreToNode.get(lore);
      if (base === undefined) continue;
      nodes.push(base, base + measured);
    }
    addPopulation(id, id, nodes);
  }

  const enabled = MODELED_PROJECTIONS.filter((p) => options.enabledProjections.includes(p.id));

  return {
    nodeCount,
    edgeCount,
    sourceIndex,
    mirrored,
    hemisphere,
    classIndex,
    sign,
    signConfidence,
    positions,
    inOffsets,
    inSources,
    inWeights,
    outOffsets,
    outTargets,
    outWeights,
    populations,
    projections: enabled,
    options,
    stats: {
      measuredEdges,
      mirroredEdges: measuredEdges,
      excitatoryEdges: excitatory,
      inhibitoryEdges: inhibitory,
      unsignedEdges: unsigned,
      imputedEdges: resolved.imputed,
      measuredNodes: measured,
      mirroredNodes: measured,
    },
  };
}

/** Node indices of one class on one side. Used for ablation and readouts. */
export function classNodes(
  network: NeuralNetwork,
  className: HmiClass,
  side?: 'left' | 'right',
): Uint32Array {
  const index = HMI_CLASS_ORDER.indexOf(className);
  const out: number[] = [];
  for (let n = 0; n < network.nodeCount; n++) {
    if (network.classIndex[n] !== index) continue;
    if (side && network.hemisphere[n] !== (side === 'left' ? 0 : 1)) continue;
    out.push(n);
  }
  return Uint32Array.from(out);
}
