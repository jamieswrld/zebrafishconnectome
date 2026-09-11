#!/usr/bin/env python3
"""Report what the Fish1 deployment actually exposes.

Run this first. It answers, with real values rather than assumptions:
  - does the saved CAVE token work?
  - which materialization version is current?
  - which annotation tables exist?
  - what are the soma table's columns and a sample row?

    python pipeline/fish1/fetch_metadata.py
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fish1.common import DATASTACK, GLOBAL_URL, TABLE_SOMAS, connect  # noqa: E402


def main() -> int:
    print(f"server     {GLOBAL_URL}")
    print(f"datastack  {DATASTACK}")
    clients = connect()
    print(f"version    {clients.materialization_version}")
    print()

    tables = clients.client.annotation.get_tables()
    print(f"tables ({len(tables)}):")
    for name in sorted(tables):
        print(f"  {name}")
    print()

    try:
        meta = clients.client.annotation.get_table_metadata(TABLE_SOMAS)
        print(f"{TABLE_SOMAS} metadata:")
        for key in ("description", "schema", "voxel_resolution", "reference_table"):
            if key in meta:
                print(f"  {key}: {meta[key]}")
        print()
    except Exception as exc:
        print(f"  could not read {TABLE_SOMAS} metadata: {exc}")

    sample = clients.client.materialize.query_table(
        TABLE_SOMAS, limit=5, split_positions=True
    )
    print(f"{TABLE_SOMAS} columns: {list(sample.columns)}")
    print()
    print(sample.to_string())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
