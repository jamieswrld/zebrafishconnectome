/**
 * Chronometric and psychometric curves for the HMI model.
 *
 * Runs many seeds per coherence level to measure what the model actually does,
 * rather than what a single trial suggests. These are the numbers quoted in
 * docs/NEURAL_RUNTIME.md and used to calibrate the decision threshold.
 *
 *   node --import ./scripts/register-loader.mjs scripts/psychometric.mjs
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
const network = buildNetwork(circuit, populationMap, DEFAULT_BUILD_OPTIONS);
const runtime = new HmiNeuralRuntime({ circuit, network, seed: 1 });

const SEEDS = 40;
const SECONDS = 10;

/**
 * Coherence maps to drive the way a motion stimulus does: c = 0 is a balanced
 * 50/50 stimulus, c = 1 is entirely one direction.
 */
function drives(coherence, direction) {
  const signal = 0.5 + 0.5 * coherence;
  return direction > 0
    ? { left: 1 - signal, right: signal }
    : { left: signal, right: 1 - signal };
}

function trial(coherence, direction, seed, ablations = []) {
  runtime.reset(seed);
  runtime.setAblations(ablations);
  const d = drives(coherence, direction);
  runtime.setSensoryInput({ leftDrive: d.left, rightDrive: d.right, coherence });
  const steps = Math.round(SECONDS / 0.02);
  for (let i = 0; i < steps; i++) {
    const frame = runtime.step(0.02);
    if (frame.intent) return { action: frame.intent.action, latency: frame.intent.time };
  }
  return { action: 'none', latency: null };
}

function summarise(label, coherence, ablations = []) {
  let correct = 0;
  let wrong = 0;
  let none = 0;
  const latencies = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    // Alternate the true direction so a directional bias would show up as
    // accuracy collapsing to 50%, not as a uniformly "correct" result.
    const direction = seed % 2 === 0 ? 1 : -1;
    const expected = direction > 0 ? 'turn_right' : 'turn_left';
    const r = trial(coherence, direction, seed, ablations);
    if (r.action === 'none') none++;
    else if (r.action === expected) {
      correct++;
      latencies.push(r.latency);
    } else {
      wrong++;
      latencies.push(r.latency);
    }
  }
  latencies.sort((a, b) => a - b);
  const median = latencies.length
    ? latencies[Math.floor(latencies.length / 2)].toFixed(3) + 's'
    : '     -';
  const decided = correct + wrong;
  const accuracy = decided ? ((correct / decided) * 100).toFixed(0) + '%' : '  -';
  console.log(
    `  ${label.padEnd(8)} decided ${String(decided).padStart(2)}/${SEEDS}   ` +
      `correct ${accuracy.padStart(4)}   median latency ${median}   (wrong ${wrong}, none ${none})`,
  );
  return { coherence, decided, correct, wrong, none, median };
}

console.log(`HMI model: ${SEEDS} seeds per level, ${SECONDS}s trials, threshold 0.15\n`);
console.log('=== CHRONOMETRIC / PSYCHOMETRIC (control) ===');
for (const coherence of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0]) {
  summarise(`c=${coherence.toFixed(2)}`, coherence);
}

console.log('\n=== ABLATION: modeled Class II crossed inhibition OFF ===');
const crossOff = [
  {
    id: 'x',
    label: 'crossed inhibition off',
    target: { kind: 'projection', projectionId: MODELED_PROJECTIONS[0].id },
  },
];
for (const coherence of [0.2, 0.3, 0.5, 1.0]) {
  summarise(`c=${coherence.toFixed(2)}`, coherence, crossOff);
}

console.log('\n=== ABLATION: measured Class I ipsilateral recurrence OFF ===');
const recOff = [
  { id: 'r', label: 'recurrence off', target: { kind: 'recurrence', className: 'I' } },
];
for (const coherence of [0.2, 0.3, 0.5, 1.0]) {
  summarise(`c=${coherence.toFixed(2)}`, coherence, recOff);
}

console.log('\n=== ABLATION: one hemisphere silenced (left) ===');
const hemiOff = [
  { id: 'h', label: 'left hemisphere off', target: { kind: 'hemisphere', hemisphere: 'left' } },
];
for (const coherence of [0.3, 1.0]) {
  summarise(`c=${coherence.toFixed(2)}`, coherence, hemiOff);
}
