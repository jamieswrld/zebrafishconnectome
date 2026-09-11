/**
 * Parameter regime survey for the HMI model.
 *
 * The model has a small number of free parameters that the connectome cannot
 * fix: how hard sensory evidence drives the input layer, how strong the modeled
 * crossed inhibition is, and where the decision threshold sits. This script
 * shows what regime each choice puts the network in, so the values shipped are
 * chosen against stated criteria rather than nudged until a demo looked good.
 *
 *   node --import ./scripts/register-loader.mjs scripts/sweep-neural.mjs
 */

import { readFileSync } from 'node:fs';

import { decodeHmiCircuit } from '@/core/hmi';
import { buildNetwork, DEFAULT_BUILD_OPTIONS, MODELED_PROJECTIONS } from '@/neural/network';
import { HmiNeuralRuntime } from '@/neural/runtime';

const bytes = readFileSync('public/datasets/fish1-hmi/v1/hmi.bin');
const circuit = decodeHmiCircuit(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
);
const populations = JSON.parse(readFileSync('public/datasets/fish1-hmi/v1/populations.json', 'utf8'));
const populationMap = new Map(populations.populations.map((p) => [p.id, p.loreIds]));

function run({ gain = 0.9, crossGain, right, left, seconds = 10, seed = 7, ablations = [] }) {
  const projections =
    crossGain === undefined
      ? MODELED_PROJECTIONS
      : MODELED_PROJECTIONS.map((p) => ({ ...p, gain: crossGain }));
  const network = buildNetwork(circuit, populationMap, {
    ...DEFAULT_BUILD_OPTIONS,
    synapticGain: gain,
  });
  // Swap in the adjusted projection gain for the sweep.
  const patched = { ...network, projections };
  const runtime = new HmiNeuralRuntime({ circuit, network: patched, seed });
  runtime.reset(seed);
  runtime.setAblations(ablations);
  runtime.setSensoryInput({ leftDrive: left, rightDrive: right, coherence: 1 });
  let decisionAt = null;
  let action = null;
  let peak = 0;
  const steps = Math.round(seconds / 0.02);
  let last = null;
  for (let i = 0; i < steps; i++) {
    const frame = runtime.step(0.02);
    last = frame.populations;
    peak = Math.max(peak, Math.abs(frame.populations.decisionVariable));
    if (decisionAt === null && frame.intent) {
      decisionAt = frame.intent.time;
      action = frame.intent.action;
    }
  }
  const pop = (id) => last.populations.find((p) => p.id === id);
  return {
    dv: last.decisionVariable,
    peak,
    decisionAt,
    action,
    classI: pop('I'),
    classII: pop('II'),
    spn: pop('SPN_turning'),
  };
}

console.log('=== A. Crossed-inhibition gain, symmetric input (0.5 / 0.5) ===');
console.log('   want: both sides ACTIVE and competing, not both crushed to zero');
console.log('  gain   I.L    I.R    II.L   II.R   SPN.L  SPN.R   |dv|peak');
for (const crossGain of [0, 0.2, 0.4, 0.6, 0.9, 1.4]) {
  const r = run({ crossGain, left: 0.5, right: 0.5 });
  console.log(
    `  ${crossGain.toFixed(2)}   ${r.classI.left.toFixed(3)}  ${r.classI.right.toFixed(3)}  ` +
      `${r.classII.left.toFixed(3)}  ${r.classII.right.toFixed(3)}  ` +
      `${r.spn.left.toFixed(3)}  ${r.spn.right.toFixed(3)}   ${r.peak.toFixed(4)}`,
  );
}

console.log('\n=== B. Crossed-inhibition gain, asymmetric input (0.35 / 0.65) ===');
console.log('   want: inhibition AMPLIFIES the difference (competition does work)');
console.log('  gain   I.L    I.R    SPN.L  SPN.R   dv      ratio R/L');
for (const crossGain of [0, 0.2, 0.4, 0.6, 0.9, 1.4]) {
  const r = run({ crossGain, left: 0.35, right: 0.65 });
  const ratio = r.spn.left > 1e-6 ? (r.spn.right / r.spn.left).toFixed(2) : 'inf';
  console.log(
    `  ${crossGain.toFixed(2)}   ${r.classI.left.toFixed(3)}  ${r.classI.right.toFixed(3)}  ` +
      `${r.spn.left.toFixed(3)}  ${r.spn.right.toFixed(3)}   ${r.dv.toFixed(4)}  ${ratio}`,
  );
}

console.log('\n=== C. Recurrent gain -> plateau and rise time (0.35 / 0.65) ===');
console.log('  g      tau_eff   dv        I.R');
for (const gain of [0.0, 0.5, 0.8, 0.9, 0.95]) {
  const r = run({ gain, left: 0.35, right: 0.65 });
  console.log(
    `  ${gain.toFixed(2)}   ${(0.1 / Math.max(1 - gain, 1e-6)).toFixed(2)}s     ${r.dv.toFixed(4)}   ${r.classI.right.toFixed(3)}`,
  );
}

console.log('\n=== D. Evidence strength -> dv plateau (threshold calibration) ===');
console.log('  right  left   dv plateau');
const plateaus = [];
for (const right of [0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 0.9, 1.0]) {
  const r = run({ left: 1 - right, right });
  plateaus.push([right, r.dv]);
  console.log(`  ${right.toFixed(2)}   ${(1 - right).toFixed(2)}   ${r.dv.toFixed(4)}`);
}

console.log('\n=== E. Ablation sensitivity at NEAR-THRESHOLD evidence (0.42 / 0.58) ===');
const control = run({ left: 0.42, right: 0.58 });
console.log(`  control                    dv ${control.dv.toFixed(4)}  SPN L${control.spn.left.toFixed(3)} R${control.spn.right.toFixed(3)}`);
const noCross = run({
  left: 0.42,
  right: 0.58,
  ablations: [
    { id: 'x', label: 'x', target: { kind: 'projection', projectionId: MODELED_PROJECTIONS[0].id } },
  ],
});
console.log(`  crossed inhibition OFF     dv ${noCross.dv.toFixed(4)}  SPN L${noCross.spn.left.toFixed(3)} R${noCross.spn.right.toFixed(3)}`);
const noRec = run({
  left: 0.42,
  right: 0.58,
  ablations: [{ id: 'r', label: 'r', target: { kind: 'recurrence', className: 'I' } }],
});
console.log(`  Class I recurrence OFF     dv ${noRec.dv.toFixed(4)}  SPN L${noRec.spn.left.toFixed(3)} R${noRec.spn.right.toFixed(3)}`);
