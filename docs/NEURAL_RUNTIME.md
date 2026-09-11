# The neural runtime

The model that turns a measured connectome into simulated activity, and the
exact list of things it assumes.

**Category: `CONNECTOME_CONSTRAINED_MODEL`.** The connectivity, its sign and its
synapse counts are measured. The dynamics are ours. Nothing here is a recording.

---

## 1. Why a rate model

The measured data constrains connectivity, sign and synapse count, and nothing
else. There are no membrane recordings, no synaptic conductances, no reversal
potentials and no time constants anywhere in the Fish1 release.

A conductance-based or spiking model would require inventing far more parameters
than the data can support, and every one of them would be a free knob that could
be tuned until the demo worked. A firing-rate network requires the fewest
invented quantities, so that is what this is.

### Equations

For every node `i`:

```
tau dx_i/dt = -x_i + sum_j W_ij r_j + P_i + I_i + sigma xi_i
r_i          = clamp(x_i, 0, 1)
```

| Term | Meaning | Provenance |
|---|---|---|
| `W_ij` | measured synaptic weight, signed by the presynaptic cell's transmitter | **measured** |
| `P_i` | modeled population projections (§5) | inferred |
| `I_i` | sensory drive into the traced input layer | simulated |
| `xi_i` | seeded Gaussian noise | simulated |

`r = clamp(x, 0, 1)` is what makes NaN and Inf structurally impossible: the
output is bounded regardless of the weights, and a test asserts it across
extreme inputs.

### Parameters

| Parameter | Value | Where it comes from |
|---|---|---|
| `TAU_SECONDS` | 0.1 s | membrane-like; not fitted |
| `NEURAL_DT` | 0.005 s (200 Hz) | `tau/dt = 20`, comfortably stable for forward Euler |
| `synapticGain` | 0.9 | the one free scalar, see §3 |
| `NOISE_SIGMA` | 0.25 | set so ambiguous evidence is stochastic rather than a frozen tie |
| `SENSORY_GAIN` | 0.55 | input scaling |
| `DECISION_THRESHOLD` | 0.15 | speed–accuracy tradeoff, see §7 |
| `DECISION_REFRACTORY_SECONDS` | 1.2 | minimum interval between decisions |

The neural step is fixed and decoupled from the render loop entirely, so a slow
frame cannot change a result. The accumulator is clamped at 0.25 s so a stalled
tab cannot trigger a thousand catch-up steps.

---

## 2. Sparse representation

Incoming CSR, because the inner loop aggregates over presynaptic partners:

```
inOffsets   Uint32Array[nodeCount + 1]
inSources   Uint32Array[edgeCount]
inWeights   Float32Array[edgeCount]
```

Outgoing CSR is kept as well, for flow-style visualisation, which pushes forward
from active cells. No dense `N×N` matrix is ever materialised, and no per-edge
object exists.

State is four flat typed arrays (`x`, `r`, `drive`, plus masks) allocated once
and reused for the life of the runtime. Nothing per-neuron ever reaches React.

### Weighting

**`w = log1p(synapse count)`, then normalised per postsynaptic neuron.**

A synapse count is a *structural proxy*, not a physiological synaptic weight.
Which monotone function you choose changes the dynamics, so the choice is named
(`WeightScheme`: `log1p` | `linear` | `binary`), selectable, and recorded in
every exported result rather than buried.

Row normalisation means no neuron is driven harder simply because more of its
partners happened to be traced — which matters a great deal in a graph seeded
from 46 cells, where one cell has 83 traced outputs and most have none. Relative
synapse counts *within* a row are preserved, which is the meaningful part.

---

## 3. Stability, and where integration comes from

Because incoming weights are normalised per node, the weight matrix has an
infinity-norm of at most 1. Its spectral radius is therefore at most 1, and any
`synapticGain < 1` is **provably stable** — the model cannot diverge regardless
of what the graph looks like. A test asserts the row-sum bound directly.

Integration is **not** imposed by a long time constant. `tau` is 100 ms. The
slow accumulation comes from the measured recurrent Class I → Class I
connectivity — 300 traced pairs, every one within a single hemisphere. The
effective integration time constant is

```
tau_eff = tau / (1 - gain) = 0.1 / 0.1 = 1.0 s
```

`synapticGain` is the only parameter of the dynamics not read from the data. Its
job is to put the network in an integrating rather than a saturating regime.

**The evidence that the measured recurrence is doing the work:** ablating
Class I ipsilateral recurrence abolishes the decision at *every* coherence
level, including 100%. Sweeping the gain shows the same thing from the other
direction — at `gain = 0` the circuit produces no differential signal at all.

---

## 4. The unknown-sign problem

74% of placed cells have no published neurotransmitter. Calling them all
excitatory because the model needs a sign would be the single easiest way to
fabricate a result, so the policy is explicit, selectable, and reported with
every run.

| Policy | Behaviour |
|---|---|
| **`strict`** (default) | Only cells with a **measured** transmitter contribute signed drive. Unlabelled cells are present in the graph and contribute **zero**. |
| `class-imputed` | An unlabelled cell inherits its class majority transmitter, but only if the class has ≥5 labelled members and ≥70% purity. Its weight is scaled by the class purity, so a 70%-pure guess carries 70% of the weight. |
| `sensitivity` | Runs both and reports whether the outcome differs. |

Strict is the default because it adds no assumption, and it is viable here: only
**17% of edges** have an unknown-sign presynaptic cell. Under strict the network
has 1,858 excitatory, 196 inhibitory and 416 unsigned edges.

Note that Class I is only 63% pure, so it is never imputed even under
`class-imputed`. Sign is applied under **Dale's law** — it is a property of the
presynaptic *cell*, not of the edge — and a test asserts that every edge out of
a neuron shares its sign.

---

## 5. The one modeled pathway

Class II has zero traced outgoing contacts (see
[HMI_CIRCUIT.md §5](./HMI_CIRCUIT.md#5-the-measured-pathway)), so the measured
graph has no interhemispheric competition and cannot decide anything.

**`modeled-classII-crossed-inhibition`** adds it back:

> Class II on one side inhibits Class I on the other.

Justified entirely by measured facts:

1. The published classifier for Class II is `'contralateral axon'` — the axon
   crosses the midline (**measured morphology**).
2. 92% of labelled Class II cells are Gad1b — the population is inhibitory
   (**measured molecular identity**, 77 labelled cells).
3. Class I drives Class II with 378 measured contacts, so the population is
   driven by the ipsilateral integrator (**measured connectivity**).

Those facts justify the pathway's **existence, direction and sign**. They do not
establish *which individual cells* connect to which.

**So it is implemented as a population-level term, not as edges.** This is a
deliberate design decision, not a shortcut: fabricated per-neuron edges would
render as lines between two real neurons and be indistinguishable from measured
connectivity on screen. A population term cannot be mistaken for a synapse
because it never becomes one.

It is individually ablatable and is listed with its justification and evidence
in the UI whenever it is active.

### Bilateral completion

The reconstruction is 94% unilateral, so every measured cell is given a mirror
twin reflected through the fitted midline, and every measured edge is duplicated
between the twins. The result is 1,730 nodes and 2,470 edges, exactly
bilaterally symmetric — which is also what makes "symmetric input produces no
directional bias" a meaningful test rather than a coincidence.

Mirror nodes carry a `mirrored` flag, are provenance-tagged **derived**, and are
never painted onto the measured anatomy.

---

## 6. Determinism

Given the same seed, network and stimulus, two runs are **bit-identical**. This
is what makes an ablation comparison a controlled experiment rather than an
anecdote: any difference between a control run and an ablated run is caused by
the ablation and nothing else.

Noise uses a seeded Box–Muller generator with the spare half of each pair cached
— the inner loop draws one sample per node per step, 6,920 per behaviour tick,
and halving that cost is the largest single saving in the model.

---

## 7. Decision readout and threshold

The decision variable is

```
dv = mean rate of right SPN_turning - mean rate of left SPN_turning
```

i.e. a difference between the **measured descending output populations**. When
`|dv|` crosses the threshold, a `NeuralMotorIntent` is emitted.

A threshold is a free parameter of *any* decision model — it is the
speed–accuracy tradeoff, and no connectome can supply it. It was chosen against
a stated criterion: decisions should land in the few-hundred-millisecond range
over which larval zebrafish actually make optomotor turns, and weak evidence
should stay undecided rather than forcing a guess.

Measured over 40 seeds per level (`scripts/psychometric.mjs`):

| Coherence | Median latency | Decided | Correct |
|---|---|---|---|
| 1.00 | 0.275 s | 40/40 | 100% |
| 0.70 | 0.355 s | 40/40 | 100% |
| 0.50 | 0.495 s | 40/40 | 100% |
| 0.40 | 0.675 s | 40/40 | 100% |
| 0.30 | — | 0/40 | — |
| 0.00 | — | 0/40 | — |

**Latency falling monotonically with evidence strength is a property of the
model.** Nothing in the code consults coherence when deciding when to fire.

After a decision the accumulation epoch restarts, so a stimulus that keeps
running produces repeat turns with meaningful inter-decision times rather than
an ever-growing "latency".

---

## 8. Ablation

`IN SILICO ABLATION` — a change to the model, never a biological lesion, and
always reversible.

| Target | Effect |
|---|---|
| `neuron` | silences one node |
| `class` (optionally one side) | silences a population |
| `hemisphere` | silences one side entirely |
| `projection` | removes a modeled pathway |
| `recurrence` | removes same-class, same-side connections |

Implemented as flat `nodeMask` / `edgeMask` arrays rebuilt only when the
ablation set changes, so the inner loop never branches on ablation logic.

Validated results (40 seeds per level):

| Ablation | Result |
|---|---|
| Class I ipsilateral recurrence | **No decision at any coherence, including 100%** |
| Left hemisphere silenced | Decisions abolished **in one direction only** (20/40 — exactly the trials needing the silenced side) |
| Modeled crossed inhibition | Threshold coherence rises from 0.4 to 0.5; right/left ratio falls from 9.3 to 3.3 |
| `SPN_turning` readout silenced | `dv` is exactly 0; no decision |

---

## 9. Cost

Measured headless (`scripts/validate-neural.mjs`), 1,730 nodes and 2,470 edges:

- **0.276 ms** per 20 ms behaviour tick (4 neural steps)
- **73× real time**
- In the browser the reported neural step time is **1.0–1.5 ms** per UI frame

The model is cheap because the HMI is small relative to the whole connectome —
which is the point of simulating a reconstructed circuit rather than a guess at
a whole brain.

---

## 10. Model provenance

Every run carries a `NeuralModelProvenance` record, exported with the result:

```
category              connectome_constrained_model
connectivityMeasured  true
activityMeasured      false
weightsSource         synapse counts, log1p, row-normalised
dynamicsSource        chosen by this project, not fitted to any recording
```

### Why not the published CLEM model

The [Zebrafish_CLEM](https://github.com/jboulanger91/Zebrafish_CLEM) repository
(MIT) contains a biologically constrained RNN trained to reproduce
population-averaged calcium dynamics under Dale's law and anatomical sparsity.
We inspected it before writing ours. It was not adopted because:

1. **No checkpoints are published in the repository.** The README points
   `PATH_MODELS` at an external directory.
2. **Its weights are fit to a different dataset** — a different animal's cells
   and traces. There is no cell-level correspondence to the Fish1 HMI
   reconstruction, so transplanting a fitted weight matrix onto Fish1's measured
   graph would be scientifically incoherent, not a reuse.

So we implemented the simplest defensible connectome-constrained model on the
measured graph, and label it as ours.
