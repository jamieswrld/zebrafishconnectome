#!/usr/bin/env python3
"""Download one neuron's skeleton as SWC.

Morphology is fetched one neuron at a time, on demand. There is deliberately no
bulk mode: downloading 180,000 skeletons would be enormous, slow, and useless,
since the viewer only ever draws a handful at once.

    python pipeline/fish1/export_skeleton.py --lore-id 173502 --out data/skeletons
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fish1.common import DATASTACK, LOCAL_URL, TABLE_SOMAS, connect  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lore-id", required=True, help="Stable soma identifier")
    parser.add_argument("--out", default="data/skeletons", help="Output directory")
    args = parser.parse_args()

    try:
        from cloudvolume import CloudVolume
    except ImportError as exc:
        raise SystemExit("cloud-volume is not installed; see pipeline/requirements.txt") from exc

    clients = connect()
    rows = clients.client.materialize.tables.somas(id=args.lore_id).query()
    if len(rows) == 0:
        print(f"No soma with lore ID {args.lore_id}.", file=sys.stderr)
        return 1

    root_id = int(rows.iloc[0]["pt_root_id"])
    print(f"lore {args.lore_id} -> root {root_id}")

    # A root ID from a materialized table can be stale relative to live
    # proofreading; say so rather than silently fetching the wrong morphology.
    if not clients.cggraph.is_latest_roots([root_id]):
        latest = clients.cggraph.get_latest_roots(root_id)
        print(f"  NOTE: root was edited; latest is {latest}")
        root_id = int(latest[0]) if hasattr(latest, "__len__") else int(latest)

    skeleton_volume = CloudVolume(
        f"precomputed://middleauth+{LOCAL_URL}/skeletoncache/api/v1/{DATASTACK}/precomputed/"
    )
    skeleton = skeleton_volume.skeleton.get(root_id)

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, f"skeleton_{args.lore_id}_{root_id}.swc")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(f"# Fish1 skeleton, lore {args.lore_id}, root {root_id}\n")
        handle.write(f"# {TABLE_SOMAS} materialization {clients.materialization_version}\n")
        handle.write(skeleton.to_swc())

    print(f"  vertices {len(skeleton.vertices):,}")
    print(f"  wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
