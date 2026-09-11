#!/usr/bin/env python3
"""Build the Fish1 Hindbrain Motion Integrator (HMI) circuit artefact.

No credentials required. Everything here comes from the published

    https://fish1-release.storage.googleapis.com/paper_data/HMI_analysis.zip

which ships the manually reconstructed HMI circuit as
`data/em_zfish1_dataframe.xlsx` plus a CAVE soma cache
(`data/cave_somas_in_big_box.csv`).

WHAT THE SOURCE ACTUALLY CONTAINS
---------------------------------
999 reconstructed cells with, per cell:

    Cell ID                     stable lore id
    classifier                  morphological class ('1', '2', '4', '5 or 6',
                                '7', 'L-2', 'spn_*', 'other', '1 or 2')
    final_neurotransmitter_ID   VGluT2 / Gad1B / unlabeled / unclear / n/a
    network_level               tracing layer(s), e.g. ['network_seed',
                                'output_two']
    reconstruction_status       what was reconstructed for this cell
    inputs / outputs            per-synapse contact lists, each entry
                                (partner_cell_id | '-', x, y, z, size)

A '-' partner means a contact was traced but the partner was never identified.
Those are counted and reported, never silently dropped and never invented.

WHAT THIS SCRIPT REFUSES TO DO
------------------------------
  * It does not turn an unlabelled neurotransmitter into 'excitatory'.
  * It does not assign a class from a bounding box. A cell with no published
    classifier stays unclassified.
  * It does not invent edges. Class-level projections that the model needs but
    the reconstruction never traced are NOT written here; they live in the
    model configuration, where they are labelled and independently ablatable.
  * It does not mirror anything. Bilateral completion is a model-time
    operation, so the artefact stays a record of what was measured.

Usage:

    python pipeline/fish1/hmi/build_hmi.py --out public/datasets/fish1-hmi
"""

from __future__ import annotations

import argparse
import ast
import csv
import io
import json
import os
import struct
import sys
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from urllib.request import urlopen

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from fish1.common import CITATION, VOXEL_SPACE  # noqa: E402

RELEASE_URL = "https://fish1-release.storage.googleapis.com/paper_data/HMI_analysis.zip"
ARCHIVE = "HMI_analysis.zip"
DATAFRAME = "HMI_analysis/data/em_zfish1_dataframe.xlsx"
SOMA_CSV = "HMI_analysis/data/cave_somas_in_big_box.csv"

DATASET_ID = "fish1-hmi"
VERSION = "v1"
MAGIC = b"HMI1"

# ---------------------------------------------------------------------------
# Midline
# ---------------------------------------------------------------------------
# y is the mediolateral axis. Established empirically, not assumed: of the three
# source axes, only y makes the 30,346-soma distribution reflection-symmetric
# (best mirror correlation 0.88 for y, versus 0.60 for x and 0.45 for z).
#
# The fitted reflection centre is y = 33,250 voxels. The geometric centre of the
# published volume (65,000 voxels in y) is 32,500. They agree to 750 voxels =
# 6 um, which is the resolution of this kind of claim. We use the fitted value
# and record both.
MIDLINE_Y_VOXELS = 33250
VOLUME_CENTRE_Y_VOXELS = 32500
MIDLINE_METHOD = (
    "Fitted by maximising reflection symmetry of the 30,346-soma y distribution "
    "(mirror correlation 0.88, versus 0.60 for x and 0.45 for z). Agrees with the "
    "published volume's geometric centre (32,500 voxels) to 750 voxels (6 um)."
)

# Morphological classes, in the release's own vocabulary. The compact labels
# follow HMI_analysis/src/zfish/labels.py so ours cannot drift from theirs.
CLASS_ORDER = [
    "unclassified",   # 0
    "I",              # 1  classifier '1'
    "II",             # 2  classifier '2' / 'contralateral axon'
    "I_or_II",        # 3  classifier '1 or 2' - genuinely ambiguous in the source
    "L-2",            # 4
    "R",              # 5  classifier '4'
    "P",              # 6  classifier '5', '6', '5 or 6'
    "F",              # 7  classifier '7'
    "SPN_turning",    # 8
    "SPN_forward",    # 9
    "SPN_other",      # 10
    "other",          # 11 classifier literally 'other'
]
CLASS_INDEX = {name: i for i, name in enumerate(CLASS_ORDER)}

TRANSMITTER_ORDER = ["unknown", "excitatory", "inhibitory"]

# Provenance codes shared with the TypeScript side (src/core/hmi.ts).
PROV_UNCLASSIFIED = 0
PROV_MORPHOLOGY_PREDICTED = 1
PROV_MOLECULARLY_MEASURED = 2
PROV_FUNCTIONALLY_MEASURED = 3
PROV_CONNECTIVITY_DERIVED = 4


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", default=f"public/datasets/{DATASET_ID}")
    p.add_argument("--cache", default="data/raw")
    return p.parse_args()


def fetch(cache_dir: str) -> str:
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, ARCHIVE)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        print(f"  cached  {ARCHIVE} ({os.path.getsize(path):,} bytes)")
        return path
    print(f"  fetch   {RELEASE_URL}")
    with urlopen(RELEASE_URL) as response, open(path, "wb") as handle:
        handle.write(response.read())
    print(f"          {os.path.getsize(path):,} bytes")
    return path


def class_label(value: str) -> tuple[str, float]:
    """Map a source classifier string to (compact label, confidence).

    Confidence is NOT a classifier score - the release does not publish one. It
    records how specific the published label itself is: 1.0 for an unambiguous
    class, 0.5 for the source's own '1 or 2' hedge, 0.0 for no label. Anything
    finer would be invented.
    """
    text = str(value).strip()
    lower = text.lower()

    if lower in {"", "n/a", "na", "nan", "none"}:
        return "unclassified", 0.0

    if "spn" in lower:
        if "turn" in lower:
            return "SPN_turning", 1.0
        if "forw" in lower:
            return "SPN_forward", 1.0
        return "SPN_other", 1.0

    if text == "L-2":
        return "L-2", 1.0
    if text in {"1", "1.0"}:
        return "I", 1.0
    if text in {"2", "2.0", "Class 2", "contralateral axon"}:
        return "II", 1.0
    if lower == "1 or 2":
        return "I_or_II", 0.5
    if text in {"7", "7.0"}:
        return "F", 1.0
    if text in {"4", "4.0"}:
        return "R", 1.0
    if text in {"5", "5.0", "6", "6.0", "5 or 6"}:
        return "P", 1.0 if text in {"5", "5.0", "6", "6.0"} else 0.5
    if lower == "other":
        return "other", 1.0
    return "unclassified", 0.0


def transmitter_of(value: str) -> tuple[str, int]:
    """Map the published neurotransmitter ID to (label, provenance code).

    'unlabeled' and 'unclear' are distinct from 'n/a' in the source but all three
    mean the same thing for a model: the sign is not known. They collapse to
    'unknown' with NO provenance, never to a default sign.
    """
    text = str(value).strip().lower()
    if text in {"vglut2", "vglut", "glut", "glutamatergic", "excitatory", "exc"}:
        return "excitatory", PROV_MOLECULARLY_MEASURED
    if text in {"gad1b", "gad", "gaba", "gabaergic", "inhibitory", "inh"}:
        return "inhibitory", PROV_MOLECULARLY_MEASURED
    return "unknown", PROV_UNCLASSIFIED


def parse_network_levels(value) -> list[str]:
    if isinstance(value, (list, tuple)):
        return [str(v) for v in value]
    text = str(value).strip()
    if text.lower() in {"", "n/a", "na", "nan", "none"}:
        return []
    try:
        parsed = ast.literal_eval(text)
    except Exception:
        return []
    if isinstance(parsed, (list, tuple, set)):
        return [str(v) for v in parsed]
    return [str(parsed)]


def parse_synapses(value) -> tuple[list[tuple[int, tuple[int, int, int]]], int, int]:
    """Return (identified contacts, unidentified count, malformed count).

    Mirrors HMI_analysis/src/zfish/graph/build.py: an entry shorter than 4 is
    malformed, a partner of '-' is a traced-but-unidentified contact.
    """
    text = str(value).strip()
    if text.lower() in {"", "n/a", "na", "nan", "none", "[]"}:
        return [], 0, 0
    try:
        parsed = ast.literal_eval(text)
    except Exception:
        return [], 0, 0
    if not isinstance(parsed, list):
        return [], 0, 0

    contacts: list[tuple[int, tuple[int, int, int]]] = []
    unidentified = 0
    malformed = 0
    for entry in parsed:
        if not entry or len(entry) < 4:
            malformed += 1
            continue
        partner = entry[0]
        if partner == "-" or partner is None:
            unidentified += 1
            continue
        try:
            pid = int(partner)
            pos = (int(float(entry[1])), int(float(entry[2])), int(float(entry[3])))
        except (TypeError, ValueError):
            malformed += 1
            continue
        contacts.append((pid, pos))
    return contacts, unidentified, malformed


def pad8(handle) -> None:
    remainder = handle.tell() % 8
    if remainder:
        handle.write(b"\0" * (8 - remainder))


def main() -> int:
    args = parse_args()
    print("Fish1 HMI circuit import (published data, no credentials)")
    archive_path = fetch(args.cache)
    archive = zipfile.ZipFile(archive_path)

    # ------------------------------------------------------------- dataframe
    import openpyxl

    workbook = openpyxl.load_workbook(io.BytesIO(archive.read(DATAFRAME)), data_only=True)
    rows = list(workbook.worksheets[0].iter_rows(values_only=True))
    header = list(rows[0])
    records = [dict(zip(header, row)) for row in rows[1:] if row and row[0] is not None]
    print(f"\n  {DATAFRAME}: {len(records)} reconstructed cells")

    # ------------------------------------------------------------ soma cache
    csv.field_size_limit(10**8)
    soma: dict[int, tuple[int, int, int, str]] = {}
    text = archive.read(SOMA_CSV).decode("utf-8")
    for row in csv.DictReader(text.splitlines()):
        if row.get("valid", "True") != "True":
            continue
        try:
            soma[int(row["id"])] = (
                int(round(float(row["_x"]))),
                int(round(float(row["_y"]))),
                int(round(float(row["_z"]))),
                row.get("pt_root_id") or "0",
            )
        except (TypeError, ValueError):
            continue
    print(f"  {SOMA_CSV}: {len(soma):,} soma")

    # ------------------------------------------------------------ neurons
    cells: list[dict] = []
    missing_soma = 0
    for record in records:
        try:
            lore = int(record["Cell ID"])
        except (TypeError, ValueError):
            continue
        placed = soma.get(lore)
        if placed is None:
            # A reconstructed cell with no soma row cannot be drawn or given a
            # hemisphere. It is reported, not guessed at.
            missing_soma += 1
            continue
        x, y, z, root = placed
        label, confidence = class_label(record.get("classifier"))
        transmitter, transmitter_prov = transmitter_of(record.get("final_neurotransmitter_ID"))
        cells.append(
            {
                "lore": lore,
                "name": str(record.get("name") or ""),
                "pos": (x, y, z),
                "root": root,
                "hemisphere": 0 if y < MIDLINE_Y_VOXELS else 1,
                "class": label,
                "classConfidence": confidence,
                "classSource": str(record.get("classifier") or ""),
                "transmitter": transmitter,
                "transmitterProv": transmitter_prov,
                "transmitterSource": str(record.get("final_neurotransmitter_ID") or ""),
                "levels": parse_network_levels(record.get("network_level")),
                "status": str(record.get("reconstruction_status") or ""),
            }
        )

    cells.sort(key=lambda c: c["lore"])
    index_of = {c["lore"]: i for i, c in enumerate(cells)}
    count = len(cells)
    print(f"  {count} cells have a soma position ({missing_soma} reconstructed cells do not)")

    duplicates = len(cells) - len(index_of)
    if duplicates:
        raise SystemExit(f"Duplicate Cell IDs in the source dataframe: {duplicates}")

    # ------------------------------------------------------------ edges
    edge_syn: Counter[tuple[int, int]] = Counter()
    edge_pos: dict[tuple[int, int], list[tuple[int, int, int]]] = defaultdict(list)
    unidentified_total = 0
    malformed_total = 0
    traced_cells = set()
    dropped_unplaced = 0

    for record in records:
        try:
            lore = int(record["Cell ID"])
        except (TypeError, ValueError):
            continue
        for column, incoming in (("inputs", True), ("outputs", False)):
            contacts, unidentified, malformed = parse_synapses(record.get(column))
            unidentified_total += unidentified
            malformed_total += malformed
            if contacts or unidentified:
                traced_cells.add(lore)
            for partner, position in contacts:
                pre, post = (partner, lore) if incoming else (lore, partner)
                if pre not in index_of or post not in index_of:
                    dropped_unplaced += 1
                    continue
                edge_syn[(pre, post)] += 1
                edge_pos[(pre, post)].append(position)

    edges = sorted(edge_syn.items())
    edge_count = len(edges)
    print(
        f"\n  traced contacts: {unidentified_total:,} unidentified partners, "
        f"{malformed_total:,} malformed entries (both excluded, both reported)"
    )
    print(f"  {dropped_unplaced:,} contacts dropped: a partner had no soma position")
    print(
        f"  {edge_count:,} directed pairs, {sum(edge_syn.values()):,} synapses, "
        f"traced from {len(traced_cells):,} cells"
    )

    # ------------------------------------------------------------ statistics
    by_class = Counter(c["class"] for c in cells)
    by_transmitter = Counter(c["transmitter"] for c in cells)
    by_hemisphere = Counter(c["hemisphere"] for c in cells)

    print("\n  class:")
    for name in CLASS_ORDER:
        if by_class.get(name):
            print(f"    {name:14} {by_class[name]:4d}")
    print("  neurotransmitter:")
    for name in TRANSMITTER_ORDER:
        print(f"    {name:14} {by_transmitter.get(name, 0):4d}")
    print(f"  hemisphere: left {by_hemisphere.get(0, 0)}, right {by_hemisphere.get(1, 0)}")

    # Edge sign under the strict policy, computed here so the artefact can state
    # the consequence of its own E/I coverage rather than leaving it implicit.
    signed = Counter()
    for (pre, _post), _n in edges:
        signed[cells[index_of[pre]]["transmitter"]] += 1
    print(
        f"  strict E/I coverage: {signed.get('excitatory', 0)} excitatory, "
        f"{signed.get('inhibitory', 0)} inhibitory, {signed.get('unknown', 0)} unknown-sign edges"
    )

    # Class-level transmitter purity. Published so the application can show a
    # user why class imputation is or is not defensible for each class, instead
    # of imputing silently.
    purity: dict[str, dict] = {}
    for name in CLASS_ORDER:
        members = [c for c in cells if c["class"] == name]
        labelled = [c for c in members if c["transmitter"] != "unknown"]
        if not labelled:
            continue
        counts = Counter(c["transmitter"] for c in labelled)
        majority, majority_n = counts.most_common(1)[0]
        purity[name] = {
            "members": len(members),
            "labelled": len(labelled),
            "majority": majority,
            "purity": round(majority_n / len(labelled), 4),
        }

    # Network levels are a record of how the reconstruction was seeded and
    # traced outward. They are structural provenance, NOT functional classes,
    # and the descriptor says so.
    levels = Counter()
    for c in cells:
        for level in c["levels"]:
            levels[level] += 1

    # ------------------------------------------------------------ lanes
    lore_ids = np.array([c["lore"] for c in cells], dtype=np.uint32)
    root_ids = np.array([int(c["root"] or 0) for c in cells], dtype=np.uint64)
    positions = np.array([c["pos"] for c in cells], dtype=np.int32).reshape(-1)
    hemispheres = np.array([c["hemisphere"] for c in cells], dtype=np.uint8)
    class_indices = np.array([CLASS_INDEX[c["class"]] for c in cells], dtype=np.uint8)
    class_confidence = np.array([c["classConfidence"] for c in cells], dtype=np.float32)
    class_provenance = np.array(
        [PROV_UNCLASSIFIED if c["class"] == "unclassified" else PROV_MORPHOLOGY_PREDICTED for c in cells],
        dtype=np.uint8,
    )
    transmitters = np.array(
        [TRANSMITTER_ORDER.index(c["transmitter"]) for c in cells], dtype=np.uint8
    )
    transmitter_provenance = np.array([c["transmitterProv"] for c in cells], dtype=np.uint8)

    edge_pre = np.array([index_of[a] for (a, _b), _n in edges], dtype=np.uint32)
    edge_post = np.array([index_of[b] for (_a, b), _n in edges], dtype=np.uint32)
    edge_counts = np.array([n for _k, n in edges], dtype=np.uint32)
    edge_centroid = np.array(
        [np.mean(edge_pos[k], axis=0).round() for k, _n in edges], dtype=np.int32
    ).reshape(-1) if edge_count else np.zeros(0, dtype=np.int32)

    in_syn = np.zeros(count, dtype=np.uint32)
    out_syn = np.zeros(count, dtype=np.uint32)
    for (a, b), n in edges:
        out_syn[index_of[a]] += n
        in_syn[index_of[b]] += n

    descriptor = {
        "format": "HMI1",
        "dataset": DATASET_ID,
        "version": VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "neuronCount": count,
        "edgeCount": edge_count,
        "synapseCount": int(sum(edge_syn.values())),
        "voxelSpace": VOXEL_SPACE,
        "midline": {
            "axis": "y",
            "voxels": MIDLINE_Y_VOXELS,
            "volumeCentreVoxels": VOLUME_CENTRE_Y_VOXELS,
            "method": MIDLINE_METHOD,
            "provenance": "derived",
        },
        "classOrder": CLASS_ORDER,
        "transmitterOrder": TRANSMITTER_ORDER,
        "classCounts": {k: v for k, v in by_class.items()},
        "transmitterCounts": {k: by_transmitter.get(k, 0) for k in TRANSMITTER_ORDER},
        "hemisphereCounts": {
            "left": by_hemisphere.get(0, 0),
            "right": by_hemisphere.get(1, 0),
        },
        "classTransmitterPurity": purity,
        "networkLevels": dict(levels.most_common()),
        "tracing": {
            "cellsWithTracedContacts": len(traced_cells),
            "unidentifiedContacts": unidentified_total,
            "malformedContacts": malformed_total,
            "contactsDroppedNoSoma": dropped_unplaced,
            "reconstructedCellsWithoutSoma": missing_soma,
            "note": (
                "Outgoing contacts were traced from a small number of seed cells, so most "
                "cells here have no published outgoing edges. That means 'not traced', not "
                "'no partners'."
            ),
        },
        "strictSignCoverage": {
            "excitatoryEdges": signed.get("excitatory", 0),
            "inhibitoryEdges": signed.get("inhibitory", 0),
            "unknownSignEdges": signed.get("unknown", 0),
        },
        "lanes": [
            {"name": "loreId", "type": "u32", "count": count},
            {"name": "rootId", "type": "u64", "count": count},
            {"name": "position", "type": "i32", "count": count * 3},
            {"name": "hemisphere", "type": "u8", "count": count},
            {"name": "classIndex", "type": "u8", "count": count},
            {"name": "classConfidence", "type": "f32", "count": count},
            {"name": "classProvenance", "type": "u8", "count": count},
            {"name": "transmitter", "type": "u8", "count": count},
            {"name": "transmitterProvenance", "type": "u8", "count": count},
            {"name": "incomingSynapses", "type": "u32", "count": count},
            {"name": "outgoingSynapses", "type": "u32", "count": count},
            {"name": "edgePre", "type": "u32", "count": edge_count},
            {"name": "edgePost", "type": "u32", "count": edge_count},
            {"name": "edgeSynapses", "type": "u32", "count": edge_count},
            {"name": "edgePosition", "type": "i32", "count": edge_count * 3},
        ],
        "provenance": {
            "positions": "measured",
            "connectivity": "measured",
            "neurotransmitter": "measured where labelled, otherwise unknown",
            "class": "morphology_predicted (published classifier)",
            "hemisphere": "derived from the fitted midline",
        },
        "citation": CITATION,
        "source": RELEASE_URL,
    }

    # ------------------------------------------------------------ write
    version_dir = os.path.join(args.out, VERSION)
    os.makedirs(version_dir, exist_ok=True)
    bin_path = os.path.join(version_dir, "hmi.bin")

    buffer = io.BytesIO()
    descriptor_bytes = json.dumps(descriptor, separators=(",", ":")).encode("utf-8")
    buffer.write(MAGIC)
    buffer.write(struct.pack("<I", len(descriptor_bytes)))
    buffer.write(descriptor_bytes)
    pad8(buffer)
    for lane in (
        lore_ids, root_ids, positions, hemispheres, class_indices, class_confidence,
        class_provenance, transmitters, transmitter_provenance, in_syn, out_syn,
        edge_pre, edge_post, edge_counts, edge_centroid,
    ):
        buffer.write(lane.tobytes())
        pad8(buffer)

    payload = buffer.getvalue()
    with open(bin_path, "wb") as handle:
        handle.write(payload)

    # ------------------------------------------------------------ populations
    def members(predicate) -> list[int]:
        return sorted(c["lore"] for c in cells if predicate(c))

    populations = {
        "dataset": DATASET_ID,
        "version": VERSION,
        "note": (
            "Populations are defined by PUBLISHED per-cell labels (morphological classifier "
            "and tracing network level), never by a spatial bounding box. A cell with no "
            "published label belongs to no population."
        ),
        "midlineVoxels": MIDLINE_Y_VOXELS,
        "populations": [
            {
                "id": "class-I",
                "label": "Class I",
                "definition": "Published classifier '1'. Ipsilaterally projecting.",
                "provenance": "morphology_predicted",
                "loreIds": members(lambda c: c["class"] == "I"),
            },
            {
                "id": "class-II",
                "label": "Class II",
                "definition": "Published classifier '2' ('contralateral axon'). Axon crosses the midline.",
                "provenance": "morphology_predicted",
                "loreIds": members(lambda c: c["class"] == "II"),
            },
            {
                "id": "class-I-or-II",
                "label": "Class I or II (ambiguous)",
                "definition": "Published classifier '1 or 2'. The SOURCE is undecided; we keep the hedge.",
                "provenance": "morphology_predicted",
                "loreIds": members(lambda c: c["class"] == "I_or_II"),
            },
            {
                "id": "L-2",
                "label": "L-2",
                "definition": "Published classifier 'L-2'. Predominantly contralateral and Gad1b.",
                "provenance": "morphology_predicted",
                "loreIds": members(lambda c: c["class"] == "L-2"),
            },
            {
                "id": "spn-turning",
                "label": "Spinal projection (turning)",
                "definition": "Published classifier 'spn_turning_*'. Descending output associated with turning.",
                "provenance": "morphology_predicted",
                "loreIds": members(lambda c: c["class"] == "SPN_turning"),
            },
            {
                "id": "spn-forward",
                "label": "Spinal projection (forward)",
                "definition": "Published classifier 'spn_forward_*'. Descending output associated with forward swimming.",
                "provenance": "morphology_predicted",
                "loreIds": members(lambda c: c["class"] == "SPN_forward"),
            },
            {
                "id": "input-layer",
                "label": "Traced input layer",
                "definition": (
                    "Cells whose network_level includes an 'input_one' tracing label, i.e. cells "
                    "found by tracing presynaptic partners of the seed cells. This is a TRACING "
                    "layer, not a functional identification."
                ),
                "provenance": "connectivity_derived",
                "loreIds": members(
                    lambda c: any("input_one" in level for level in c["levels"])
                ),
            },
            {
                "id": "seed",
                "label": "Seed cells",
                "definition": "Cells whose network_level includes a seed label. Where the reconstruction started.",
                "provenance": "connectivity_derived",
                "loreIds": members(lambda c: any("seed" in level for level in c["levels"])),
            },
        ],
    }
    populations_path = os.path.join(version_dir, "populations.json")
    with open(populations_path, "w", encoding="utf-8") as handle:
        json.dump(populations, handle, separators=(",", ":"))

    for population in populations["populations"]:
        print(f"    {population['id']:16} {len(population['loreIds']):4d} cells")

    manifest = {
        "dataset": DATASET_ID,
        "version": VERSION,
        "generatedAt": descriptor["generatedAt"],
        "neuronCount": count,
        "edgeCount": edge_count,
        "files": {
            "circuit": f"/datasets/{DATASET_ID}/{VERSION}/hmi.bin",
            "populations": f"/datasets/{DATASET_ID}/{VERSION}/populations.json",
        },
        "bytes": {
            "circuit": len(payload),
            "populations": os.path.getsize(populations_path),
        },
        "notes": (
            "Manually reconstructed Hindbrain Motion Integrator circuit from the published "
            "Fish1 HMI analysis package. Positions and synaptic contacts are MEASURED. "
            "Morphological class is the published classifier. Neurotransmitter is measured "
            "only where labelled. " + CITATION
        ),
        "citation": CITATION,
    }
    manifest_path = os.path.join(args.out, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)

    print(f"\n  hmi.bin          {len(payload):,} bytes")
    print(f"  populations.json {os.path.getsize(populations_path):,} bytes")
    print(f"  wrote {bin_path}")
    print(f"  wrote {populations_path}")
    print(f"  wrote {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
