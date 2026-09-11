#!/usr/bin/env python3
"""Validate an exported neuron index.

Run after every export. Checks the things that would otherwise produce a brain
that looks plausible and is wrong:

  - container header, descriptor, lane lengths, alignment
  - manifest agrees with the binary (count, dataset, checksum)
  - lore IDs are unique and non-zero
  - coordinates are finite and within a sane range
  - the population is not degenerate (all cells at one point)

    python pipeline/fish1/validate.py public/datasets/fish1
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fish1.neuron_index import fnv1a32, read_lane, validate_container  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", help="Directory containing manifest.json")
    args = parser.parse_args()

    manifest_path = os.path.join(args.directory, "manifest.json")
    if not os.path.exists(manifest_path):
        print(f"No manifest at {manifest_path}", file=sys.stderr)
        return 1

    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)

    relative = manifest["files"]["neuronIndex"]
    local = relative.split(f"/datasets/{manifest['dataset']}/", 1)[-1]
    bin_path = os.path.join(args.directory, local)
    if not os.path.exists(bin_path):
        print(f"Manifest points at {relative}, but {bin_path} does not exist.", file=sys.stderr)
        return 1

    with open(bin_path, "rb") as handle:
        data = handle.read()

    failures: list[str] = []
    warnings: list[str] = []

    try:
        desc = validate_container(data)
    except ValueError as exc:
        print(f"FAIL container: {exc}", file=sys.stderr)
        return 1
    print(f"ok   container    {desc['format']} v{desc['formatVersion']}")

    if desc["datasetId"] != manifest["dataset"]:
        failures.append(
            f"binary declares dataset {desc['datasetId']}, manifest says {manifest['dataset']}"
        )
    if desc["count"] != manifest["neuronCount"]:
        failures.append(
            f"binary holds {desc['count']} neurons, manifest promises {manifest['neuronCount']}"
        )
    print(f"ok   count        {desc['count']:,}")

    declared = manifest.get("checksums", {}).get("neuronIndex")
    if declared:
        actual = f"fnv1a32:{fnv1a32(data):08x}"
        if actual != declared:
            failures.append(f"checksum mismatch: {actual} vs manifest {declared}")
        else:
            print(f"ok   checksum     {actual}")

    lore = read_lane(data, desc, "loreIds")
    positions = read_lane(data, desc, "positionsVoxel")
    cell_types = read_lane(data, desc, "cellTypes")
    assert lore is not None and positions is not None and cell_types is not None

    unique = np.unique(lore)
    if unique.size != lore.size:
        failures.append(f"lore IDs are not unique: {lore.size - unique.size} duplicates")
    else:
        print("ok   lore ids     unique")

    if (lore == 0).any():
        warnings.append(f"{int((lore == 0).sum())} neurons have lore ID 0")

    if not np.isfinite(positions).all():
        failures.append("positions contain non-finite values")

    span = positions.max(axis=0) - positions.min(axis=0)
    if (span == 0).any():
        failures.append(f"population is degenerate along an axis (voxel span {span.tolist()})")
    else:
        voxel_nm = desc["voxelSpace"]["voxelSizeNm"]
        extent_um = [float(span[i] * voxel_nm[i] / 1000.0) for i in range(3)]
        print(
            "ok   extent       "
            + " x ".join(f"{v:.0f}" for v in extent_um)
            + " um"
        )
        # A larval zebrafish brain is on the order of hundreds of micrometres.
        # Far outside that usually means the voxel size is wrong.
        if max(extent_um) > 20000 or max(extent_um) < 20:
            warnings.append(
                f"extent {extent_um} um is implausible for a larval zebrafish brain; "
                "check voxelSizeNm"
            )

    valid_codes = set(range(5))
    bad = sorted(set(np.unique(cell_types).tolist()) - valid_codes)
    if bad:
        failures.append(f"unknown cell-type codes present: {bad}")
    else:
        counts = {int(c): int((cell_types == c).sum()) for c in np.unique(cell_types)}
        print(f"ok   cell types   {counts}")

    print()
    for warning in warnings:
        print(f"WARN {warning}")
    for failure in failures:
        print(f"FAIL {failure}", file=sys.stderr)

    if failures:
        print(f"\n{len(failures)} check(s) failed.", file=sys.stderr)
        return 1
    print(f"\nAll checks passed ({len(warnings)} warning(s)).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
