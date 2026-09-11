# Experiments

How to run, share and reproduce a connectome-driven behavioural experiment.

Live: [`/experiments/visual-motion`](https://zebrafishconnectome.vercel.app/experiments/visual-motion)

---

## 1. Visual motion decision

The first experiment in which a measured Fish1 circuit materially determines
what the virtual animal does.

A coherent-motion pattern drifts left or right. Evidence enters the traced input
layer of the reconstructed hindbrain motion integrator, accumulates through
measured recurrent Class I connectivity, competes across the midline, and — if
it crosses threshold — produces a turn.

### Controls

| Control | Range | Meaning |
|---|---|---|
| Motion | left / right | pattern direction |
| Coherence | 0–100% | fraction of dots moving together |
| Speed | 0.1–1.5 rad/s | angular speed of the pattern |
| Duration | 2–40 s | how long the stimulus runs |
| Noise | 0–1 | extra sensory noise beyond finite-dot sampling |
| Loop | open / closed | whether the animal's own rotation feeds back |
| Seed | integer | fixes the entire run |
| Controller | neural / baseline / manual | which policy acts |

### Views

`ALL BRAIN` · `HMI ONLY` · `ACTIVE` · `INPUT` · `OUTPUT`

The contrast between `ALL BRAIN` and `HMI ONLY` is the point: 865 reconstructed
cells inside a 30,346-soma population. The circuit is small, and it should look
small.

---

## 2. Reproducibility

**A configuration plus a seed determines the entire run, bit for bit.**

Two runs with the same seed produce identical decision variables, identical
latencies and identical trajectories. This is asserted in
`tests/sensorimotor.test.ts` and verified in a real browser by
`scripts/smoke-experiment.mjs`.

That property is what makes ablation a controlled experiment: any difference
between a control run and an ablated run is caused by the ablation and by
nothing else.

### Sharing

Configuration only — never model state:

```
/experiments/visual-motion?direction=right&coherence=0.70&seed=42&loop=closed
```

`COPY SHAREABLE LINK` writes that URL to the clipboard and to the address bar.

---

## 3. Open versus closed loop

| | Open | Closed |
|---|---|---|
| Retinal motion | stimulus only | stimulus − own yaw rate |
| Use | validating the circuit under fully controlled input | embodied behaviour |

In closed loop, turning toward the pattern *reduces* the evidence driving the
turn. Open and closed loop runs from the same seed diverge, which is asserted by
a test.

---

## 4. In silico ablation

**A change to the model, not a biological lesion.** Reversible, and applied to
the identical stimulus and seed so runs are comparable.

| Ablation | What it removes | Measured result |
|---|---|---|
| **Class I ipsilateral recurrence** | the 300 measured recurrent pairs | **no decision at any coherence, including 100%** |
| **Class II crossed inhibition** | the one modeled pathway | threshold coherence rises 0.4 → 0.5; right/left ratio falls 9.3 → 3.3 |
| **Left hemisphere** | one side entirely | decisions abolished **in one direction only** (20/40 trials) |
| **SPN_turning readout** | the measured descending output | `dv` exactly 0, no decision |
| **A single neuron** | one cell, by click | that cell's rate goes to 0; its neighbours continue |

The hemisphere result is the most interpretable: silencing one side removes
exactly the trials that needed that side, and leaves the others untouched.

### Suggested comparison

1. Run `coherence 0.5`, `seed 42`, closed loop. Note the latency.
2. `RESET`, ablate Class I recurrence, run again with the same seed.
3. `RESTORE`, ablate the modeled crossed inhibition, run again.

The first ablation removes measured connectivity; the second removes our one
modeled assumption. They should not have the same magnitude of effect, and they
do not.

---

## 5. Reading the timeline

Six tracks, recorded at up to 50 Hz into bounded buffers:

`STIMULUS` · `CLASS I` · `CLASS II` · `SPN TURNING` · `DECISION` · `BODY YAW`

Dashed guides on the decision track mark ±threshold. Vertical marks show
threshold crossings, drawn across every track so the causal order is visible:
**the decision variable crosses before the body yaw moves.**

Drag to scrub. Scrubbing reads recorded state and never re-runs the model.

---

## 6. Inspecting a neuron mid-run

Click any soma in the brain view.

If it is part of the reconstructed circuit, the panel shows — above a clear
divider — its measured properties: lore ID, root ID, source-voxel position,
hemisphere, morphological class with its provenance and label specificity,
neurotransmitter with its provenance, and incoming/outgoing traced contacts with
synapse counts.

Below the divider, under `MODEL STATE · SIMULATED`: current rate, model sign, and
a sparkline of recent simulated rate. **It is never called recorded calcium**,
because the Fish1 release contains no activity data for any cell.

If the soma is *not* part of the circuit, the panel says so plainly: it has a
measured position but no traced connectivity in this artefact and no state in
the model. That is "not reconstructed", not "inactive".

`ISOLATE` focuses the circuit. `ABLATE` silences that one cell in the model.

---

## 7. Result schema

`DOWNLOAD RESULT (JSON)` exports a versioned record — `schemaVersion: 1` —
containing everything needed to understand and reproduce a run:

```
experimentId, experimentType, startedAt, simulationDuration
dataset          id, version, neuronCount, edgeCount, synapseCount, citation
neuralModel      full NeuralModelProvenance, including caveats
network          node/edge counts, measured vs mirrored, E/I/unsigned edge
                 counts, build options, modeled projections, sensory interface
seed, stimulus, loopMode, ablations
decision         action, latency, confidence, decisionVariable, threshold
decisionCount
bodyOutcome      headingChangeDegrees, distanceTravelledMm, finalHeadingDegrees
provenance       per-quantity evidence classes
traceSamples
```

`decision` records the **first** decision, because a stimulus that keeps running
produces repeat turns and the first is the one comparable across runs.

---

## 8. Failure states

The application refuses rather than improvises:

| Condition | Behaviour |
|---|---|
| Circuit artefact will not load | `NEURAL MODEL UNAVAILABLE`; baseline controller still works; **nothing is substituted** |
| Manifest and circuit disagree on counts | refuses to run, `version_mismatch` |
| Populations belong to a different build | refuses to run |
| HMI cells absent from the loaded dataset | says so; does not fall back to a spatial guess |
| Renderer not yet initialised | says so instead of silently doing nothing |

There is no code path that invents an HMI neuron, and no code path that
substitutes a bounding box for a published label.

---

## 9. Reproducing the validation numbers

```bash
# dynamics, ablations, determinism, numerical sanity, step cost
node --import ./scripts/register-loader.mjs scripts/validate-neural.mjs

# chronometric and psychometric curves, 40 seeds per level
node --import ./scripts/register-loader.mjs scripts/psychometric.mjs

# parameter regime survey
node --import ./scripts/register-loader.mjs scripts/sweep-neural.mjs

# rebuild the circuit artefact from the published release
python pipeline/fish1/hmi/build_hmi.py

# unit and closed-loop tests
npx vitest run

# real-browser end-to-end, both GPU backends
node scripts/smoke-experiment.mjs http://localhost:3000
node scripts/smoke-experiment.mjs http://localhost:3000 --webgl2
```

---

## 10. What this experiment does not show

- **Recorded neural activity.** There is none in Fish1. Every rate is simulated.
- **A complete motor pathway.** The reconstruction ends at spinal projection
  neurons; the bout is executed procedurally.
- **A measured sensory pathway.** No pretectal or tectal input neurons are
  identified in this release; the input mapping is a stated convention.
- **A complete circuit.** 1,235 pairs traced from 46 seed cells, with 1,254
  contacts whose partners were never identified.
- **Two measured hemispheres.** One is mirrored.
