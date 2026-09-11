#!/usr/bin/env python3
"""Export the Fish1 soma table to a web-optimised binary neuron index.

This is the step that turns 180,000+ published soma into the single ~4 MB
binary the browser downloads once. It never runs at request time.

Usage
-----
    python pipeline/fish1/export_neurons.py --out public/datasets/fish1

Requires a saved CAVE token; see pipeline/fish1/common.py::connect.

Output
------
    <out>/<version>/neurons.bin     CLN1 container
    <out>/manifest.json             version-addressed paths + checksums

The manifest points at the versioned directory, so a new materialization
produces new URLs and the old binaries remain safely cacheable forever.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fish1.common import (  # noqa: E402
    CITATION,
    FLAG_ANNOTATED,
    TABLE_SOMAS,
    VOXEL_SPACE,
    connect,
    map_cell_type,
    version_block,
)
from fish1.neuron_index import build_neuron_index, fnv1a32, validate_container  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        default="public/datasets/fish1",
        help="Output directory (default: public/datasets/fish1)",
    )
    parser.add_argument(
        "--materialization",
        type=int,
        default=None,
        help="Pin a materialization version. Default: the most recent.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Export only the first N soma. For testing the pipeline, not for release.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    clients = connect(args.materialization)
    version = clients.materialization_version
    print(f"Connected. Materialization version: {version}")

    print(f"Querying {TABLE_SOMAS} ...")
    # split_positions gives pt_position_x/y/z as plain integer columns, which
    # avoids any ambiguity about how a geometry column was serialised.
    frame = clients.client.materialize.query_table(
        TABLE_SOMAS,
        split_positions=True,
        limit=args.limit,
    )
    print(f"  {len(frame):,} rows")

    if len(frame) == 0:
        print("No soma rows returned. Refusing to write an empty index.", file=sys.stderr)
        return 1

    required = ["id", "cell_type", "pt_position_x", "pt_position_y", "pt_position_z"]
    missing = [c for c in required if c not in frame.columns]
    if missing:
        print(f"Soma table is missing expected columns: {missing}", file=sys.stderr)
        print(f"Columns present: {list(frame.columns)}", file=sys.stderr)
        return 1

    # Drop rows we cannot place. A neuron with no coordinate cannot be drawn,
    # and silently mapping it to the origin would put a fake cell in the brain.
    before = len(frame)
    frame = frame.dropna(subset=["pt_position_x", "pt_position_y", "pt_position_z", "id"])
    dropped = before - len(frame)
    if dropped:
        print(f"  dropped {dropped:,} rows with missing id or position")

    count = len(frame)

    positions = np.empty((count, 3), dtype=np.int32)
    positions[:, 0] = frame["pt_position_x"].to_numpy(dtype=np.int64)
    positions[:, 1] = frame["pt_position_y"].to_numpy(dtype=np.int64)
    positions[:, 2] = frame["pt_position_z"].to_numpy(dtype=np.int64)

    lore_raw = frame["id"].to_numpy(dtype=np.int64)
    if lore_raw.min() < 0 or lore_raw.max() > np.iinfo(np.uint32).max:
        print(
            f"Lore IDs fall outside uint32 (min={lore_raw.min()}, max={lore_raw.max()}). "
            "The binary format needs widening before this dataset can be exported.",
            file=sys.stderr,
        )
        return 1
    lore_ids = lore_raw.astype(np.uint32)

    cell_types = np.array(
        [map_cell_type(v) for v in frame["cell_type"].tolist()], dtype=np.uint8
    )

    flags = np.zeros(count, dtype=np.uint8)
    flags[cell_types != 0] |= FLAG_ANNOTATED

    # Regions are not exported: Fish1 does not publish a region assignment for
    # every soma, and assigning one from position alone would be an invented
    # anatomical claim. 0xffff marks "unassigned" in the format.
    region_ids = np.full(count, 0xFFFF, dtype=np.uint16)

    root_ids = None
    if "pt_root_id" in frame.columns:
        # Root IDs are mutable and only valid for this materialization; they are
        # carried for reference, never as the neuron's identity.
        root_ids = frame["pt_root_id"].fillna(0).to_numpy(dtype=np.uint64)

    generated_at = datetime.now(timezone.utc).isoformat()
    container = build_neuron_index(
        dataset_id="fish1",
        origin="preprocessed-export",
        count=count,
        version=version_block(version, generated_at),
        voxel_space=VOXEL_SPACE,
        position_provenance="measured",
        regions=[],
        positions_voxel=positions,
        lore_ids=lore_ids,
        cell_types=cell_types,
        region_ids=region_ids,
        flags=flags,
        root_ids=root_ids,
    )

    # Round-trip before writing: a corrupt index that renders anyway is the
    # worst failure mode this application has.
    descriptor = validate_container(container)
    assert descriptor["count"] == count

    version_dir = os.path.join(args.out, f"v{version}")
    os.makedirs(version_dir, exist_ok=True)
    bin_path = os.path.join(version_dir, "neurons.bin")
    with open(bin_path, "wb") as handle:
        handle.write(container)

    checksum = f"{fnv1a32(container):08x}"
    manifest = {
        "dataset": "fish1",
        "version": f"v{version}",
        "materializationVersion": version,
        "generatedAt": generated_at,
        "neuronCount": count,
        "files": {
            # Served path, not a filesystem path.
            "neuronIndex": f"/datasets/fish1/v{version}/neurons.bin",
        },
        "bytes": {"neuronIndex": len(container)},
        "checksums": {"neuronIndex": f"fnv1a32:{checksum}"},
        "notes": (
            f"Exported from CAVE datastack, materialization {version}. "
            f"Positions are source voxel coordinates at "
            f"{'x'.join(str(v) for v in VOXEL_SPACE['voxelSizeNm'])} nm. {CITATION}"
        ),
    }
    manifest_path = os.path.join(args.out, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)

    by_type = {name: int((cell_types == code).sum()) for name, code in
               (("unknown", 0), ("excitatory", 1), ("inhibitory", 2))}

    print()
    print(f"  neurons      {count:,}")
    print(f"  excitatory   {by_type['excitatory']:,}")
    print(f"  inhibitory   {by_type['inhibitory']:,}")
    print(f"  unannotated  {by_type['unknown']:,}")
    print(f"  bytes        {len(container):,} ({len(container) / 1024 / 1024:.2f} MB)")
    print(f"  checksum     fnv1a32:{checksum}")
    print()
    print(f"  wrote {bin_path}")
    print(f"  wrote {manifest_path}")
    print()
    print("Reload /brain?dataset=fish1 to use it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
