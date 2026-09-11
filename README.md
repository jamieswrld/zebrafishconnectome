# Connectome Lab

An explorable digital zebrafish nervous system — now with a body, a world, and
a closed sensorimotor loop.

**Live:** <https://zebrafishconnectome.vercel.app> ·
[real neuron 186187](https://zebrafishconnectome.vercel.app/brain?neuron=186187) ·
[200k benchmark](https://zebrafishconnectome.vercel.app/brain?dataset=benchmark-200000&debug=1)

A whole-brain connectome viewer built on **Fish1**, the larval zebrafish CLEM
resource from Petkova, Januszewski et al. (2025). The entire soma population
renders as one GPU draw call, individual neurons are picked on the GPU, and
connectivity is fetched per-neuron on demand rather than dumped into the
browser.

The long-term goal is a nervous system you can actually interrogate: whole brain
→ region → circuit → neuron → synapse, and stimulus → activity → circuit
propagation → motor response, without leaving the application. This repository
is the foundation for that, built so the later parts can genuinely exist.

---

## Scientific provenance: the core rule

Every number in this application carries an epistemic class, and the UI never
lets those classes blur together:

| Class       | Meaning                                             |
| ----------- | --------------------------------------------------- |
| `measured`  | Directly observed in the source dataset.            |
| `derived`   | Deterministically computed from measured data.      |
| `predicted` | Output of a forecasting model. Not an observation.  |
| `simulated` | Output of a computational model of the connectome.  |
| `inferred`  | Our interpretation of a pattern. The weakest claim. |

Two consequences that shape the whole codebase:

- **Synthetic data is never disguised as real.** When the viewport is showing a
  generated population it says `DEVELOPMENT SAMPLE` / `SYNTHETIC BENCHMARK` and
  `NOT BIOLOGICAL DATA`, in the viewport, not a footnote.
- **A failed query is never rendered as a zero.** "This neuron has no partners"
  and "the connectivity query failed" are different states with different UI.
  See `src/core/errors.ts`.

Fish1 is a **structural** dataset. It contains no neural activity, no behaviour,
and nothing resembling an internal state. This application will never claim
otherwise. Terms like "escape response" describe circuit and behavioural states;
if they ever appear they will be labelled `INFERRED`, carry the evidence they
were computed from, and there is deliberately no field anywhere for a "thought".

---

## Quick start

```bash
npm install
npm run dev            # http://localhost:3000
```

Out of the box you get **real Fish1 data** — no credentials, no setup. The
default dataset is built from the circuit-analysis packages published with the
resource paper: 30,346 soma with stable lore IDs, molecular cell types, 64-bit
root IDs and source voxel coordinates, plus 13,813 measured synaptic edges.

```
/                                       intro
/brain                                  explorer (real Fish1, published export)
/brain?view=organism                    the same connectome inside a larval body
/world                                  the organism swimming in a simulated tank
/brain?neuron=186187                    deep-link to a real, well-connected neuron
/brain?dataset=fish1                    whole-brain Fish1 (needs a CAVE token)
/brain?dataset=dev-sample               synthetic stand-in, badged as such
/brain?dataset=benchmark-200000         200k synthetic soma
/brain?debug=1                          diagnostics panel
/data                                   datasets, provenance, live access status
```

### Controls

| Input                    | Action                               |
| ------------------------ | ------------------------------------ |
| drag                     | orbit                                |
| shift-drag / middle-drag | pan                                  |
| wheel / pinch            | zoom                                 |
| click                    | select neuron                        |
| `/` or `Ctrl`/`Cmd`+`K`  | search by identifier                 |
| `F`                      | focus selected · `R` reset camera    |
| `[` `]`                  | toggle panels · `\` distraction-free |
| `Esc`                    | clear selection                      |

---

## Phase 2: embodiment

The connectome now sits inside an anatomically proportioned larval zebrafish,
and that organism swims in a tank under a real closed loop:

```
WORLD → SENSORS → CONTROLLER → MOTOR → BODY → WORLD
```

- **BRAIN and ORGANISM share one route and one renderer**, so moving between
  scales is a camera move, not a reload. The connectome was inside an animal the
  whole time.
- **The body is `MODELED REFERENCE ANATOMY`** — procedurally generated, not the
  Fish1 specimen. No redistributable 6–7 dpf body mesh exists (mapZebrain is
  CC-BY-NC and brain-only), so we built one and labelled it.
- **The registration is `APPROXIMATE`** and says so in the UI. Measured
  coordinates are never rewritten; neurons move because a matrix moves.
- **Motion is `SIMULATED`, connectome coupling is `OFF`**, badged in the
  viewport every frame. Fish1 does not drive the fish yet, and the app never
  implies it does.

See [docs/EMBODIMENT.md](docs/EMBODIMENT.md),
[docs/SPATIAL_REGISTRATION.md](docs/SPATIAL_REGISTRATION.md) and
[docs/AGENT_ARCHITECTURE.md](docs/AGENT_ARCHITECTURE.md).

### A correction this phase forced

Phase 1 used **16 × 16 × 30 nm** for Fish1 soma coordinates, from the release
prose. The data disagrees: the export reaches y = 49,799, impossible on the
16 nm grid (32,500 voxels) but fine on the 8 nm one (65,000); soma spacing at
8 nm is 5.6 µm — a larval neuron — versus 9.0 µm at 16 nm; and the official
notebook's coordinate helper defaults to `(8, 8, 30)`. **The brain was being
rendered at twice its true size in x and y.** Corrected, and
`pipeline/fish1/validate.py` now rejects any export whose coordinates fall
outside the published volume.

---

## Datasets

| Dataset                      | Real?        | Credentials | Coverage                                        |
| ---------------------------- | ------------ | ----------- | ----------------------------------------------- |
| `fish1-released` _(default)_ | ✅ measured  | none        | 30,346 soma + 13,813 edges, HMI analysis region |
| `fish1`                      | ✅ measured  | CAVE token  | whole brain, >180k soma, ~30M synapses          |
| `dev-sample`, `benchmark-*`  | ❌ generated | none        | badged `NOT BIOLOGICAL DATA`                    |

### `fish1-released` — real data, zero setup

The Fish1 release ships `HMI_analysis.zip` and `TEN_analysis.zip` alongside the
paper. Between them they contain a CAVE `somas` export and real per-neuron
synaptic partner lists, all openly downloadable. One script turns them into the
application's binary artefacts:

```bash
python pipeline/fish1/import_released.py
```

The output is committed, so a clone or a deploy already has it.

Its limits are stated in the UI rather than smoothed over:

- It covers the **HMI analysis box, not the whole brain**.
- Connectivity was published only for the ~1.1k neurons in the TEN/DMV study.
  Ask any other neuron for its partners and you get
  **"no connectivity was published for this cell"** — never a fabricated `0`.

---

## Fish1 access setup

Fish1 metadata, connectivity and skeletons come from CAVE and need a personal
token. **The token is read only on the server and is never sent to the browser**
(`src/datasets/fish1/cave-client.ts` throws if imported client-side).

1. Sign in to the Fish1 CAVE deployment and open
   <https://global.brain-wire-test.org/sticky_auth/settings/tokens>
2. Copy the token.
3. `cp .env.example .env.local` and set `CAVE_TOKEN=...`
4. Restart the dev server.

Check it worked at `/data`, which reports the live materialization version, or:

```bash
curl localhost:3000/api/datasets/fish1/metadata
```

Without a token the app still runs; Fish1 reports `auth_missing` with the exact
remediation step instead of failing generically.

### The whole-brain Fish1 index

Per-neuron queries work as soon as a token is set. The **whole population** is a
separate artefact: pulling 180,000+ soma through a live materialization query on
every page load would be slow and abusive of a shared community service. Build
it once with the pipeline:

```bash
python -m venv .venv && . .venv/Scripts/activate    # Windows
pip install -r pipeline/requirements.txt

python pipeline/fish1/fetch_metadata.py                        # verify access
python pipeline/fish1/export_neurons.py --out public/datasets/fish1
python pipeline/fish1/validate.py public/datasets/fish1
```

That writes a ~4 MB binary plus a manifest, after which `/brain?dataset=fish1`
loads the real brain. See [pipeline/README.md](pipeline/README.md).

---

## Architecture summary

```
src/
  core/         dataset-agnostic science: provenance, IDs, coordinates,
                binary format, filters, traversal, errors, SWC
  renderer/     GPU engine. No React anywhere below this directory.
    backends/   WebGPU (preferred) and WebGL2 (real fallback)
    layers/     SomaLayer, ConnectionLayer, AxesLayer
  datasets/     adapters: fish1, zapbench, firewire, synthetic
  workers/      population generation, graph traversal
  state/        zustand stores (UI + data cache only)
  components/   React UI
  simulation/   types only — the future engine's seam
  app/          Next.js routes, including the server-side API boundary
pipeline/fish1/ Python CAVE ingestion
docs/           ARCHITECTURE.md, DATA_SOURCES.md
```

**React owns the UI. The renderer owns the neurons.** There is no React
component per neuron, no `Mesh` per neuron, and no array of neuron objects in
the hot path — the population is a struct-of-arrays of TypedArrays uploaded
once. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Environment variables

| Variable                        | Purpose                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `CAVE_TOKEN`                    | Fish1 access token. **Server only. Never commit.**                               |
| `CAVE_GLOBAL_URL`               | CAVE global/auth server. Default `https://global.brain-wire-test.org`            |
| `CAVE_LOCAL_URL`                | Chunked graph + skeleton cache. Default `https://pcgv3local.brain-wire-test.org` |
| `FISH1_DATASTACK`               | Default `fish1_full`                                                             |
| `FISH1_PCG_TABLE`               | Default `fish1_v250915`                                                          |
| `FISH1_MATERIALIZATION_VERSION` | Pin a version for reproducibility. Empty = latest.                               |
| `CAVE_CACHE_TTL_SECONDS`        | Upstream cache TTL. Default `900`.                                               |

---

## Benchmarks

Deterministic synthetic populations stress the renderer without re-downloading
real data. The harness drives the actual application in real Chrome and reads
the app's own instrumentation — it measures, it does not estimate.

Playwright is not a project dependency (its install hook downloads browser
binaries, which has no place in a deploy build), so install it on demand:

```bash
npm install -D playwright
npm run build && npx next start -p 3111
npm run benchmark -- --url http://localhost:3111
```

Measured on an **NVIDIA Lovelace GPU via WebGPU**, 1600×900, vsync disabled,
continuous rendering forced (`?bench=1`) so idle frames cannot inflate the
result:

|    Soma | Render FPS (median) | CPU frame | GPU buffers |   Load |
| ------: | ------------------: | --------: | ----------: | -----: |
|  10,000 |                4861 |   0.03 ms |     0.23 MB | 196 ms |
|  50,000 |                4332 |   0.03 ms |     1.14 MB | 133 ms |
| 100,000 |                4493 |   0.03 ms |     2.29 MB | 144 ms |
| 200,000 |                4396 |   0.05 ms |     4.58 MB | 162 ms |
| 500,000 |                1930 |   0.24 ms |    11.44 MB | 390 ms |

200,000 soma — Fish1's order of magnitude — draws in roughly 0.23 ms per frame,
about 70× under a 60 Hz budget, in **2 draw calls** at any population size.

Note the diagnostics report `fps (raf)` and `render fps` separately. Because
idle frames are skipped, the browser's tick rate is not the renderer's
throughput, and only the latter is a meaningful benchmark number.

---

## Quality

```bash
npm run typecheck     # tsc --noEmit
npm run lint
npm run test          # vitest
npm run build
npm run build:body    # regenerate the reference body artifact
```

164 tests cover the logic that can break scientific correctness: binary
encode/decode and corruption handling, coordinate invertibility, the lore/root
ID distinction, filter masks, traversal limits, SWC parsing, generator
determinism, and the provenance rules themselves. Phase 2 adds the mesh container,
transform composition and invertibility, rigid-registration distance
preservation, rig skinning, fixed-timestep behaviour, controller determinism,
tank collision, event ordering, and the capability gateway — including that an
unapproved capability never executes and that credential-shaped payloads are
refused. One test asserts that placing a body does not modify a single neuron
coordinate. Another shells out to Python and decodes a pipeline-written
container with the production TypeScript decoder, so the two implementations of
the binary format cannot silently diverge.

---

## What is not built yet

Stated plainly, because a disabled control is worth more than a fake one:

- **Neural control of the body.** The controller is procedural. Swapping in a
  `NeuralBehaviorController` is a one-line change at a defined seam, and the
  `CONNECTOME COUPLING OFF` badge flips only when it is genuinely true.
- **Simulation, Experiments, Lab** — navigation entries are disabled with a
  tooltip saying what each will be. Types exist in `src/simulation/types.ts`.
- **External capabilities** — the gateway, permission modes and audit trail are
  implemented; exactly one no-op sandbox capability is registered, in OBSERVE
  mode. There is no network, filesystem or system access anywhere in it.
- **Memory and persistence** — interfaces only. No invented age or action counts.
- **Skeleton rendering** — the data path is live and SWC download works; drawing
  morphology in the viewport is the next milestone.
- **Depth > 1 tracing** — the traversal engine and its limits are implemented
  and tested; the UI currently drives depth 1.
- **ZAPBench** — typed adapter boundary only. It is a _different animal_ from
  Fish1; there is no cell-level correspondence and the app will not invent one.
- **Fire&Wire** — restricted. This repository holds none of that data, fetches
  none of it, and contains no endpoints for it.

---

## Data attribution

This application does not own any third-party dataset. It ships one derived
artefact: `public/datasets/fish1-released/`, built from the openly published
Fish1 analysis packages and redistributed under their open-access terms with
the required citation below, which also travels in the artefact manifest.

> Petkova, M. D., Januszewski, M., et al. (2025). _A connectomic resource for
> neural cataloguing and circuit dissection of the larval zebrafish brain._
> bioRxiv.

Fish1 is open access and **requires citation**. See
[docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) and the `/data` page.
