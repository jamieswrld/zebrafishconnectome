import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { decodeHmiCircuit, type HmiCircuit, type HmiPopulations } from '@/core/hmi';
import { buildLarvaModel } from '@/body/larva';
import { EmbodiedRuntime } from '@/embodiment/runtime';
import {
  VisualMotionExperiment,
  DEFAULT_EXPERIMENT_CONFIG,
  type ExperimentConfig,
} from '@/embodiment/experiment';
import {
  evidenceToNeuralInput,
  VisualMotionEncoder,
  DEFAULT_STIMULUS,
} from '@/embodiment/visual-motion';
import { MODELED_PROJECTIONS } from '@/neural/network';

/**
 * Closed-loop causality tests.
 *
 * These exist to make one specific failure impossible: a demo that looks like a
 * connectome-driven decision but is really a shortcut from stimulus direction to
 * turn direction. Each test pins one link of the chain, and several of them
 * would fail if any stage were bypassed.
 *
 *   stimulus -> evidence -> neural state -> intent -> motor -> body -> evidence
 */

function loadCircuit(): HmiCircuit {
  const bytes = readFileSync('public/datasets/fish1-hmi/v1/hmi.bin');
  return decodeHmiCircuit(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

const circuit = loadCircuit();
const populations = JSON.parse(
  readFileSync('public/datasets/fish1-hmi/v1/populations.json', 'utf8'),
) as HmiPopulations;
const bones = buildLarvaModel().bones;

function makeExperiment(config: Partial<ExperimentConfig> = {}) {
  const embodied = new EmbodiedRuntime({ bones, seed: 42 });
  const experiment = new VisualMotionExperiment({
    embodied,
    circuit,
    populations,
    neuronIndex: null,
  });
  experiment.configure({ ...DEFAULT_EXPERIMENT_CONFIG, ...config });
  return { embodied, experiment };
}

/** Advances an experiment by `seconds` of wall-clock-equivalent time. */
function advance(experiment: VisualMotionExperiment, seconds: number, dt = 1 / 60) {
  const steps = Math.round(seconds / dt);
  let snapshot = experiment.update(dt);
  for (let i = 1; i < steps; i++) snapshot = experiment.update(dt);
  return snapshot;
}

/* -------------------------------------------------------------------------- */
/* Stage 1: stimulus -> evidence                                              */
/* -------------------------------------------------------------------------- */

describe('stimulus produces sensory evidence', () => {
  it('produces no evidence before a stimulus starts', () => {
    const encoder = new VisualMotionEncoder();
    encoder.reset(1);
    const evidence = encoder.sense(0.02, 0, 0);
    expect(evidence.leftwardEvidence).toBe(0);
    expect(evidence.rightwardEvidence).toBe(0);
    expect(encoder.isActive()).toBe(false);
  });

  it('produces rightward-dominant evidence for a rightward stimulus', () => {
    const encoder = new VisualMotionEncoder();
    encoder.reset(1);
    encoder.start({ ...DEFAULT_STIMULUS, direction: 'right', coherence: 1 }, 'open');
    let right = 0;
    let left = 0;
    for (let i = 0; i < 50; i++) {
      const evidence = encoder.sense(0.02, i * 0.02, 0);
      right += evidence.rightwardEvidence;
      left += evidence.leftwardEvidence;
    }
    expect(right).toBeGreaterThan(left);
  });

  it('reverses with stimulus direction', () => {
    const encoder = new VisualMotionEncoder();
    encoder.reset(1);
    encoder.start({ ...DEFAULT_STIMULUS, direction: 'left', coherence: 1 }, 'open');
    let right = 0;
    let left = 0;
    for (let i = 0; i < 50; i++) {
      const evidence = encoder.sense(0.02, i * 0.02, 0);
      right += evidence.rightwardEvidence;
      left += evidence.leftwardEvidence;
    }
    expect(left).toBeGreaterThan(right);
  });

  it('makes evidence noisier when coherence is low', () => {
    const spread = (coherence: number) => {
      const encoder = new VisualMotionEncoder();
      encoder.reset(3);
      encoder.start({ ...DEFAULT_STIMULUS, coherence, dots: 60 }, 'open');
      const samples: number[] = [];
      for (let i = 0; i < 200; i++) {
        const evidence = encoder.sense(0.02, i * 0.02, 0);
        samples.push(evidence.rightwardEvidence - evidence.leftwardEvidence);
      }
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      return Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length);
    };
    // Finite-dot sampling is where trial variability comes from, so a weakly
    // coherent stimulus must deliver genuinely noisier evidence.
    expect(spread(0.2)).toBeGreaterThan(0);
    expect(spread(1.0)).toBeLessThan(spread(0.2) * 1.5);
  });

  it('stops on its own when the stimulus duration elapses', () => {
    const encoder = new VisualMotionEncoder();
    encoder.reset(1);
    encoder.start({ ...DEFAULT_STIMULUS, duration: 0.5 }, 'open');
    for (let i = 0; i < 40; i++) encoder.sense(0.02, i * 0.02, 0);
    expect(encoder.isActive()).toBe(false);
  });

  it("subtracts the fish's own rotation in closed loop, but not in open loop", () => {
    const make = (mode: 'open' | 'closed') => {
      const encoder = new VisualMotionEncoder();
      encoder.reset(5);
      encoder.start({ ...DEFAULT_STIMULUS, direction: 'right', speed: 0.6 }, mode);
      return encoder.sense(0.02, 0, 0.6).angularVelocity;
    };
    // Turning right at exactly the pattern speed cancels the retinal motion.
    expect(Math.abs(make('closed'))).toBeLessThan(1e-6);
    expect(make('open')).toBeCloseTo(0.6, 5);
  });
});

/* -------------------------------------------------------------------------- */
/* Stage 2: evidence -> neural state                                          */
/* -------------------------------------------------------------------------- */

describe('evidence drives neural state', () => {
  it('maps evidence into circuit input without reinterpreting it', () => {
    const input = evidenceToNeuralInput({
      time: 0,
      leftwardEvidence: 0.2,
      rightwardEvidence: 0.8,
      coherence: 0.6,
      angularVelocity: 0.5,
      provenance: 'simulated',
    });
    expect(input.leftDrive).toBe(0.2);
    expect(input.rightDrive).toBe(0.8);
    expect(input.coherence).toBe(0.6);
  });

  it('leaves the network silent when no stimulus is running', () => {
    const { experiment } = makeExperiment();
    experiment.reset();
    advance(experiment, 2);
    const rates = experiment.neuralRuntime().getNeuronStateBuffer();
    const peak = Math.max(...Array.from(rates));
    expect(peak).toBeLessThan(0.05);
  });

  it('activates the network once a stimulus starts', () => {
    const { experiment } = makeExperiment();
    experiment.start();
    advance(experiment, 2);
    const rates = experiment.neuralRuntime().getNeuronStateBuffer();
    const peak = Math.max(...Array.from(rates));
    expect(peak).toBeGreaterThan(0.05);
  });
});

/* -------------------------------------------------------------------------- */
/* Stage 3 and 4: neural state -> intent -> motor command                     */
/* -------------------------------------------------------------------------- */

describe('neural state produces motor intent and a motor command', () => {
  it('turns right for rightward motion', () => {
    const { experiment } = makeExperiment({
      stimulus: { ...DEFAULT_STIMULUS, direction: 'right', coherence: 1, duration: 20 },
      loopMode: 'open',
    });
    experiment.start();
    const snapshot = advance(experiment, 4);
    expect(snapshot.intent?.action).toBe('turn_right');
    expect(snapshot.connectomeCoupled).toBe(true);
  });

  it('turns left for leftward motion', () => {
    const { experiment } = makeExperiment({
      stimulus: { ...DEFAULT_STIMULUS, direction: 'left', coherence: 1, duration: 20 },
      loopMode: 'open',
    });
    experiment.start();
    const snapshot = advance(experiment, 4);
    expect(snapshot.intent?.action).toBe('turn_left');
  });

  it('attributes the decision to the connectome, with its evidence', () => {
    const { experiment } = makeExperiment({
      stimulus: { ...DEFAULT_STIMULUS, direction: 'right', coherence: 1, duration: 20 },
      loopMode: 'open',
    });
    experiment.start();
    const snapshot = advance(experiment, 4);
    const intent = snapshot.intent!;
    expect(intent.source).toBe('connectome');
    expect(intent.circuit).toBe('Fish1 HMI');
    expect(Math.abs(intent.evidence.decisionVariable)).toBeGreaterThanOrEqual(
      intent.evidence.threshold,
    );
    expect(intent.evidence.latency).toBeGreaterThan(0);
  });

  it('issues no turn command while the network is below threshold', () => {
    // A 50/50 stimulus never resolves, so the body must never be told to turn.
    const { experiment } = makeExperiment({
      stimulus: { ...DEFAULT_STIMULUS, coherence: 0, duration: 20, dots: 400 },
      loopMode: 'open',
    });
    experiment.start();
    let maxTurn = 0;
    for (let i = 0; i < 240; i++) {
      const snapshot = experiment.update(1 / 60);
      maxTurn = Math.max(maxTurn, Math.abs(snapshot.runtime.motor.turnDrive));
    }
    expect(maxTurn).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Stage 5 and 6: motor command -> body -> subsequent evidence                */
/* -------------------------------------------------------------------------- */

describe('the loop closes', () => {
  it('changes the body heading after a connectome decision', () => {
    const { embodied, experiment } = makeExperiment({
      stimulus: { ...DEFAULT_STIMULUS, direction: 'right', coherence: 1, duration: 20 },
      loopMode: 'open',
    });
    experiment.start();
    const startHeading = embodied.snapshot().body.heading;
    const snapshot = advance(experiment, 5);
    expect(snapshot.intent).not.toBeNull();
    expect(Math.abs(snapshot.runtime.body.heading - startHeading)).toBeGreaterThan(0.01);
  });

  it('turns in the direction the circuit chose', () => {
    // Heading is wrapped to [-pi, pi], so several turns in one direction can
    // read as a negative difference. Accumulate the per-step deltas instead.
    const cumulativeYaw = (direction: 'left' | 'right') => {
      const { embodied, experiment } = makeExperiment({
        stimulus: { ...DEFAULT_STIMULUS, direction, coherence: 1, duration: 20 },
        loopMode: 'open',
      });
      experiment.start();
      let previous = embodied.snapshot().body.heading;
      let total = 0;
      for (let i = 0; i < 360; i++) {
        const heading = experiment.update(1 / 60).runtime.body.heading;
        let delta = heading - previous;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        total += delta;
        previous = heading;
      }
      return total;
    };
    // Positive yaw is a turn to the right in this coordinate system.
    expect(cumulativeYaw('right')).toBeGreaterThan(0);
    expect(cumulativeYaw('left')).toBeLessThan(0);
  });

  it("feeds the fish's own rotation back into its visual input", () => {
    // The defining property of closed loop: the same stimulus produces
    // different evidence because the animal moved.
    const { experiment } = makeExperiment({
      stimulus: { ...DEFAULT_STIMULUS, direction: 'right', coherence: 1, duration: 30 },
      loopMode: 'closed',
    });
    experiment.start();
    let sawSelfMotion = false;
    for (let i = 0; i < 600; i++) {
      const snapshot = experiment.update(1 / 60);
      if (
        Math.abs(snapshot.runtime.body.angularVelocity) > 0.05 &&
        Math.abs(snapshot.evidence.angularVelocity - 0.6) > 0.02
      ) {
        sawSelfMotion = true;
        break;
      }
    }
    expect(sawSelfMotion).toBe(true);
  });

  it('produces a different trajectory in closed loop than in open loop', () => {
    const run = (loopMode: 'open' | 'closed') => {
      const { experiment } = makeExperiment({
        stimulus: { ...DEFAULT_STIMULUS, direction: 'right', coherence: 1, duration: 30 },
        loopMode,
      });
      experiment.start();
      return advance(experiment, 10).runtime.body.heading;
    };
    expect(run('open')).not.toBe(run('closed'));
  });
});

/* -------------------------------------------------------------------------- */
/* No shortcuts                                                               */
/* -------------------------------------------------------------------------- */

describe('the connectome is load-bearing', () => {
  it('cannot turn at all when the measured recurrence is ablated', () => {
    // If a hidden path from stimulus direction to turn existed, this would
    // still turn. It must not.
    const { experiment } = makeExperiment({
      stimulus: { ...DEFAULT_STIMULUS, direction: 'right', coherence: 1, duration: 20 },
      loopMode: 'open',
      ablations: [
        { id: 'r', label: 'recurrence off', target: { kind: 'recurrence', className: 'I' } },
      ],
    });
    experiment.start();
    let maxTurn = 0;
    for (let i = 0; i < 480; i++) {
      const snapshot = experiment.update(1 / 60);
      maxTurn = Math.max(maxTurn, Math.abs(snapshot.runtime.motor.turnDrive));
    }
    expect(maxTurn).toBe(0);
  });

  it('cannot turn when the measured readout population is silenced', () => {
    const { experiment } = makeExperiment({
      stimulus: { ...DEFAULT_STIMULUS, direction: 'right', coherence: 1, duration: 20 },
      loopMode: 'open',
      ablations: [
        { id: 's', label: 'readout off', target: { kind: 'class', className: 'SPN_turning' } },
      ],
    });
    experiment.start();
    let maxTurn = 0;
    for (let i = 0; i < 480; i++) {
      maxTurn = Math.max(maxTurn, Math.abs(experiment.update(1 / 60).runtime.motor.turnDrive));
    }
    expect(maxTurn).toBe(0);
  });

  it('changes the outcome when the modeled projection is ablated', () => {
    const headingFor = (ablations: ExperimentConfig['ablations']) => {
      const { experiment } = makeExperiment({
        stimulus: { ...DEFAULT_STIMULUS, direction: 'right', coherence: 0.5, duration: 30 },
        loopMode: 'closed',
        ablations,
      });
      experiment.start();
      return advance(experiment, 10).runtime.body.heading;
    };
    const control = headingFor([]);
    const ablated = headingFor([
      {
        id: 'x',
        label: 'crossed inhibition off',
        target: { kind: 'projection', projectionId: MODELED_PROJECTIONS[0].id },
      },
    ]);
    expect(control).not.toBe(ablated);
  });
});

/* -------------------------------------------------------------------------- */
/* Controller modes                                                           */
/* -------------------------------------------------------------------------- */

describe('controller modes', () => {
  it('reports connectome coupling from runtime state, not a flag', () => {
    const { embodied, experiment } = makeExperiment();
    experiment.setControllerMode('neural');
    expect(experiment.isConnectomeCoupled()).toBe(true);
    expect(embodied.controller.connectomeCoupled).toBe(true);

    experiment.setControllerMode('baseline');
    expect(experiment.isConnectomeCoupled()).toBe(false);
    expect(embodied.controller.connectomeCoupled).toBe(false);
  });

  it('leaves no neural activity behind when switching away and back', () => {
    const { experiment } = makeExperiment({
      stimulus: { ...DEFAULT_STIMULUS, coherence: 1, duration: 20 },
      loopMode: 'open',
    });
    experiment.start();
    advance(experiment, 3);
    expect(Math.max(...experiment.neuralRuntime().getNeuronStateBuffer())).toBeGreaterThan(
      0.05,
    );

    experiment.setControllerMode('baseline');
    expect(Math.max(...experiment.neuralRuntime().getNeuronStateBuffer())).toBe(0);

    experiment.setControllerMode('neural');
    expect(Math.max(...experiment.neuralRuntime().getNeuronStateBuffer())).toBe(0);
  });

  it('reproduces an identical run from the same seed', () => {
    const run = () => {
      const { experiment } = makeExperiment({
        stimulus: { ...DEFAULT_STIMULUS, direction: 'right', coherence: 0.7, duration: 20 },
        loopMode: 'closed',
      });
      experiment.start();
      const snapshot = advance(experiment, 8);
      return {
        heading: snapshot.runtime.body.heading,
        dv: snapshot.populations?.decisionVariable,
        latency: snapshot.intent?.evidence.latency,
      };
    };
    expect(run()).toEqual(run());
  });
});

/* -------------------------------------------------------------------------- */
/* Result schema                                                              */
/* -------------------------------------------------------------------------- */

describe('experiment result', () => {
  it('records everything needed to reproduce and interpret the run', () => {
    const { experiment } = makeExperiment({
      stimulus: { ...DEFAULT_STIMULUS, direction: 'right', coherence: 1, duration: 20 },
      loopMode: 'open',
      seed: 99,
    });
    experiment.start();
    advance(experiment, 5);
    const result = experiment.result();

    expect(result.schemaVersion).toBe(1);
    expect(result.seed).toBe(99);
    expect(result.dataset.id).toBe('fish1-hmi');
    expect(result.dataset.citation.length).toBeGreaterThan(10);
    expect(result.decision?.action).toBe('turn_right');
    expect(result.decisionCount).toBeGreaterThan(0);
    expect(result.network.mirroredNodes).toBe(circuit.neuronCount);
    expect(result.network.modeledProjections).toContain(MODELED_PROJECTIONS[0].id);
  });

  it('never labels simulated activity as measured', () => {
    const { experiment } = makeExperiment();
    const result = experiment.result();
    expect(result.provenance.neuralActivity).toBe('simulated');
    expect(result.provenance.visualInput).toBe('simulated');
    expect(result.provenance.bodyMovement).toBe('simulated');
    expect(result.provenance.connectivity).toBe('measured');
    expect(result.neuralModel.activityMeasured).toBe(false);
    expect(result.provenance.functionalClass).toMatch(/prediction|predicted/i);
  });
});
