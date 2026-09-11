# Fish1 data pipeline

Preprocessing that turns published Fish1 tables into web-optimised artefacts.

**Python is never required at browser runtime.** These scripts run offline and
emit static, version-addressed files the application then serves.

---

## Setup

```bash
python -m venv .venv
. .venv/Scripts/activate        # Windows
# source .venv/bin/activate     # macOS / Linux
pip install -r pipeline/requirements.txt
```

### Authenticate

Follow the official Fish1 instructions: obtain a token from
`https://global.brain-wire-test.org/sticky_auth/settings/tokens`, then

```python
import caveclient
auth = caveclient.auth.AuthClient(server_address="https://global.brain-wire-test.org/")
auth.save_token(token="YOUR_TOKEN_HERE", overwrite=True)
```

which writes `~/.cloudvolume/secrets/cave-secret.json`. That file is a personal
credential: never commit it, and never hand it to the web app (the server reads
its own `CAVE_TOKEN` env var instead).

---

## Scripts

### `fetch_metadata.py` — run this first

Reports, with real values rather than assumptions: whether the token works,
the current materialization version, which annotation tables exist, and the
`somas` schema with a sample row.

```bash
python pipeline/fish1/fetch_metadata.py
```

### `export_neurons.py` — the main export

Turns the soma table into the single binary the browser downloads once.

```bash
python pipeline/fish1/export_neurons.py --out public/datasets/fish1
python pipeline/fish1/export_neurons.py --materialization 574   # pin a version
python pipeline/fish1/export_neurons.py --limit 5000            # smoke test
```

Writes:

```
public/datasets/fish1/
  manifest.json                 version-addressed paths, counts, checksum
  v574/neurons.bin              CLN1 container, ~4 MB for 183k soma
```

Behaviour worth knowing:

- Rows with a missing `id` or position are **dropped and counted**, not mapped
  to the origin. A neuron with no coordinate cannot be drawn, and placing a fake
  cell in the brain is worse than omitting it.
- Lore IDs outside `uint32` abort the export with an explanation rather than
  wrapping silently.
- Root IDs are carried for reference only. They are mutable and valid solely for
  the exported materialization; they are never the neuron's identity.
- Regions are exported as `0xFFFF` (unassigned). Fish1 does not publish a region
  per soma, and deriving one from position would be an invented anatomical claim.
- The container is decoded and validated **before** it is written.

### `validate.py` — run after every export

```bash
python pipeline/fish1/validate.py public/datasets/fish1
```

Checks the header, descriptor, lane lengths, offsets and alignment; that the
manifest agrees with the binary (dataset, count, FNV-1a checksum); that lore IDs
are unique; that coordinates are finite and non-degenerate; and that the
physical extent is plausible for a larval zebrafish brain — which is the check
that catches a wrong voxel size.

### `export_connectivity.py`

Aggregates the ~30M-synapse table down to **one row per connected pair**, which
is what the application and any future simulation actually need.

```bash
python pipeline/fish1/export_connectivity.py --lore-ids 173502
python pipeline/fish1/export_connectivity.py --from-index public/datasets/fish1 --limit 500
```

Writes a CSV and a CSR-style `.npz` (`offsets`, `targets`, `weights`, `signs`)
that maps directly onto `SparseConnectivity` in `src/simulation/types.ts`.

### `export_skeleton.py`

```bash
python pipeline/fish1/export_skeleton.py --lore-id 173502 --out data/skeletons
```

One neuron at a time, by design — there is no bulk mode. It re-resolves stale
root IDs through the chunked graph and says so when a segment was edited.

---

## `neuron_index.py` — the format writer

Python counterpart of `src/core/binary.ts`, and it **must stay byte
compatible**. Layout is documented in
[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#5-binary-format-cln1).

That contract is enforced by a test: `tests/pipeline-interop.test.ts` shells out
to Python, writes a container with this module, and decodes it with the
production TypeScript decoder — checking coordinates, cell types, and 64-bit
root IDs survive the language boundary. Two implementations, two languages,
different endianness defaults; without that test a divergence would only ever
show up as a subtly wrong brain.

```bash
npm run test -- pipeline-interop
```

---

## Data hygiene

`.gitignore` excludes `data/raw/`, `data/cache/`, `public/datasets/fish1/`,
`pipeline/**/out/`, `*.swc` and `*.zip`.

**Do not commit large source datasets.** Only small generated manifests are
tracked; binaries are built locally or in a deploy step.
