# Architecture

How Connectome Lab is put together, and why each boundary is where it is.

---

## 1. The governing constraint

Fish1 publishes **>180,000 segmented soma** and **~30 million synapses**. Those
two numbers determine nearly every decision here.

At that scale the ordinary React visualisation approach fails outright: 180k
components, 180k meshes, or a 30M-element object graph each cost more than the
whole frame budget. So the application is split along one hard line:

> **React owns application state and UI. The renderer owns visualised neural
> data. Nothing crosses that line except TypedArrays, integers, and callbacks.**

Nothing under `src/renderer/` imports React. `BrainRenderer` is reached through
a module-level handle (`src/state/rendererRef.ts`) rather than React state,
because it holds megabytes of GPU-backed data that must never be diffed,
cloned, or re-created by a re-render.

---

## 2. Layers

```
                    ┌─────────────────────────────┐
   browser          │  components/  (React)       │
                    │  state/       (zustand)     │
                    └──────────────┬──────────────┘
                       TypedArrays │ indices
                    ┌──────────────▼──────────────┐
                    │  renderer/   BrainRenderer  │
                    │   SomaLayer ConnectionLayer │
                    │   AxesLayer PickingSystem   │
                    │   CameraController LOD      │
                    │   backends: WebGPU | WebGL2 │
                    └─────────────────────────────┘
                    ┌─────────────────────────────┐
                    │  core/      science, format │
                    │  datasets/  adapters        │
                    │  workers/   heavy CPU work  │
                    └──────────────┬──────────────┘
   ─────────────────────────────── │ ──────────────
   server             ┌────────────▼─────────────┐
                      │  app/api/*  route handlers│
                      │  fish1/cave-client (token)│
                      └────────────┬─────────────┘
   ─────────────────────────────── │ ──────────────
   upstream                    CAVE / skeleton cache
```

`core/` is dataset-agnostic and has no I/O. `datasets/` knows about specific
resources. `renderer/` knows about neither — it takes positions and attributes.

---

## 3. Renderer

### One draw call for the whole brain

The soma population is a single interleaved vertex buffer, **16 bytes per
neuron**:

| offset | type | meaning |
|---|---|---|
| 0 | `vec3<f32>` | world position |
| 12 | `u32` | packed `cellType(8) | flags(8) | regionId(16)` |

The neuron's own index is *not* stored: shaders read it from `gl_VertexID`
(WebGL2) or `instance_index` (WebGPU). That saves 4 bytes × count and is exactly
what picking returns.

Two further lanes are separate buffers so that changing one does not re-upload
the others:

- `state` — 1 byte/neuron: visible, selected, hovered, in-circuit, circuit
  direction. Re-uploaded on filter or selection change.
- `activity` — 1 float/neuron. Zero until a functional dataset drives it; the
  lane exists now so activity playback is a buffer write, not a redesign.

At 200k neurons that is 4.58 MB resident, measured.

### Two backends, both real

WebGPU is preferred; WebGL2 is a genuine fallback that renders the same brain,
not a stub. If WebGPU is unavailable the app *downgrades*, it does not block.

They differ in one unavoidable way: WebGPU point primitives are locked to one
pixel, so soma are drawn as **instanced billboards** (6 vertices × N instances)
expanded in clip space. WebGL2 uses `gl.POINTS` with `gl_PointSize`, which is
cheaper and needs no expansion. Both produce round, depth-scaled, depth-tested
soma.

The colour palette is defined once in `backends/palette.ts` and emitted into
both GLSL and WGSL, so the DOM legend cannot drift from what the GPU draws.

### Picking

GPU ID-buffer picking. Neuron indices are rendered into an `R32UI` / `r32uint`
attachment **on demand** (not every frame) and a small neighbourhood around the
cursor is read back; the nearest non-zero hit wins, so dense regions select
predictably and single-pixel soma stay clickable.

Cost is independent of population size. There is no CPU raycast against 180,000
objects anywhere in this codebase. Hover is throttled and coalesced: identifying
the neuron (~1 ms) is deliberately separate from fetching its metadata.

### Idle-frame skipping, and why the benchmark had to work around it

A still camera over a static dataset renders nothing. This matters on laptops
and discrete GPUs, and it is why the diagnostics report **`fps (raf)`** and
**`render fps`** as separate numbers — the browser's tick rate is not the
renderer's throughput. `?bench=1` forces continuous rendering so sustained
throughput can be measured honestly.

### Level of detail

LOD here is a *scale of inquiry*, not a mesh-detail slider. Each level declares
which layers may draw, which is what keeps the promise that the whole-brain view
never attempts 30M synapses or 180k skeletons:

| Level | Soma | Connections | Synapse points | Skeletons |
|---|---|---|---|---|
| whole-brain | all | aggregate (future) | no | no |
| region | all | selected subsets | no | no |
| local-circuit | all | individual edges | yes | yes |
| single-neuron | all | individual edges | yes | yes |

Transitions are continuous — the camera keeps flying, the cloud keeps rendering.
Changing scale must never feel like navigating to another page.

---

## 4. Coordinates

Three spaces, never conflated:

1. **Source voxel** — integer voxel indices exactly as published (Fish1
   `pt_position`, 16 × 16 × 30 nm). The citable coordinate. Stored verbatim,
   **never rewritten**.
2. **Physical** — micrometres. Anisotropy removed. Distances are meaningful here.
3. **World** — physical, recentred and uniformly scaled for the camera.

The render transform is a **single scalar scale plus a translation**: uniform, so
it cannot distort morphology, and invertible, so any pixel maps back to a
citable source coordinate. Only voxel coordinates are stored in the binary;
micrometres are derived at load in exactly one place, so the two can never
disagree. Tests pin invertibility and uniformity.

Anatomical axis labels are shown **only** when the dataset documents its axis
orientation. Fish1 does not, so no dorsal/lateral labels appear — guessing would
turn a rendering convention into a false anatomical claim.

---

## 5. Binary format (`CLN1`)

One request delivers the entire population.

```
[0..4)    magic "CLN1"
[4..8)    uint32 LE  JSON descriptor length
[8..8+n)  UTF-8 JSON descriptor  (dataset, version, voxel space, lanes, regions)
padding   to the next 8-byte boundary
lanes     in descriptor order, each 8-byte aligned
```

- **Self-describing** — lanes can be added without a new decoder.
- **8-byte aligned** — every lane is a zero-copy TypedArray view over the
  response buffer; misalignment would force a multi-megabyte main-thread copy.
- **Aggressively validated** — magic, format version, lane lengths against the
  declared count, offsets within bounds, alignment, and finiteness of every
  derived position. A silently mis-decoded index would produce a brain that
  looks plausible and is wrong, which is the worst failure this app has.

At ~20 bytes/neuron, 183k soma is about 3.7 MB. Artefacts are version-addressed
(`/datasets/fish1/v574/neurons.bin`) and served `immutable`, so a new
materialization produces new URLs and old binaries stay cacheable forever.

`pipeline/fish1/neuron_index.py` writes the same format. A test shells out to
Python and decodes the result with the production TypeScript decoder — two
implementations, two languages, different endianness defaults, one contract.

---

## 6. Identifiers

The single most important correctness rule in this data model:

| ID | Behaviour |
|---|---|
| **lore ID** | Small stable integer naming a *soma*. Survives proofreading. This is what we persist, select, and share in URLs. |
| **root ID** | 64-bit ID of the *current segmentation*. **Changes** after merge/split edits. Only meaningful with a materialization version. |
| supervoxel ID | Leaf chunk of the segmentation graph. |

Root IDs exceed `Number.MAX_SAFE_INTEGER`, so they are carried as **strings**
throughout and converted to `BigInt` only where arithmetic is genuinely needed.
`readBigId()` refuses to return a value that arrived as an unsafe JSON number
rather than reporting a corrupted identifier.

`VersionedRootId` pairs a root ID with the version it was read at and whether it
was confirmed current, so the two can never be compared across materializations
by accident.

---

## 7. Data adapters

Every dataset implements `BrainDatasetAdapter` (`src/core/adapter.ts`). Optional
methods correspond to capabilities: an adapter with no skeletons omits
`getSkeleton` and reports `skeletons: false`, so the UI **disables** the control
instead of offering one that fails.

| Adapter | State |
|---|---|
| `fish1` | Live CAVE queries (token) + pipeline-exported population index. |
| `dev-sample` / `benchmark-*` | Deterministic synthetic. Badged, never real. |
| `zapbench` | Typed boundary. Not ingested. |
| `firewire` | Restricted. No data, no endpoints, by design. |

Adapters run in the browser and talk to **our** API routes. They never hold
upstream credentials.

---

## 8. Server boundary

```
browser → /api/* (our server) → CAVE
```

never

```
browser → CAVE with a secret
```

`src/datasets/fish1/cave-client.ts` reads `CAVE_TOKEN` from the environment and
**throws on import if `window` exists**, turning a leak into an immediate,
obvious failure. Endpoint templates, request bodies and the auth header are
taken from the CAVEclient reference implementation, not invented:

| Purpose | Call |
|---|---|
| datastack info | `GET {global}/info/api/v2/datastack/full/{ds}` |
| versions | `GET {local}/materialize/api/v3/datastack/{ds}/versions` |
| table query | `POST {local}/materialize/api/v3/datastack/{ds}/version/{v}/table/{t}/query` |
| root currency | `POST {local}/segmentation/api/v1/table/{pcg}/is_latest_roots` |
| skeleton | `GET {local}/skeletoncache/api/v1/{ds}/precomputed/skeleton/{sv}/{root}/swc` |

Auth is `Authorization: Bearer <token>`. Responses are requested as JSON;
CAVEclient passes that body through untyped, so `rowsFromQueryResponse()`
accepts the shapes such services emit and **throws rather than returning `[]`**
when it cannot interpret one — an unreadable response must never look like an
empty result.

Upstream responses are cached per (version, table, filters). Materialized tables
are immutable for a given version, so repeating a query is pure waste, and CAVE
is a shared community resource we should not hammer.

---

## 9. Connectivity strategy

**~30 million synapses are never shipped to the browser.**

- The server aggregates synapse rows into **one entry per partner**, not per
  synapse.
- Partners are **ranked by synapse count, then capped**, so a truncated result
  keeps the meaningful partners rather than an arbitrary slice.
- Truncation is reported (`truncated`, `truncationReason`) and surfaced in the
  inspector. Totals that reflect a capped set say so.
- Edges are drawn only for the current selection, as straight soma-to-soma
  segments with opacity on a √ scale (linear scaling makes everything but the
  strongest partner invisible) and direction encoded by an end-fade.

Straight segments are an abstraction, not anatomy — the real axon takes a path
through the neuropil that only the skeleton layer can show. The UI says so.

Multi-hop traversal (`src/core/traversal.ts`) is bounded by depth,
partners-per-hop, and total nodes. Hitting a cap sets `truncated` with a reason;
it never silently returns a partial result that looks complete. The traversal
lives in `core/` rather than inside the worker precisely so these limits are
directly testable.

---

## 10. Workers

Used where the work is genuinely heavy:

- **`population.worker.ts`** — synthetic generation. Placing 200k neurons costs
  two Box–Muller draws each and would drop frames inline. Returns the same
  binary container as a real export, so there is exactly one loader.
- **`graph.worker.ts`** — multi-hop traversal, which can freeze a tab.

Filtering deliberately stays on the main thread: a full pass over 200k neurons
is a few hundred microseconds (measured and displayed in the filter panel), so a
worker would add message latency and a buffer copy for no benefit.

`SharedArrayBuffer` is not used. It would require cross-origin isolation
headers, which is real deployment complexity, and nothing here currently needs
concurrent writes to one buffer.

---

## 11. State

| Concern | Owner |
|---|---|
| UI state | `brainStore` — selection, filters, panels, display modes |
| Data cache | `brainStore` — metadata, fetched neurons, connectivity |
| Render state | `BrainRenderer` — **not** the store |
| Simulation | future dedicated subsystem |

The one large object in the store is the `NeuronIndex`, held as an opaque
reference; components select scalars from it, so a 200k population causes no
React work.

Async results are guarded by monotonic tokens (`selectionToken`, etc.) so a slow
response for a neuron the user has already moved past cannot overwrite current
state.

**`syncRendererWithState()`** exists because the renderer is created
asynchronously (WebGPU adapter + device) while dataset loading runs on its own
timeline. Whichever finishes first must not lose. This was a real bug the
benchmark caught: with fast-loading small populations the data won the race,
`rendererRef.current` was still `null`, and the population was silently never
uploaded.

---

## 12. Future seams

These exist as types now so the later work is implementation, not redesign.

**Activity** (`core/activity.ts`) — `ActivitySource` yields `ActivityWindow`s
laid out row-major `[frame][neuron]`, so advancing playback is one contiguous
buffer write to the GPU activity lane, not 70,000 React updates. Runtime modes
`recorded` / `predicted` / `simulated` each carry their provenance and a distinct
badge, and must never be visually confused.

`CellCorrespondence` makes "the same neuron" an explicit, auditable claim with a
`sameAnimal` flag — which is why ZAPBench traces will not be painted onto Fish1
soma.

**Simulation** (`simulation/types.ts`) — `SparseConnectivity` is CSR with
separate `weights` and `signs` (so an unknown-polarity edge is distinguishable
from a zero-weight one), kept in both orientations because forward propagation
and input aggregation read opposite directions. The pipeline already emits this
shape (`export_connectivity.py` → `.npz`).

The neuron model is deliberately **not** chosen. Fixing that before connectivity
is correctly represented would be premature. What is fixed is the pipeline
shape — stimulus → sensory population → kernel → network state → readouts →
motor output — and that every output is labelled `SIMULATED`.

**Inference** (`core/inference.ts`) — types only. An `InferredState` must carry
its evidence, its model, and a `caveat`. There is no field for a natural-language
"thought", and a test asserts the state vocabulary contains no emotion words.

Graph traversal depth is **not** biological time. If a future view animates
propagation by hop, it is a depth counter, and it will be labelled as one unless
an explicit model produces the timing.
