#!/usr/bin/env python3
"""Import the PUBLISHED Fish1 circuit-analysis data. No credentials required.

The Fish1 release ships two analysis archives alongside the paper:

    paper_data/HMI_analysis.zip   Hindbrain Motion Integrator
    paper_data/TEN_analysis.zip   Tegmental Excitatory Nucleus

Between them they contain real, measured Fish1 data that needs no CAVE token:

  * HMI_analysis/data/cave_somas_in_big_box.csv
        A CAVE `somas` export: stable lore id, cell_type (exc/inh/na),
        pt_root_id, pt_supervoxel_id and pt_position for ~30k soma.

  * TEN_analysis/agglomerated_segments_and_soma_ids.csv
        lores_id <-> hires_id_agglo, i.e. stable soma id <-> agglomerated
        segment id, for ~181k segments.

  * TEN_analysis/{incoming,outgoing}_synapses.csv
        Per-neuron partner lists in agglomerated segment ids. A partner id
        repeated N times means N synapses.

This script turns those into the same artefacts the authenticated pipeline
produces, so the application can show REAL Fish1 neurons out of the box.

    python pipeline/fish1/import_released.py --out public/datasets/fish1-released

Scope, stated precisely because the UI must not overstate it:

  - Positions exist only for the ~30k soma inside the HMI analysis box, not the
    whole >180k population. This is a REGION of the brain, not all of it.
  - Connectivity was published only for the neurons analysed in the TEN/DMV
    circuit study (~1.9k query neurons), so most soma here have NO published
    connectivity. That is "not in this export", which is emphatically not the
    same as "no partners", and the artefact records which neurons were analysed
    so the application can tell the two apart.
  - Partner lists use the `*_with_soma` columns, so an edge means "synapses
    from a partner that has an identified soma". Synapses onto unidentified
    fragments are excluded from the counts.

Citation is required for any use of this data; see README/data policy.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import zipfile
from collections import Counter
from datetime import datetime, timezone
from urllib.request import urlopen

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fish1.common import (  # noqa: E402
    CITATION,
    FLAG_ANNOTATED,
    VOXEL_SPACE,
    map_cell_type,
)
from fish1.neuron_index import build_neuron_index, fnv1a32, validate_container  # noqa: E402

RELEASE_BASE = "https://fish1-release.storage.googleapis.com/paper_data"
ARCHIVES = {
    "HMI_analysis.zip": f"{RELEASE_BASE}/HMI_analysis.zip",
    "TEN_analysis.zip": f"{RELEASE_BASE}/TEN_analysis.zip",
}

SOMA_CSV = "HMI_analysis/data/cave_somas_in_big_box.csv"
AGGLO_CSV = "TEN_analysis/agglomerated_segments_and_soma_ids.csv"
INCOMING_CSV = "TEN_analysis/incoming_synapses.csv"
OUTGOING_CSV = "TEN_analysis/outgoing_synapses.csv"

DATASET_ID = "fish1-released"
VERSION = "v1"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=f"public/datasets/{DATASET_ID}")
    parser.add_argument(
        "--cache", default="data/raw", help="Where the downloaded archives are kept"
    )
    return parser.parse_args()


def fetch(cache_dir: str) -> dict[str, str]:
    os.makedirs(cache_dir, exist_ok=True)
    paths = {}
    for name, url in ARCHIVES.items():
        path = os.path.join(cache_dir, name)
        if os.path.exists(path) and os.path.getsize(path) > 0:
            print(f"  cached  {name} ({os.path.getsize(path):,} bytes)")
        else:
            print(f"  fetch   {url}")
            with urlopen(url) as response, open(path, "wb") as handle:
                handle.write(response.read())
            print(f"          {os.path.getsize(path):,} bytes")
        paths[name] = path
    return paths


def read_member(zip_path: str, member: str) -> list[dict[str, str]]:
    csv.field_size_limit(10**8)
    with zipfile.ZipFile(zip_path) as archive:
        with archive.open(member) as handle:
            text = handle.read().decode("utf-8")
    return list(csv.DictReader(text.splitlines()))


ID_PATTERN = re.compile(r"\d+")


def main() -> int:
    args = parse_args()
    print("Fetching published Fish1 analysis archives (no credentials needed)")
    archives = fetch(args.cache)

    # ---------------------------------------------------------------- soma
    print(f"\nReading {SOMA_CSV}")
    soma_rows = read_member(archives["HMI_analysis.zip"], SOMA_CSV)
    print(f"  {len(soma_rows):,} rows")

    kept = []
    for row in soma_rows:
        if row.get("valid", "True") != "True":
            continue
        try:
            x, y, z = float(row["_x"]), float(row["_y"]), float(row["_z"])
            lore = int(row["id"])
        except (TypeError, ValueError):
            continue
        if lore <= 0:
            continue
        kept.append((lore, x, y, z, row.get("cell_type"), row.get("pt_root_id")))

    dropped = len(soma_rows) - len(kept)
    if dropped:
        print(f"  dropped {dropped:,} rows without a usable id/position")

    # Stable ordering by lore id keeps the export reproducible.
    kept.sort(key=lambda r: r[0])
    count = len(kept)

    positions = np.empty((count, 3), dtype=np.int32)
    lore_ids = np.empty(count, dtype=np.uint32)
    cell_types = np.empty(count, dtype=np.uint8)
    flags = np.zeros(count, dtype=np.uint8)
    root_ids = np.zeros(count, dtype=np.uint64)

    for i, (lore, x, y, z, cell_type, root) in enumerate(kept):
        positions[i] = (int(round(x)), int(round(y)), int(round(z)))
        lore_ids[i] = lore
        cell_types[i] = map_cell_type(cell_type)
        if cell_types[i] != 0:
            flags[i] |= FLAG_ANNOTATED
        try:
            root_ids[i] = np.uint64(int(root))
        except (TypeError, ValueError):
            root_ids[i] = np.uint64(0)

    by_type = Counter(int(c) for c in cell_types)
    print(
        f"  kept {count:,} soma  "
        f"(exc {by_type.get(1, 0):,}, inh {by_type.get(2, 0):,}, unannotated {by_type.get(0, 0):,})"
    )

    # ------------------------------------------------------- connectivity
    print(f"\nReading {AGGLO_CSV}")
    agglo = {}
    for row in read_member(archives["TEN_analysis.zip"], AGGLO_CSV):
        try:
            agglo[row["hires_id_agglo"].strip()] = int(row["lores_id"])
        except (TypeError, ValueError):
            continue
    print(f"  {len(agglo):,} segment -> lore id mappings")

    # (pre_lore, post_lore) -> synapse count. A partner id repeated N times in a
    # published row means N synapses between that pair.
    edges: Counter[tuple[int, int]] = Counter()
    analysed: set[int] = set()

    for member, column, incoming in (
        (INCOMING_CSV, "incoming_with_soma", True),
        (OUTGOING_CSV, "outgoing_with_soma", False),
    ):
        rows = read_member(archives["TEN_analysis.zip"], member)
        mapped = 0
        for row in rows:
            query = agglo.get(row["query_neuron"].strip())
            if query is None:
                continue
            mapped += 1
            analysed.add(query)
            for raw in ID_PATTERN.findall(row.get(column) or ""):
                partner = agglo.get(raw)
                if partner is None or partner == query:
                    continue
                # Always orient presynaptic -> postsynaptic.
                key = (partner, query) if incoming else (query, partner)
                edges[key] += 1
        print(f"  {member}: {len(rows):,} rows, {mapped:,} query neurons resolved")

    positioned = set(int(v) for v in lore_ids)
    drawable = sum(1 for (a, b) in edges if a in positioned and b in positioned)
    print(
        f"  {len(edges):,} distinct connected pairs; "
        f"{drawable:,} have both endpoints inside this export"
    )
    print(f"  connectivity published for {len(analysed):,} neurons")

    # ------------------------------------------------------------- write
    generated_at = datetime.now(timezone.utc).isoformat()
    version_block = {
        "materializationVersion": None,
        "segmentationTable": None,
        "generatedAt": generated_at,
        "label": "published circuit analysis",
    }

    container = build_neuron_index(
        dataset_id=DATASET_ID,
        origin="preprocessed-export",
        count=count,
        version=version_block,
        voxel_space=VOXEL_SPACE,
        # These are published observations, not anything we generated.
        position_provenance="measured",
        regions=[],
        positions_voxel=positions,
        lore_ids=lore_ids,
        cell_types=cell_types,
        region_ids=np.full(count, 0xFFFF, dtype=np.uint16),
        flags=flags,
        root_ids=root_ids,
    )
    descriptor = validate_container(container)
    assert descriptor["count"] == count

    version_dir = os.path.join(args.out, VERSION)
    os.makedirs(version_dir, exist_ok=True)

    bin_path = os.path.join(version_dir, "neurons.bin")
    with open(bin_path, "wb") as handle:
        handle.write(container)

    connectivity = {
        "dataset": DATASET_ID,
        "version": VERSION,
        "generatedAt": generated_at,
        "source": "Fish1 TEN analysis package (published with the resource paper)",
        "citation": CITATION,
        "note": (
            "Edges are presynaptic -> postsynaptic with synapse counts, derived from the "
            "*_with_soma partner lists. Synapses onto unidentified fragments are excluded. "
            "Connectivity was published only for the analysed neurons listed in "
            "analysedLoreIds; for any other neuron the correct statement is that no "
            "connectivity was published, NOT that it has no partners."
        ),
        "analysedLoreIds": sorted(analysed),
        "edges": [[a, b, n] for (a, b), n in sorted(edges.items())],
    }
    conn_path = os.path.join(version_dir, "connectivity.json")
    with open(conn_path, "w", encoding="utf-8") as handle:
        json.dump(connectivity, handle, separators=(",", ":"))

    manifest = {
        "dataset": DATASET_ID,
        "version": VERSION,
        "materializationVersion": None,
        "generatedAt": generated_at,
        "neuronCount": count,
        "files": {
            "neuronIndex": f"/datasets/{DATASET_ID}/{VERSION}/neurons.bin",
            "connectivity": f"/datasets/{DATASET_ID}/{VERSION}/connectivity.json",
        },
        "bytes": {
            "neuronIndex": len(container),
            "connectivity": os.path.getsize(conn_path),
        },
        "checksums": {"neuronIndex": f"fnv1a32:{fnv1a32(container):08x}"},
        "notes": (
            "Derived from the published Fish1 analysis packages (HMI + TEN), which require "
            f"no credentials. Positions are source voxel coordinates at "
            f"{'x'.join(str(v) for v in VOXEL_SPACE['voxelSizeNm'])} nm. "
            "Covers the HMI analysis box, not the whole brain. " + CITATION
        ),
    }
    manifest_path = os.path.join(args.out, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)

    print()
    print(f"  neurons        {count:,}")
    print(f"  neurons.bin    {len(container):,} bytes")
    print(f"  connectivity   {os.path.getsize(conn_path):,} bytes")
    print(f"  wrote {bin_path}")
    print(f"  wrote {conn_path}")
    print(f"  wrote {manifest_path}")
    print()
    print("Load it at /brain?dataset=fish1-released")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
