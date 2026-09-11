# Data sources

What each dataset actually contains, what this application currently uses, and
what it does not claim.

**This application does not own, host, or redistribute any third-party dataset.**
It queries upstream services with the operator's own credentials, and stores
derived artefacts locally (gitignored).

---

## Fish1 — structural connectome · **used**

A correlated light and electron microscopy (CLEM) dataset from a **7 dpf larval
zebrafish**, covering the brain and anterior spinal cord.

| | |
|---|---|
| Published soma | >180,000 segmented |
| Published synapses | ~30 million |
| Molecularly annotated | >40,000 neurons |
| Modality | **Structural only** |
| Access | Open, token required, citation required |
| Release | <https://fish1-release.storage.googleapis.com/index.html> |
| Paper | <https://www.biorxiv.org/content/10.1101/2025.06.10.658982v1> |

### What it contains

Excitatory and inhibitory identity from **genetic labelling**: `vglut2a+` →
excitatory, `gad1b+` → inhibitory. A cell typed `na` was simply **not
annotated** — that is not a claim it is neither. This distinction is preserved
end to end: `mapFish1CellType()` maps `na` → `unknown`, and the filter panel
says so.

### What it does NOT contain

No neural activity. No behaviour. No stimulus responses. No internal states.
Any activity displayed alongside Fish1 must come from a different dataset and be
labelled as such.

### Access

| | |
|---|---|
| Global / auth | `https://global.brain-wire-test.org/` |
| Local (chunked graph, skeletons) | `https://pcgv3local.brain-wire-test.org` |
| Datastack | `fish1_full` |
| Segmentation table | `fish1_v250915` |
| Tokens | `{global}/sticky_auth/settings/tokens` |

### Tables used

| Table | Contents |
|---|---|
| `somas` | One row per soma: `id` (lore ID), `cell_type`, `pt_root_id`, `pt_supervoxel_id`, `pt_position` |
| `synapses_axde_label` | Axon→dendrite synapses: pre/post root IDs, positions, `tag` |
| `synapses_axon_to_dendrite_size` | Per-synapse bounding boxes, for size filtering |

Also published, not yet used: `synapses_axax`, `synapses_axde`,
`synapses_axde_pre_synapse_id`, `synapses_axde_post_synapse_id`,
`nucleus_table`, `somas_distance_to_landmark`, `dbcells_dump`.

`synapses_axde_label.tag` is a **string**: `'1'` = inhibitory, `'2'` =
excitatory.

### Coordinates

`pt_position` is in voxels at **16 × 16 × 30 nm**.

> **Documented inconsistency, recorded deliberately.** The official notebook's
> `get_latest_root_id()` helper defaults to `resolution=(8, 8, 30)` for
> CloudVolume point lookups — the segmentation's own mip-0 grid — while the
> `somas` table column reference states 16 × 16 × 30 nm for `pt_position`. We
> use the soma-table value and keep it in exactly one place
> (`FISH1_VOXEL_SPACE`) so a correction upstream is a one-line change rather
> than a reprocessing job.

Axis orientation is **not** documented by the release, so this application shows
no anterior/dorsal/lateral labels for Fish1. Camera presets are named by axis
(`+X`, `-Z`, …). Inferring anatomy from a rendering convention would be an
unsupported claim.

### What this application uses today

| Capability | Status |
|---|---|
| Neuron metadata by lore ID | live CAVE query |
| Root ID currency check | live, opt-in (`?checkLatestRoot=1`) |
| Connectivity (aggregated per partner) | live CAVE query |
| Skeletons (SWC) | live skeleton cache |
| Search by lore ID / root ID | live |
| Downloads (JSON / CSV / SWC) | live |
| Whole-brain soma index | **pipeline export required** |
| Region assignment | not exported — see below |
| Synapse positions | supported by the API, not yet drawn |

Regions are **not** exported. Fish1 does not publish a region assignment for
every soma, and deriving one from position alone would be an invented
anatomical claim. The neuron index marks every cell `0xFFFF` (unassigned), and
the region system exists ready for real annotations.

### Licence and citation

Open access. Independent publication is encouraged and co-authorship is not
required, but **citation is mandatory**:

> Petkova, M. D., Januszewski, M., et al. (2025). *A connectomic resource for
> neural cataloguing and circuit dissection of the larval zebrafish brain.*
> bioRxiv.

Every artefact this application exports — JSON, CSV, SWC — carries that citation
in its header, so a file that leaves here stays attributable.

Proofreading edits are publicly logged and attributed via CAVE. Users are asked
to review reconstruction history, coordinate overlapping efforts, and
acknowledge significant proofreading contributions by others.

---

## ZAPBench — functional recordings · **not ingested**

The Zebrafish Activity Prediction Benchmark: 4D light-sheet recordings of **over
70,000 neurons** in a larval zebrafish brain under a range of visual stimuli,
with motion stabilisation and voxel-level cell segmentation. Published by Google
Research with HHMI Janelia and Harvard as a forecasting benchmark.

| | |
|---|---|
| Paper | <https://arxiv.org/abs/2503.02618> |
| Code | <https://github.com/google-research/zapbench> |
| Modality | **Functional only** |
| Status here | Typed adapter boundary. No data fetched. |

> ### ZAPBench and Fish1 are different animals.
>
> There is **no cell-level correspondence** between them. This application must
> never paint ZAPBench traces onto Fish1 soma. Any future mapping has to arrive
> as an explicit `CellCorrespondence` with `sameAnimal: false`, carrying its own
> provenance and method, and the UI has to present it as a *registration*, not
> an identity.

The adapter reports no capabilities and an `unavailable` reason rather than
pretending to have data. Frame counts, volume rate and the exact stimulus
condition list are intentionally **not** hardcoded here — they will be read from
the dataset's own metadata at ingestion time rather than transcribed from
memory.

---

## Fish Fire&Wire — connectivity + activity, same animal · **restricted**

Scientifically the most valuable dataset for this project: connectivity and
neural activity measured from the **same individual animal**, aligned at
single-cell resolution. That removes the correspondence problem which keeps
Fish1 and ZAPBench apart, and it is what a genuine stimulus → activity →
circuit → behaviour story eventually needs.

It is also not ours to take.

**Status: no authorisation. This repository contains none of that data,
downloads none of it, caches none of it, and contains no endpoints, bucket
paths, or credentials for it.** `src/datasets/firewire/adapter.ts` is a typed
boundary and nothing more — deliberately, so that anyone reading the codebase
sees the access status stated plainly instead of discovering a half-finished
scraper.

To enable it, an authorised collaborator must implement that adapter against
whatever access route their authorisation actually grants.

---

## Development sample & synthetic benchmark · **generated**

Deterministic procedurally-generated populations, shaped like a larval zebrafish
brain (telencephalon, habenula, pretectum, thalamus, optic tectum, tegmentum,
cerebellum, hindbrain, anterior spinal cord; bilateral where appropriate).

**These contain no biological measurements.** The shape exists only so that
rendering, culling, depth sorting and LOD are exercised under a realistic
spatial distribution — a uniform cube would hide exactly the density problems
worth measuring. Proportions are eyeballed from published larval atlases to get
plausible spatial statistics; they are **not registered to any atlas** and carry
no anatomical authority. Regions are labelled "(synthetic)" and their assignment
provenance is `derived`, with the method recorded as generator ground truth.

Positions are generated in the same 16 × 16 × 30 nm voxel grid as Fish1 and
written through the same binary encoder, so the format, transforms and loader
are exercised identically for real and synthetic data. Position provenance is
`simulated` — generated data is never labelled `measured`.

Determinism matters: the same seed and count produce byte-identical output, so a
benchmark number is reproducible and a regression is real. Tests assert this.

Everywhere one of these is loaded, the viewport shows `DEVELOPMENT SAMPLE` or
`SYNTHETIC BENCHMARK` plus `NOT BIOLOGICAL DATA`, and the status bar repeats it.

---

## Summary

| Dataset | Structural | Functional | Same animal as Fish1 | Used here |
|---|---|---|---|---|
| Fish1 | ✅ | ❌ | — | ✅ per-neuron live; population via pipeline |
| ZAPBench | ❌ | ✅ | ❌ **different animal** | ❌ boundary only |
| Fire&Wire | ✅ | ✅ | n/a | ❌ **restricted, no access** |
| Dev sample / benchmark | generated | ❌ | ❌ not biology | ✅ default |

---

## What this application does not claim

No dataset here records what a fish feels, wants, or is thinking about. There is
no API anywhere that returns a fear score or a thought, and this application will
not synthesise one.

Terms such as *escape response*, *startle*, or *locomotor drive* describe
**circuit and behavioural states** with established usage in the larval zebrafish
literature. If they appear, they will be labelled `INFERRED`, carry the evidence
and model that produced them, state what they do not establish, and never be
presented as measurements.

Graph distance is not time. Animating propagation by traversal depth shows hop
count, not milliseconds of neural conduction, unless an explicit simulation
produces the timing.
