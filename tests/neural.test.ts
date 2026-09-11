import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  buildLoreIndex,
  decodeHmiCircuit,
  HMI_CLASS_ORDER,
  HMI_TRANSMITTER_ORDER,
  neuronClass,
  neuronTransmitter,
  transmitterSign,
  type HmiCircuit,
  type HmiPopulations,
} from '@/core/hmi';
import {
  buildNetwork,
  classNodes,
  DEFAULT_BUILD_OPTIONS,
  MODELED_PROJECTIONS,
} from '@/neural/network';
import { HmiNeuralRuntime } from '@/neural/runtime';
import { DECISION_THRESHOLD } from '@/neural/model';
import { ExperimentTrace } from '@/neural/trace';
import type { Ablation } from '@/neural/types';

/**
 * Tests for the connectome-constrained HMI model.
 *
 * These run against the REAL artefact, not a fixture. If the pipeline ever
 * produces something different - a changed class vocabulary, a lost edge, a
 * flipped hemisphere - these fail, which is the point. A fixture would let the
 * artefact and the model drift apart silently.
 */

function loadCircuit(): HmiCircuit {
  const bytes = readFileSync('public/datasets/fish1-hmi/v1/hmi.bin');
  return decodeHmiCircuit(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

function loadPopulations(): HmiPopulations {
  return JSON.parse(
    readFileSync('public/datasets/fish1-hmi/v1/populations.json', 'utf8'),
  ) as HmiPopulations;
}

const circuit = loadCircuit();
const populations = loadPopulations();
const populationLookup = new Map(populations.populations.map((p) => [p.id, p.loreIds]));

function makeRuntime(options: Partial<typeof DEFAULT_BUILD_OPTIONS> = {}) {
  const network = buildNetwork(circuit, populationLookup, {
    ...DEFAULT_BUILD_OPTIONS,
    ...options,
  });
  return { network, runtime: new HmiNeuralRuntime({ circuit, network, seed: 7 }) };
}

/** Runs one trial and reports what happened. Shared by many tests. */
function trial(
  runtime: HmiNeuralRuntime,
  options: {
    left: number;
    right: number;
    seconds?: number;
    seed?: number;
    ablations?: readonly Ablation[];
  },
) {
  const { left, right, seconds = 8, seed = 7, ablations = [] } = options;
  runtime.reset(seed);
  runtime.setAblations(ablations);
  runtime.setSensoryInput({ leftDrive: left, rightDrive: right, coherence: 1 });
  let action: string | null = null;
  let latency: number | null = null;
  let peak = 0;
  const steps = Math.round(seconds / 0.02);
  let decisionVariable = 0;
  for (let i = 0; i < steps; i++) {
    const frame = runtime.step(0.02);
    decisionVariable = frame.populations.decisionVariable;
    peak = Math.max(peak, Math.abs(decisionVariable));
    if (!action && frame.intent) {
      action = frame.intent.action;
      latency = frame.intent.time;
    }
  }
  return { action, latency, peak, decisionVariable };
}

/* -------------------------------------------------------------------------- */
/* 1. Data integrity                                                          */
/* -------------------------------------------------------------------------- */

describe('HMI artefact integrity', () => {
  it('decodes with matching neuron and edge counts', () => {
    expect(circuit.neuronCount).toBeGreaterThan(0);
    expect(circuit.edgeCount).toBeGreaterThan(0);
    expect(circuit.loreIds.length).toBe(circuit.neuronCount);
    expect(circuit.positions.length).toBe(circuit.neuronCount * 3);
    expect(circuit.edgePre.length).toBe(circuit.edgeCount);
    expect(circuit.edgePositions.length).toBe(circuit.edgeCount * 3);
  });

  it('has no duplicate lore ids', () => {
    const seen = new Set<number>();
    for (let i = 0; i < circuit.neuronCount; i++) {
      expect(seen.has(circuit.loreIds[i])).toBe(false);
      seen.add(circuit.loreIds[i]);
    }
    expect(seen.size).toBe(circuit.neuronCount);
  });

  it('keeps every edge endpoint inside the neuron index', () => {
    for (let e = 0; e < circuit.edgeCount; e++) {
      expect(circuit.edgePre[e]).toBeLessThan(circuit.neuronCount);
      expect(circuit.edgePost[e]).toBeLessThan(circuit.neuronCount);
    }
  });

  it('preserves synapse counts as positive integers', () => {
    let total = 0;
    for (let e = 0; e < circuit.edgeCount; e++) {
      expect(circuit.edgeSynapses[e]).toBeGreaterThan(0);
      expect(Number.isInteger(circuit.edgeSynapses[e])).toBe(true);
      total += circuit.edgeSynapses[e];
    }
    expect(total).toBe(circuit.synapseCount);
  });

  it('assigns hemisphere from the fitted midline and nothing else', () => {
    const midline = circuit.midline.voxels;
    for (let i = 0; i < circuit.neuronCount; i++) {
      const y = circuit.positions[i * 3 + 1];
      expect(circuit.hemispheres[i]).toBe(y < midline ? 0 : 1);
    }
    // The midline is derived, never presented as measured.
    expect(circuit.midline.provenance).toBe('derived');
  });

  it('never converts an unknown neurotransmitter into a sign', () => {
    for (let i = 0; i < circuit.neuronCount; i++) {
      const transmitter = neuronTransmitter(circuit, i);
      if (transmitter === 'unknown') {
        expect(transmitterSign(transmitter)).toBe(0);
        // An unknown transmitter carries no molecular provenance either.
        expect(circuit.transmitterProvenance[i]).toBe(0);
      }
    }
    expect(circuit.transmitterCounts.unknown).toBeGreaterThan(0);
  });

  it('keeps the source ambiguous classes ambiguous', () => {
    // The release itself hedges with '1 or 2'. Collapsing that to Class I would
    // invent certainty the data does not have.
    let ambiguous = 0;
    for (let i = 0; i < circuit.neuronCount; i++) {
      if (neuronClass(circuit, i) === 'I_or_II') {
        ambiguous++;
        expect(circuit.classConfidence[i]).toBeLessThan(1);
      }
    }
    expect(ambiguous).toBeGreaterThan(0);
  });

  it('gives every classified cell a morphology-predicted provenance, never functional', () => {
    for (let i = 0; i < circuit.neuronCount; i++) {
      // 3 = functionally_measured. No cell in this release is functionally identified.
      expect(circuit.classProvenance[i]).not.toBe(3);
    }
  });

  it('defines populations by published labels, and all members exist', () => {
    const loreIndex = buildLoreIndex(circuit);
    expect(populations.populations.length).toBeGreaterThan(0);
    for (const population of populations.populations) {
      expect(population.definition.length).toBeGreaterThan(10);
      const unique = new Set(population.loreIds);
      expect(unique.size).toBe(population.loreIds.length);
      for (const lore of population.loreIds) {
        expect(loreIndex.has(lore)).toBe(true);
      }
    }
  });

  it('records that most cells have no traced outgoing connectivity', () => {
    // The distinction that matters: "not traced" is not "no partners".
    expect(circuit.tracing.cellsWithTracedContacts).toBeLessThan(circuit.neuronCount);
    expect(circuit.tracing.note).toMatch(/not traced|no partners/i);
    expect(circuit.tracing.unidentifiedContacts).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Network construction                                                    */
/* -------------------------------------------------------------------------- */

describe('network construction', () => {
  const { network } = makeRuntime();

  it('doubles the circuit into a bilaterally symmetric network', () => {
    expect(network.nodeCount).toBe(circuit.neuronCount * 2);
    expect(network.edgeCount).toBe(circuit.edgeCount * 2);
    expect(network.stats.measuredNodes).toBe(circuit.neuronCount);
    expect(network.stats.mirroredNodes).toBe(circuit.neuronCount);
  });

  it('flags mirrored nodes so they are never called measured cells', () => {
    let mirrored = 0;
    for (let n = 0; n < network.nodeCount; n++) mirrored += network.mirrored[n];
    expect(mirrored).toBe(circuit.neuronCount);
  });

  it('places each mirror twin on the opposite side, reflected through the midline', () => {
    const measured = circuit.neuronCount;
    const midline = circuit.midline.voxels;
    for (let i = 0; i < measured; i += 37) {
      const twin = i + measured;
      expect(network.hemisphere[twin]).toBe(network.hemisphere[i] === 0 ? 1 : 0);
      expect(network.positions[twin * 3]).toBe(network.positions[i * 3]);
      expect(network.positions[twin * 3 + 1]).toBe(2 * midline - network.positions[i * 3 + 1]);
      expect(network.classIndex[twin]).toBe(network.classIndex[i]);
    }
  });

  it('produces exactly matched left and right populations', () => {
    for (const population of network.populations) {
      expect(population.left.length).toBe(population.right.length);
    }
  });

  it('builds a consistent incoming CSR', () => {
    expect(network.inOffsets.length).toBe(network.nodeCount + 1);
    expect(network.inOffsets[network.nodeCount]).toBe(network.edgeCount);
    for (let n = 0; n < network.nodeCount; n++) {
      expect(network.inOffsets[n + 1]).toBeGreaterThanOrEqual(network.inOffsets[n]);
    }
  });

  it('preserves edge direction between the incoming and outgoing views', () => {
    let checked = 0;
    for (let post = 0; post < network.nodeCount && checked < 200; post++) {
      for (let e = network.inOffsets[post]; e < network.inOffsets[post + 1]; e++) {
        const pre = network.inSources[e];
        let found = false;
        for (let o = network.outOffsets[pre]; o < network.outOffsets[pre + 1]; o++) {
          if (network.outTargets[o] === post) found = true;
        }
        expect(found).toBe(true);
        checked++;
        if (checked >= 200) break;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("applies Dale's law: every edge out of a neuron shares its sign", () => {
    for (let pre = 0; pre < network.nodeCount; pre += 13) {
      const expected = Math.sign(network.sign[pre]);
      for (let o = network.outOffsets[pre]; o < network.outOffsets[pre + 1]; o++) {
        const weight = network.outWeights[o];
        if (weight !== 0) expect(Math.sign(weight)).toBe(expected);
      }
    }
  });

  it('gives unlabelled neurons zero signed drive under the strict policy', () => {
    const { network: strict } = makeRuntime({ signPolicy: 'strict' });
    for (let i = 0; i < circuit.neuronCount; i++) {
      if (neuronTransmitter(circuit, i) === 'unknown') {
        expect(strict.sign[i]).toBe(0);
        expect(strict.signConfidence[i]).toBe(0);
      }
    }
    expect(strict.stats.unsignedEdges).toBeGreaterThan(0);
    expect(strict.stats.imputedEdges).toBe(0);
  });

  it('class imputation only fires on pure classes and is down-weighted', () => {
    const { network: imputed } = makeRuntime({ signPolicy: 'class-imputed' });
    expect(imputed.stats.imputedEdges).toBeGreaterThan(0);
    for (let i = 0; i < circuit.neuronCount; i++) {
      if (neuronTransmitter(circuit, i) !== 'unknown') continue;
      if (imputed.sign[i] === 0) continue;
      // An imputed sign never carries full confidence.
      expect(imputed.signConfidence[i]).toBeLessThan(1);
      expect(imputed.signConfidence[i]).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('bounds the weight matrix so the model provably cannot diverge', () => {
    // Incoming weights are normalised per node, so each row sums to at most the
    // synaptic gain. That bounds the spectral radius below one.
    for (let n = 0; n < network.nodeCount; n += 7) {
      let rowSum = 0;
      for (let e = network.inOffsets[n]; e < network.inOffsets[n + 1]; e++) {
        rowSum += Math.abs(network.inWeights[e]);
      }
      expect(rowSum).toBeLessThanOrEqual(DEFAULT_BUILD_OPTIONS.synapticGain + 1e-5);
    }
  });

  it('adds exactly one modeled projection, and labels it as not measured', () => {
    expect(MODELED_PROJECTIONS.length).toBe(1);
    const projection = MODELED_PROJECTIONS[0];
    expect(projection.provenance).toBe('inferred');
    expect(projection.evidence.length).toBeGreaterThanOrEqual(2);
    expect(projection.sign).toBe(-1);
    expect(projection.side).toBe('opposite');
  });

  it('confirms the modeled projection is needed: Class II has no traced outputs', () => {
    const classII = HMI_CLASS_ORDER.indexOf('II');
    let outgoing = 0;
    for (let e = 0; e < circuit.edgeCount; e++) {
      if (circuit.classIndices[circuit.edgePre[e]] === classII) outgoing++;
    }
    expect(outgoing).toBe(0);
  });

  it('confirms the measured circuit does contain the rest of the pathway', () => {
    const index = (name: string) => HMI_CLASS_ORDER.indexOf(name as never);
    const count = (pre: string, post: string) => {
      let n = 0;
      for (let e = 0; e < circuit.edgeCount; e++) {
        if (
          circuit.classIndices[circuit.edgePre[e]] === index(pre) &&
          circuit.classIndices[circuit.edgePost[e]] === index(post)
        ) {
          n++;
        }
      }
      return n;
    };
    // Recurrent integration and the descending motor output are both measured.
    expect(count('I', 'I')).toBeGreaterThan(100);
    expect(count('I', 'SPN_turning')).toBeGreaterThan(10);
  });

  it('keeps measured Class I recurrence entirely within one hemisphere', () => {
    const classI = HMI_CLASS_ORDER.indexOf('I');
    let same = 0;
    let crossing = 0;
    for (let e = 0; e < circuit.edgeCount; e++) {
      const pre = circuit.edgePre[e];
      const post = circuit.edgePost[e];
      if (circuit.classIndices[pre] !== classI || circuit.classIndices[post] !== classI)
        continue;
      if (circuit.hemispheres[pre] === circuit.hemispheres[post]) same++;
      else crossing++;
    }
    expect(same).toBeGreaterThan(0);
    expect(crossing).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Model dynamics                                                          */
/* -------------------------------------------------------------------------- */

describe('model dynamics', () => {
  it('produces no decision from zero input', () => {
    const { runtime } = makeRuntime();
    const result = trial(runtime, { left: 0, right: 0 });
    expect(result.action).toBeNull();
    expect(Math.abs(result.decisionVariable)).toBeLessThan(DECISION_THRESHOLD);
  });

  it('produces no decision from symmetric input', () => {
    const { runtime } = makeRuntime();
    const result = trial(runtime, { left: 0.5, right: 0.5 });
    expect(result.action).toBeNull();
  });

  it('has no built-in directional bias', () => {
    // Averaged over seeds, symmetric input must not favour one side.
    const { runtime } = makeRuntime();
    let total = 0;
    for (let seed = 1; seed <= 12; seed++) {
      total += trial(runtime, { left: 0.5, right: 0.5, seconds: 4, seed }).decisionVariable;
    }
    expect(Math.abs(total / 12)).toBeLessThan(0.02);
  });

  it('lateralises correctly for rightward evidence', () => {
    const { runtime } = makeRuntime();
    const result = trial(runtime, { left: 0.1, right: 0.9 });
    expect(result.action).toBe('turn_right');
    expect(result.decisionVariable).toBeGreaterThan(0);
  });

  it('lateralises correctly for leftward evidence', () => {
    const { runtime } = makeRuntime();
    const result = trial(runtime, { left: 0.9, right: 0.1 });
    expect(result.action).toBe('turn_left');
    expect(result.decisionVariable).toBeLessThan(0);
  });

  it('is exactly reproducible from a seed', () => {
    const { runtime } = makeRuntime();
    const a = trial(runtime, { left: 0.2, right: 0.8 });
    const b = trial(runtime, { left: 0.2, right: 0.8 });
    expect(a.decisionVariable).toBe(b.decisionVariable);
    expect(a.latency).toBe(b.latency);
  });

  it('decides faster with stronger evidence', () => {
    // Latency is not computed from the stimulus anywhere; this ordering has to
    // emerge from the dynamics.
    const { runtime } = makeRuntime();
    const strong = trial(runtime, { left: 0, right: 1 });
    const moderate = trial(runtime, { left: 0.25, right: 0.75 });
    expect(strong.latency).not.toBeNull();
    expect(moderate.latency).not.toBeNull();
    expect(strong.latency!).toBeLessThan(moderate.latency!);
  });

  it('leaves weak evidence undecided rather than guessing', () => {
    const { runtime } = makeRuntime();
    const result = trial(runtime, { left: 0.45, right: 0.55, seconds: 10 });
    expect(result.action).toBeNull();
  });

  it('clears all state on reset', () => {
    const { runtime } = makeRuntime();
    trial(runtime, { left: 0.1, right: 0.9 });
    runtime.reset(7);
    const rates = runtime.getNeuronStateBuffer();
    for (const value of rates) expect(value).toBe(0);
    expect(runtime.getMotorIntent()).toBeNull();
    expect(runtime.getPopulationState().decisionVariable).toBe(0);
  });

  it('never produces NaN, Inf or out-of-range rates', () => {
    const { runtime } = makeRuntime();
    for (const [left, right] of [
      [0, 0],
      [1, 1],
      [1, 0],
      [0, 1],
      [0.5, 0.5],
    ]) {
      trial(runtime, { left, right, seconds: 4 });
      for (const value of runtime.getNeuronStateBuffer()) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('reports itself as simulated, never as measured activity', () => {
    const { runtime } = makeRuntime();
    expect(runtime.provenance.activityMeasured).toBe(false);
    expect(runtime.provenance.connectivityMeasured).toBe(true);
    expect(runtime.provenance.category).toBe('connectome_constrained_model');
    expect(runtime.getPopulationState().provenance).toBe('simulated');
    expect(runtime.provenance.caveats.length).toBeGreaterThanOrEqual(4);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Ablation                                                                */
/* -------------------------------------------------------------------------- */

describe('in silico ablation', () => {
  it('abolishes the decision when the measured recurrence is removed', () => {
    // The strongest claim this project makes: the integration comes from the
    // measured Class I recurrent connectivity, not from a tuned time constant.
    const { runtime } = makeRuntime();
    const control = trial(runtime, { left: 0.1, right: 0.9 });
    const ablated = trial(runtime, {
      left: 0.1,
      right: 0.9,
      ablations: [
        { id: 'r', label: 'recurrence', target: { kind: 'recurrence', className: 'I' } },
      ],
    });
    expect(control.action).toBe('turn_right');
    expect(ablated.action).toBeNull();
    expect(Math.abs(ablated.decisionVariable)).toBeLessThan(Math.abs(control.decisionVariable));
  });

  it('weakens lateralisation when the modeled crossed inhibition is removed', () => {
    const { runtime } = makeRuntime();
    const control = trial(runtime, { left: 0.35, right: 0.65 });
    const ablated = trial(runtime, {
      left: 0.35,
      right: 0.65,
      ablations: [
        {
          id: 'x',
          label: 'crossed inhibition',
          target: { kind: 'projection', projectionId: MODELED_PROJECTIONS[0].id },
        },
      ],
    });
    expect(Math.abs(ablated.decisionVariable)).toBeLessThan(Math.abs(control.decisionVariable));
  });

  it('abolishes decisions in one direction only when a hemisphere is silenced', () => {
    const { runtime } = makeRuntime();
    const silenceLeft: Ablation[] = [
      { id: 'h', label: 'left off', target: { kind: 'hemisphere', hemisphere: 'left' } },
    ];
    // The intact right hemisphere can still win.
    const rightward = trial(runtime, { left: 0.1, right: 0.9, ablations: silenceLeft });
    expect(rightward.action).toBe('turn_right');
    // A leftward decision requires the silenced side, so none is possible.
    const leftward = trial(runtime, { left: 0.9, right: 0.1, ablations: silenceLeft });
    expect(leftward.action).toBeNull();
  });

  it('abolishes the decision when the readout population is silenced', () => {
    const { runtime } = makeRuntime();
    const ablated = trial(runtime, {
      left: 0.1,
      right: 0.9,
      ablations: [
        { id: 's', label: 'spn off', target: { kind: 'class', className: 'SPN_turning' } },
      ],
    });
    expect(ablated.action).toBeNull();
    expect(ablated.decisionVariable).toBe(0);
  });

  it('silences exactly the targeted neuron and no other', () => {
    const { network, runtime } = makeRuntime();
    const target = classNodes(network, 'I', 'right')[0];
    runtime.reset(7);
    runtime.setAblations([
      { id: 'n', label: 'one neuron', target: { kind: 'neuron', node: target } },
    ]);
    runtime.setSensoryInput({ leftDrive: 0.1, rightDrive: 0.9, coherence: 1 });
    for (let i = 0; i < 100; i++) runtime.step(0.02);
    const rates = runtime.getNeuronStateBuffer();
    expect(rates[target]).toBe(0);
    // Its neighbours in the same population are still active.
    const others = classNodes(network, 'I', 'right');
    const active = Array.from(others).filter((n) => rates[n] > 0);
    expect(active.length).toBeGreaterThan(0);
  });

  it('is fully reversible', () => {
    const { runtime } = makeRuntime();
    const before = trial(runtime, { left: 0.1, right: 0.9 });
    trial(runtime, {
      left: 0.1,
      right: 0.9,
      ablations: [{ id: 'r', label: 'r', target: { kind: 'recurrence', className: 'I' } }],
    });
    const after = trial(runtime, { left: 0.1, right: 0.9, ablations: [] });
    expect(after.decisionVariable).toBe(before.decisionVariable);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Traces                                                                  */
/* -------------------------------------------------------------------------- */

describe('experiment trace', () => {
  it('is bounded and never grows past capacity', () => {
    const trace = new ExperimentTrace(16);
    for (let i = 0; i < 1000; i++) {
      trace.sample({
        time: i * 0.1,
        stimulus: 0,
        classILeft: 0,
        classIRight: 0,
        classIILeft: 0,
        classIIRight: 0,
        readoutLeft: 0,
        readoutRight: 0,
        decisionVariable: 0,
        bodyYaw: 0,
      });
    }
    expect(trace.length()).toBe(16);
    expect(trace.isFull()).toBe(true);
  });

  it('finds the nearest sample when scrubbing', () => {
    const trace = new ExperimentTrace(64);
    for (let i = 0; i < 20; i++) {
      trace.sample({
        time: i * 0.1,
        stimulus: 0,
        classILeft: 0,
        classIRight: 0,
        classIILeft: 0,
        classIIRight: 0,
        readoutLeft: 0,
        readoutRight: 0,
        decisionVariable: i,
        bodyYaw: 0,
      });
    }
    expect(trace.at(0.52)?.decisionVariable).toBe(5);
    expect(trace.at(-5)?.decisionVariable).toBe(0);
    expect(trace.at(1000)?.decisionVariable).toBe(19);
  });
});
