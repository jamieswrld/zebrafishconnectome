#!/usr/bin/env python3
"""Extract the REAL traced morphology of the HMI circuit.

The Fish1 release publishes its hindbrain reconstructions as a neuroglancer
precomputed segmentation with multi-resolution Draco meshes:

    gs://fish1-public/hindbrain_reconstructions/

The segment ids are the SAME stable cell ids as the HMI dataframe, so a mesh
here is the actual reconstructed shape of a cell whose connectivity we already
simulate. This is the difference between drawing a dot where a neuron's soma was
and drawing the neuron.

    python pipeline/fish1/hmi/build_morphology.py

WHAT THIS SHIPS, AND WHAT IT DOES NOT
-------------------------------------
It does NOT mirror the release. It fetches from the public bucket at build time
and writes a DECIMATED SUBSET as our own container, the same posture the project
already takes with the soma table:

  * level of detail 3 (the coarsest the release publishes), roughly 1,100
    vertices per cell instead of 138,000
  * only cells that carry the measured circuit - everything with traced
    connectivity, every spinal projection neuron, and a bounded sample of each
    remaining class
  * grouped into one mesh per published class, so the renderer draws the whole
    circuit in a handful of draw calls rather than one per neuron

Note on licensing: the release page states no explicit licence. The data is
published open access alongside the paper, and this pipeline redistributes only
a heavily decimated derivative with attribution and citation attached to the
artefact itself. Cite the paper for any use. See docs/DATA_SOURCES.md.

Coordinates: mesh vertices arrive in NANOMETRES. They are converted to the same
source voxel grid the soma positions use (8 x 8 x 30 nm), so morphology and soma
land in one space with no second transform to get wrong.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import struct
import sys
from collections import defaultdict
from datetime import datetime, timezone

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from fish1.common import CITATION  # noqa: E402

SEGMENTATION = (
    "precomputed://https://storage.googleapis.com/fish1-public/hindbrain_reconstructions"
)
SOURCE_URL = "gs://fish1-public/hindbrain_reconstructions/"
DATASET_ID = "fish1-hmi"
VERSION = "v1"
MAGIC = b"MOR1"

# The release publishes levels of detail 0..3. 3 is the coarsest and is what a
# whole-circuit view needs; the finest is 138k vertices for a single cell.
LOD = 3

# Source voxel size of the soma export, nanometres. Morphology is expressed in
# the same grid so both land in one space.
VOXEL_NM = (8.0, 8.0, 30.0)

# Per-class cap, so one populous class cannot dominate the artefact.
CLASS_CAP = 90


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=f"public/datasets/{DATASET_ID}")
    parser.add_argument("--lod", type=int, default=LOD)
    parser.add_argument("--cap", type=int, default=CLASS_CAP)
    return parser.parse_args()


def read_circuit(path: str) -> dict:
    """Decodes the HMI1 container written by build_hmi.py."""
    raw = open(path, "rb").read()
    assert raw[:4] == b"HMI1", "not an HMI1 container"
    length = struct.unpack("<I", raw[4:8])[0]
    descriptor = json.loads(raw[8 : 8 + length])
    offset = 8 + length
    if offset % 8:
        offset += 8 - offset % 8
    sizes = {"u8": 1, "u32": 4, "i32": 4, "f32": 4, "u64": 8}
    dtypes = {
        "u8": np.uint8,
        "u32": np.uint32,
        "i32": np.int32,
        "f32": np.float32,
        "u64": np.uint64,
    }
    lanes = {}
    for lane in descriptor["lanes"]:
        count = lane["count"]
        lanes[lane["name"]] = np.frombuffer(
            raw, dtype=dtypes[lane["type"]], count=count, offset=offset
        )
        offset += count * sizes[lane["type"]]
        if offset % 8:
            offset += 8 - offset % 8
    return {"descriptor": descriptor, "lanes": lanes}


def pad8(handle) -> None:
    remainder = handle.tell() % 8
    if remainder:
        handle.write(b"\0" * (8 - remainder))


def main() -> int:
    args = parse_args()
    from cloudvolume import CloudVolume

    circuit = read_circuit(f"{args.out}/{VERSION}/hmi.bin")
    lanes = circuit["lanes"]
    descriptor = circuit["descriptor"]
    class_order = descriptor["classOrder"]

    lore_ids = lanes["loreId"]
    class_indices = lanes["classIndex"]
    edge_pre = lanes["edgePre"]
    edge_post = lanes["edgePost"]

    # ------------------------------------------------------------- selection
    # Priority order, stated rather than arbitrary: cells that carry the
    # measured circuit come first, then breadth across the published classes.
    traced = set(int(i) for i in edge_pre) | set(int(i) for i in edge_post)
    spn_classes = {class_order.index(c) for c in ("SPN_turning", "SPN_forward", "SPN_other")}

    selected: dict[int, str] = {}
    per_class: defaultdict[str, int] = defaultdict(int)

    def consider(index: int, reason: str) -> None:
        if index in selected:
            return
        name = class_order[class_indices[index]]
        if per_class[name] >= args.cap:
            return
        selected[index] = reason
        per_class[name] += 1

    for index in range(len(lore_ids)):
        if class_indices[index] in spn_classes:
            consider(index, "spinal projection neuron")
    for index in sorted(traced):
        consider(index, "carries measured connectivity")
    for index in range(len(lore_ids)):
        consider(index, "class sample")

    print(f"Fish1 HMI morphology, level of detail {args.lod}")
    print(f"  {len(selected)} cells selected of {len(lore_ids)}")
    for name in class_order:
        if per_class[name]:
            print(f"    {name:14} {per_class[name]:4d}")

    # ---------------------------------------------------------------- fetch
    volume = CloudVolume(SEGMENTATION, use_https=True, progress=False)
    by_class: defaultdict[str, list] = defaultdict(list)
    missing: list[int] = []
    fetched = 0

    for n, index in enumerate(sorted(selected)):
        lore = int(lore_ids[index])
        name = class_order[class_indices[index]]
        try:
            mesh = volume.mesh.get(lore, lod=args.lod)
        except Exception:
            missing.append(lore)
            continue
        entry = list(mesh.values())[0]
        vertices = np.asarray(entry.vertices, dtype=np.float64)
        faces = np.asarray(entry.faces, dtype=np.uint32)
        if vertices.shape[0] == 0 or faces.shape[0] == 0:
            missing.append(lore)
            continue
        # Nanometres -> the soma export's source voxel grid.
        vertices[:, 0] /= VOXEL_NM[0]
        vertices[:, 1] /= VOXEL_NM[1]
        vertices[:, 2] /= VOXEL_NM[2]
        by_class[name].append((lore, vertices.astype(np.float32), faces))
        fetched += 1
        if (n + 1) % 25 == 0:
            print(f"    fetched {fetched}/{len(selected)}")

    print(f"  fetched {fetched}, missing {len(missing)}")

    # ---------------------------------------------------------------- write
    # One MOR1 container per class. Positions are quantised to 16 bits inside a
    # shared bounding box: at this level of detail that is far finer than the
    # reconstruction's own precision, and it halves the artefact.
    version_dir = os.path.join(args.out, VERSION, "morphology")
    os.makedirs(version_dir, exist_ok=True)
    files = {}
    totals = {"cells": 0, "vertices": 0, "triangles": 0, "bytes": 0}

    for name, entries in sorted(by_class.items()):
        if not entries:
            continue
        all_min = np.min([v.min(axis=0) for _l, v, _f in entries], axis=0)
        all_max = np.max([v.max(axis=0) for _l, v, _f in entries], axis=0)
        extent = np.maximum(all_max - all_min, 1e-6)

        positions = []
        indices = []
        cells = []
        vertex_base = 0
        index_base = 0
        for lore, vertices, faces in entries:
            quantised = np.round((vertices - all_min) / extent * 65535.0)
            positions.append(np.clip(quantised, 0, 65535).astype(np.uint16))
            indices.append((faces.reshape(-1) + vertex_base).astype(np.uint32))
            cells.append(
                {
                    "loreId": lore,
                    "firstIndex": index_base,
                    "indexCount": int(faces.size),
                    "firstVertex": vertex_base,
                    "vertexCount": int(vertices.shape[0]),
                }
            )
            vertex_base += vertices.shape[0]
            index_base += int(faces.size)

        position_lane = np.concatenate(positions).reshape(-1)
        index_lane = np.concatenate(indices)

        payload_descriptor = {
            "format": "MOR1",
            "dataset": DATASET_ID,
            "version": VERSION,
            "class": name,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "lod": args.lod,
            "cellCount": len(cells),
            "vertexCount": int(vertex_base),
            "triangleCount": int(index_lane.size // 3),
            "space": "fish1-source",
            "voxelSizeNm": list(VOXEL_NM),
            "quantization": {
                "bits": 16,
                "min": [float(v) for v in all_min],
                "extent": [float(v) for v in extent],
                "note": "position = min + code / 65535 * extent, in source voxels",
            },
            "cells": cells,
            "provenance": "measured",
            "source": SOURCE_URL,
            "citation": CITATION,
            "note": (
                "Decimated derivative of the published Fish1 hindbrain reconstructions. "
                "Level of detail 3 of 0-3; the release's own finest level is roughly 138,000 "
                "vertices per cell. Vertices are the reconstructed surface of real traced "
                "neurons, converted from nanometres into the source voxel grid."
            ),
            "lanes": [
                {"name": "position", "type": "u16", "count": int(position_lane.size)},
                {"name": "index", "type": "u32", "count": int(index_lane.size)},
            ],
        }

        buffer = io.BytesIO()
        descriptor_bytes = json.dumps(payload_descriptor, separators=(",", ":")).encode("utf-8")
        buffer.write(MAGIC)
        buffer.write(struct.pack("<I", len(descriptor_bytes)))
        buffer.write(descriptor_bytes)
        pad8(buffer)
        buffer.write(position_lane.tobytes())
        pad8(buffer)
        buffer.write(index_lane.tobytes())
        pad8(buffer)

        payload = buffer.getvalue()
        filename = f"{name.replace('-', '_')}.mor"
        with open(os.path.join(version_dir, filename), "wb") as handle:
            handle.write(payload)

        files[name] = {
            "file": f"/datasets/{DATASET_ID}/{VERSION}/morphology/{filename}",
            "cells": len(cells),
            "vertices": int(vertex_base),
            "triangles": int(index_lane.size // 3),
            "bytes": len(payload),
        }
        totals["cells"] += len(cells)
        totals["vertices"] += int(vertex_base)
        totals["triangles"] += int(index_lane.size // 3)
        totals["bytes"] += len(payload)
        print(
            f"    {name:14} {len(cells):4d} cells  {vertex_base:>8,} verts  "
            f"{index_lane.size // 3:>8,} tris  {len(payload) / 1024:>8.1f} KB"
        )

    manifest = {
        "dataset": DATASET_ID,
        "version": VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "lod": args.lod,
        "space": "fish1-source",
        "voxelSizeNm": list(VOXEL_NM),
        "totals": totals,
        "classes": files,
        "missing": missing,
        "provenance": "measured",
        "source": SOURCE_URL,
        "citation": CITATION,
        "note": (
            "Reconstructed surface morphology of real Fish1 neurons, decimated from the "
            "published multi-resolution meshes. Segment ids are the same stable cell ids "
            "used by the HMI circuit artefact, so a mesh here is the shape of a cell whose "
            "measured connectivity drives the simulation."
        ),
    }
    manifest_path = os.path.join(args.out, VERSION, "morphology", "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)

    print(
        f"\n  total {totals['cells']} cells, {totals['vertices']:,} vertices, "
        f"{totals['triangles']:,} triangles, {totals['bytes'] / (1024 * 1024):.2f} MB"
    )
    print(f"  wrote {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
