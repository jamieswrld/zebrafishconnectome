/**
 * Headless validation of the connectome-constrained HMI model.
 *
 * Runs the model outside the browser so the dynamics can be checked before any
 * UI depends on them:
 *
 *   node --import ./scripts/register-loader.mjs scripts/validate-neural.mjs
 *
 * It answers the questions that decide whether the circuit is doing the work:
 * does evidence accumulate, does the decision lateralise correctly, is the run
 * reproducible, and does removing a pathway change the outcome?
 */

import { readFileSync } from 'node:fs';

import { decodeHmiCircuit } from '@/core/hmi';
import { buildNetwork, DEFAULT_BUILD_OPTIONS, MODELED_PROJECTIONS } from '@/neural/network';
import { HmiNeuralRuntime } from '@/neural/runtime';
import { NEURAL_DT } from '@/neural/model';

const circuitBytes = readFileSync('public/datasets/fish1-hmi/v1/hmi.bin');
const circuit = decodeHmiCircuit(
  circuitBytes.buffer.slice(
    circuitBytes.byteOffset,
    circuitBytes.byteOffset + circuitBytes.byteLength,
  ),
);
const populations = JSON.parse(
  readFileSync('public/datasets/fish1-hmi/v1/populations.json', 'utf8'),
);
const populationMap = new Map(populations.populations.map((p) => [p.id, p.loreIds]));

console.log(`circuit: ${circuit.neuronCount} neurons, ${circuit.edgeCount} edges`);
console.log(`midline: y=${circuit.midline.voxels} (${circuit.midline.provenance})`);

function makeRuntime(options = {}) {
  const network = buildNetwork(circuit, populationMap, { ...DEFAULT_BUILD_OPTIONS, ...options });
  return { network, runtime: new HmiNeuralRuntime({ circuit, network, seed: 7 }) };
}

const { network, runtime } = makeRuntime();
console.log(
  `network: ${network.nodeCount} nodes (${network.stats.measuredNodes} measured + ${network.stats.mirroredNodes} mirrored), ${network.edgeCount} edges`,
);
console.log(
  `  signed edges: ${network.stats.excitatoryEdges} exc, ${network.stats.inhibitoryEdges} inh, ${network.stats.unsignedEdges} unsigned`,
);
for (const population of network.populations) {
  console.log(`  ${population.id.padEnd(16)} L ${population.left.length}  R ${population.right.length}`);
}

/** Runs one trial and returns the trace. */
function trial(runtime, { left, right, coherence = 1, seconds = 8, ablations = [] }) {
  runtime.reset(7);
  runtime.setAblations(ablations);
  runtime.setSensoryInput({ leftDrive: left, rightDrive: right, coherence });
  const samples = [];
  let decisionAt = null;
  let action = null;
  const steps = Math.round(seconds / 0.02);
  for (let i = 0; i < steps; i++) {
    const frame = runtime.step(0.02);
    samples.push({
      t: frame.time,
      dv: frame.populations.decisionVariable,
      classI: frame.populations.populations.find((p) => p.id === 'I'),
      spn: frame.populations.populations.find((p) => p.id === 'SPN_turning'),
    });
    if (decisionAt === null && frame.intent) {
      decisionAt = frame.intent.time;
      action = frame.intent.action;
    }
  }
  return { samples, decisionAt, action, last: samples.at(-1) };
}

const bar = (v, scale = 40) => '#'.repeat(Math.max(0, Math.round(Math.abs(v) * scale)));

console.log('\n=== 1. RIGHTWARD EVIDENCE ===');
const rightward = trial(runtime, { left: 0.1, right: 0.9 });
for (const s of rightward.samples.filter((_, i) => i % 50 === 0)) {
  console.log(
    `  t=${s.t.toFixed(2)}s  I L${s.classI.left.toFixed(3)} R${s.classI.right.toFixed(3)}  ` +
      `SPN L${s.spn.left.toFixed(3)} R${s.spn.right.toFixed(3)}  dv=${s.dv.toFixed(4)} ${bar(s.dv, 200)}`,
  );
}
console.log(`  DECISION: ${rightward.action} at ${rightward.decisionAt?.toFixed(3)}s`);

console.log('\n=== 2. LEFTWARD EVIDENCE ===');
const leftward = trial(runtime, { left: 0.9, right: 0.1 });
console.log(
  `  final dv=${leftward.last.dv.toFixed(4)}  DECISION: ${leftward.action} at ${leftward.decisionAt?.toFixed(3)}s`,
);

console.log('\n=== 3. SYMMETRIC (ambiguous) EVIDENCE ===');
const symmetric = trial(runtime, { left: 0.5, right: 0.5 });
console.log(
  `  final dv=${symmetric.last.dv.toFixed(4)}  DECISION: ${symmetric.action ?? 'none'} at ${symmetric.decisionAt?.toFixed(3) ?? '-'}`,
);

console.log('\n=== 4. ZERO INPUT ===');
const zero = trial(runtime, { left: 0, right: 0 });
console.log(
  `  final dv=${zero.last.dv.toFixed(4)}  DECISION: ${zero.action ?? 'none'}  (must be none)`,
);

console.log('\n=== 5. DETERMINISM ===');
const a = trial(runtime, { left: 0.1, right: 0.9 });
const b = trial(runtime, { left: 0.1, right: 0.9 });
const identical = a.samples.every((s, i) => s.dv === b.samples[i].dv);
console.log(`  same seed reproduces identical trace: ${identical}`);

console.log('\n=== 6. COHERENCE / EVIDENCE STRENGTH ===');
for (const strength of [0.55, 0.65, 0.8, 1.0]) {
  const r = trial(runtime, { left: 1 - strength, right: strength, seconds: 12 });
  console.log(
    `  right=${strength.toFixed(2)}  decision ${String(r.action ?? 'none').padEnd(10)} latency ${r.decisionAt ? r.decisionAt.toFixed(3) + 's' : '   none'}  final dv ${r.last.dv.toFixed(4)}`,
  );
}

console.log('\n=== 7. ABLATION: modeled crossed inhibition OFF ===');
const noCross = trial(runtime, {
  left: 0.1,
  right: 0.9,
  ablations: [
    {
      id: 'x',
      label: 'crossed inhibition off',
      target: { kind: 'projection', projectionId: MODELED_PROJECTIONS[0].id },
    },
  ],
});
console.log(
  `  control  dv=${rightward.last.dv.toFixed(4)}  decision ${rightward.action} @ ${rightward.decisionAt?.toFixed(3)}s`,
);
console.log(
  `  ablated  dv=${noCross.last.dv.toFixed(4)}  decision ${noCross.action ?? 'none'} @ ${noCross.decisionAt?.toFixed(3) ?? '-'}`,
);

console.log('\n=== 8. ABLATION: Class I ipsilateral recurrence OFF ===');
const noRec = trial(runtime, {
  left: 0.1,
  right: 0.9,
  ablations: [
    { id: 'r', label: 'recurrence off', target: { kind: 'recurrence', className: 'I' } },
  ],
});
console.log(
  `  ablated  dv=${noRec.last.dv.toFixed(4)}  decision ${noRec.action ?? 'none'} @ ${noRec.decisionAt?.toFixed(3) ?? '-'}`,
);

console.log('\n=== 9. ABLATION: SPN_turning silenced (readout removed) ===');
const noSpn = trial(runtime, {
  left: 0.1,
  right: 0.9,
  ablations: [{ id: 's', label: 'spn off', target: { kind: 'class', className: 'SPN_turning' } }],
});
console.log(
  `  ablated  dv=${noSpn.last.dv.toFixed(4)}  decision ${noSpn.action ?? 'none'}  (must be none)`,
);

console.log('\n=== 10. NUMERICAL SANITY ===');
const rates = runtime.getNeuronStateBuffer();
let bad = 0;
let maxRate = 0;
for (const v of rates) {
  if (!Number.isFinite(v) || v < 0 || v > 1) bad++;
  maxRate = Math.max(maxRate, v);
}
console.log(`  out-of-range or non-finite rates: ${bad}  max rate ${maxRate.toFixed(4)}`);

console.log('\n=== 11. STEP COST ===');
runtime.reset(7);
runtime.setSensoryInput({ leftDrive: 0.1, rightDrive: 0.9, coherence: 1 });
const t0 = performance.now();
const iterations = 200;
for (let i = 0; i < iterations; i++) runtime.step(0.02);
const elapsed = performance.now() - t0;
console.log(
  `  ${iterations} x 20 ms of simulated time (= ${(iterations * 0.02).toFixed(1)}s, ${Math.round(0.02 / NEURAL_DT)} neural steps each) in ${elapsed.toFixed(1)} ms`,
);
console.log(`  ${(elapsed / iterations).toFixed(4)} ms per 20 ms behaviour tick`);
console.log(`  real-time factor: ${((iterations * 0.02 * 1000) / elapsed).toFixed(0)}x`);
