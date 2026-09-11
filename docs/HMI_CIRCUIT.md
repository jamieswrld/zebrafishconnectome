# The Fish1 hindbrain motion integrator

What the reconstructed circuit actually contains, where its labels come from,
and exactly where the measured data stops.

---

## 1. Biological background

Larval zebrafish turn in the direction of whole-field visual motion — the
optomotor response. That behaviour is not a reflex triggered the instant motion
appears: the animal accumulates evidence over hundreds of milliseconds, and weak
or conflicting motion produces slower and less reliable turns. A circuit that
does this needs three things:

1. **Integration** — something that holds and accumulates a signal for longer
   than a membrane time constant. Recurrent excitation within a population is
   the standard substrate.
2. **Competition** — the two directions must be mutually exclusive at the
   output, which in a bilaterally symmetric animal means the two hemispheres
   must inhibit each other.
3. **A threshold** — a point at which accumulated evidence becomes a committed
   action.

The hindbrain motion integrator (HMI) is the region the Fish1 release
reconstructs in this context.

---

## 2. What the release actually publishes

Source: `HMI_analysis.zip` from
<https://fish1-release.storage.googleapis.com/paper_data/HMI_analysis.zip>.
No credentials required.

The circuit lives in `data/em_zfish1_dataframe.xlsx`: **999 manually
reconstructed cells**, each with

| Column | What it is | Provenance |
|---|---|---|
| `Cell ID` | stable lore id | measured |
| `classifier` | morphological class | **predicted from morphology** |
| `final_neurotransmitter_ID` | VGluT2 / Gad1b / unlabeled / unclear / n/a | measured where present |
| `network_level` | which tracing round found the cell | structural provenance |
| `reconstruction_status` | what was reconstructed for the cell | measured |
| `inputs` / `outputs` | per-synapse contact lists with EM coordinates | measured |

Soma positions come from the companion CAVE cache
`data/cave_somas_in_big_box.csv` (30,346 soma).

`pipeline/fish1/hmi/build_hmi.py` turns these into
`public/datasets/fish1-hmi/v1/hmi.bin` (HMI1 container) and
`populations.json`.

### What survives into our artefact

| Quantity | Value |
|---|---|
| Reconstructed cells | 999 |
| …with a soma position | **865** (134 have none and are reported, not guessed at) |
| Traced directed pairs | **1,235** |
| Synaptic contacts | **1,568** |
| Cells with any traced contacts | **46** |
| Traced contacts whose partner was never identified | 1,254 (excluded, counted) |
| Contacts dropped because a partner had no soma | 187 |

---

## 3. Cell classes

We keep the release's own vocabulary rather than translating it. The compact
labels follow `HMI_analysis/src/zfish/labels.py` exactly, so our labels cannot
drift from theirs.

| Our label | Source `classifier` | Count | Notes |
|---|---|---|---|
| `I` | `'1'` | 246 | Ipsilaterally projecting |
| `II` | `'2'` (`'contralateral axon'`) | 246 | Axon crosses the midline |
| `I_or_II` | `'1 or 2'` | 82 | **The release itself is undecided.** We keep the hedge |
| `L-2` | `'L-2'` | 30 | Predominantly contralateral, 90% Gad1b |
| `R` | `'4'` | 83 | |
| `P` | `'5'`, `'6'`, `'5 or 6'` | 79 | |
| `F` | `'7'` | 1 | |
| `SPN_turning` | `spn_turning_*` | 28 | Descending spinal projection, turning |
| `SPN_forward` | `spn_forward_*` | 19 | Descending spinal projection, forward |
| `other` | `'other'` | 48 | The release's own catch-all |
| `unclassified` | absent | 3 | |

**Every one of these is a morphological prediction, not a functional
recording.** No cell in this release carries a functionally measured class, and
the application never displays one as if it did.

### Neurotransmitter coverage

| | Cells |
|---|---|
| Excitatory (VGluT2) | 80 |
| Inhibitory (Gad1b) | 143 |
| **Unknown** | **642** |

74% of placed cells have no published neurotransmitter. This is the single most
important limitation of the model, and
[NEURAL_RUNTIME.md](./NEURAL_RUNTIME.md#4-the-unknown-sign-problem) explains
what we do about it. We never turn "unknown" into "excitatory".

Class-level purity, where labelled:

| Class | Labelled | Majority | Purity |
|---|---|---|---|
| `II` | 77 | inhibitory | **92%** |
| `L-2` | 29 | inhibitory | 90% |
| `F` | 13 | excitatory | 92% |
| `R` | 9 | inhibitory | 78% |
| `I` | 86 | excitatory | **63%** — genuinely mixed |

Class I being only 63% pure is a real finding, and it is why Class I is never
imputed even under the permissive sign policy.

---

## 4. Terminology: how this relates to the CLEM papers

This matters, and it is easy to get wrong.

The functional-connectomics work on evidence accumulation
([Zebrafish_CLEM](https://github.com/jboulanger91/Zebrafish_CLEM), MIT-licensed
code) uses **functional** class names derived from calcium imaging:

- **iMI** — ipsilateral motion integrators
- **cMI** — contralateral motion integrators
- **MON** — motion onset neurons
- **sMI** — slow motion integrators
- **DT** — dynamic threshold cells

The Fish1 HMI release uses **morphological** class names: `1`, `2`, `L-2`,
`4`, `5/6`, `7`, `spn_*`.

**These are different labelling systems applied to different datasets, and this
project does not assert a mapping between them.** Concretely:

- We do **not** claim Class I ≡ iMI.
- We do **not** claim Class II ≡ cMI.

What we do use is what the morphology itself states, which is measured:

- Class II is labelled `'contralateral axon'`, so its axon crosses the midline.
- Class II is 92% Gad1b where labelled, so the population is inhibitory.

Those two measured facts are what justify the single modeled projection in the
network. They are claims about *this* reconstruction, not an import of another
paper's functional taxonomy.

One connection does exist in the data: the release's `network_level` column
contains `dt_seed`, `putative_dt` and `dt_147009_input_one` labels on a handful
of cells, which echo the CLEM "dynamic threshold" vocabulary. That is suggestive
of correspondence for those specific cells. It is not a general mapping, and we
do not treat it as one.

---

## 5. The measured pathway

This is the central result of the Phase 3 data work. Counting directed pairs by
the classes at each end of every traced contact:

| Pathway | Pairs | What it is |
|---|---:|---|
| traced input layer → `I` | 100 | sensory entry |
| `I` → `I` | **300** | recurrent integration — **all 300 within one hemisphere** |
| `I` → `II` | 378 | drives the crossing population |
| `I` → `SPN_turning` | 40 | **descending motor output**, onto 28/28 cells, 46/47 ipsilateral |
| `I` → `SPN_forward` | 17 | forward swim output |
| `II` → anything | **0** | **never traced** |

So the reconstruction contains a complete chain from a structurally identified
input layer, through recurrent ipsilateral integration, to descending spinal
projection neurons — with exactly one link missing.

### The missing link

Class II has **zero** traced outgoing contacts. This is not a claim that Class
II has no partners; outputs were traced from only 46 seed cells, and no Class II
cell was among them. Without that link there is no interhemispheric competition,
and therefore no decision.

The model adds it back as a **population-level term**, never as fabricated
synapses — see
[NEURAL_RUNTIME.md](./NEURAL_RUNTIME.md#5-the-one-modeled-pathway). It is
individually ablatable, and running with it disabled is the honest way to see
how much of the behaviour depends on it.

---

## 6. Hemisphere and the midline

Hemisphere is **derived**, not measured. `y` is the mediolateral axis, and the
midline sits at **y = 33,250 voxels**.

Both claims were established empirically rather than assumed. Of the three
source axes, only `y` makes the 30,346-soma distribution reflection-symmetric:

| Axis | Best mirror correlation |
|---|---|
| **y** | **0.878** |
| x | 0.602 |
| z | 0.449 |

The fitted centre (33,250) agrees with the geometric centre of the published
volume (65,000 / 2 = 32,500) to 750 voxels = **6 µm**, which is about the
resolution such a claim deserves.

### The reconstruction is 94% unilateral

815 of 865 placed cells lie on one side of that midline. A decision circuit
needs two hemispheres, so the model mirrors every measured cell through the
midline and duplicates every measured edge between the twins. **Mirror cells are
a construction of ours and are flagged as derived everywhere** — they are never
drawn on the measured anatomy and never described as measured cells.

---

## 7. Limitations

- The classifier is a **morphological prediction**. No functional identification
  exists for any cell here.
- **74% of cells have no neurotransmitter label.** Under the default strict
  policy they contribute no signed drive at all.
- The graph is **seeded and star-like**: 1,235 pairs traced from 46 cells, not a
  dense wiring diagram. 1,254 traced contacts had unidentifiable partners.
- Class II, the population the decision depends on, has **no traced outputs**.
- The opposite hemisphere is **mirrored**, not measured.
- 134 reconstructed cells have no soma position and are absent from the model.
- There is **no activity data of any kind** in this release. Every rate the
  application shows is simulated.
- Spinal projection neurons are where the reconstruction ends. The spinal
  pattern generator and the musculature are not reconstructed, so movement is
  executed by a procedural body model.

---

## 8. Citation

> Petkova, M. D., Januszewski, M., et al. (2025). *A connectomic resource for
> neural cataloguing and circuit dissection of the larval zebrafish brain.*
> bioRxiv.

Related functional work and model architecture:

> Boulanger-Weill, J., et al. *Correlative light and electron microscopy reveals
> the fine circuit structure underlying evidence accumulation in larval
> zebrafish.* Code: <https://github.com/jboulanger91/Zebrafish_CLEM> (MIT).

Data licensing is separate from code licensing; see
[DATA_SOURCES.md](./DATA_SOURCES.md).
