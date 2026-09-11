#!/usr/bin/env python3
"""Export aggregated connectivity for a set of neurons.

Aggregates the ~30M-synapse table down to one row per CONNECTED PAIR. That is
the representation the application and any future simulation actually need: a
weighted, signed adjacency, not 30 million individual synapse records.

    python pipeline/fish1/export_connectivity.py --lore-ids 173502 --out data/connectivity
    python pipeline/fish1/export_connectivity.py --from-index public/datasets/fish1 --limit 500

Output is CSV plus a CSR-style .npz, which is directly loadable by the future
simulation kernel (see src/simulation/types.ts::SparseConnectivity).
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fish1.common import TABLE_SOMAS, TABLE_SYNAPSES_LABEL, connect  # noqa: E402

# synapses_axde_label.tag is a STRING: '1' inhibitory, '2' excitatory.
TAG_INHIBITORY = "1"
TAG_EXCITATORY = "2"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--lore-ids", nargs="+", help="Explicit lore IDs to export")
    source.add_argument(
        "--from-index",
        help="Directory holding a manifest.json; exports neurons from that export",
    )
    parser.add_argument("--limit", type=int, default=100, help="Cap when using --from-index")
    parser.add_argument("--out", default="data/connectivity", help="Output directory")
    parser.add_argument(
        "--min-synapses",
        type=int,
        default=1,
        help="Drop pairs below this synapse count (default 1, i.e. keep all)",
    )
    return parser.parse_args()


def load_lore_ids_from_index(directory: str, limit: int) -> list[str]:
    import json

    from fish1.neuron_index import read_lane, validate_container

    with open(os.path.join(directory, "manifest.json"), encoding="utf-8") as handle:
        manifest = json.load(handle)

    # manifest paths are served paths; map back onto the local directory.
    relative = manifest["files"]["neuronIndex"].split("/datasets/fish1/", 1)[-1]
    with open(os.path.join(directory, relative), "rb") as handle:
        data = handle.read()

    desc = validate_container(data)
    lore = read_lane(data, desc, "loreIds")
    assert lore is not None
    return [str(int(v)) for v in lore[:limit]]


def main() -> int:
    args = parse_args()
    clients = connect()
    version = clients.materialization_version

    if args.lore_ids:
        lore_ids = list(args.lore_ids)
    else:
        lore_ids = load_lore_ids_from_index(args.from_index, args.limit)
    print(f"Exporting connectivity for {len(lore_ids):,} neurons (mat {version})")

    soma = clients.client.materialize.query_table(
        TABLE_SOMAS,
        filter_in_dict={"id": [int(v) for v in lore_ids]},
        select_columns=["id", "pt_root_id"],
    )
    root_to_lore = {int(r.pt_root_id): int(r.id) for r in soma.itertuples()}
    print(f"  resolved {len(root_to_lore):,} root IDs")

    # (pre_root, post_root) -> [total, excitatory, inhibitory]
    pairs: dict[tuple[int, int], list[int]] = defaultdict(lambda: [0, 0, 0])

    for n, (root_id, lore_id) in enumerate(root_to_lore.items(), start=1):
        for direction, column in (
            ("outgoing", "pre_pt_root_id"),
            ("incoming", "post_pt_root_id"),
        ):
            frame = clients.client.materialize.query_table(
                TABLE_SYNAPSES_LABEL,
                filter_equal_dict={column: root_id},
                select_columns=["pre_pt_root_id", "post_pt_root_id", "tag"],
            )
            for row in frame.itertuples():
                key = (int(row.pre_pt_root_id), int(row.post_pt_root_id))
                entry = pairs[key]
                entry[0] += 1
                tag = str(row.tag)
                if tag == TAG_EXCITATORY:
                    entry[1] += 1
                elif tag == TAG_INHIBITORY:
                    entry[2] += 1
        if n % 25 == 0:
            print(f"  {n:,}/{len(root_to_lore):,} neurons, {len(pairs):,} pairs")

    kept = {k: v for k, v in pairs.items() if v[0] >= args.min_synapses}
    print(f"  {len(kept):,} pairs at >= {args.min_synapses} synapses")

    os.makedirs(args.out, exist_ok=True)
    csv_path = os.path.join(args.out, f"connectivity_mat{version}.csv")
    with open(csv_path, "w", encoding="utf-8") as handle:
        handle.write(f"# Fish1 aggregated connectivity, materialization {version}\n")
        handle.write("# one row per connected pair; synapse counts aggregated\n")
        handle.write(
            "pre_root_id,post_root_id,pre_lore_id,post_lore_id,"
            "synapses,excitatory,inhibitory\n"
        )
        for (pre, post), (total, exc, inh) in sorted(kept.items(), key=lambda kv: -kv[1][0]):
            handle.write(
                f"{pre},{post},{root_to_lore.get(pre, '')},{root_to_lore.get(post, '')},"
                f"{total},{exc},{inh}\n"
            )

    # CSR form, keyed by presynaptic root ID, for the simulation kernel.
    nodes = sorted({pre for pre, _ in kept} | {post for _, post in kept})
    node_index = {node: i for i, node in enumerate(nodes)}
    by_source: dict[int, list[tuple[int, int, int]]] = defaultdict(list)
    for (pre, post), (total, exc, inh) in kept.items():
        sign = 1 if exc > inh else (-1 if inh > exc else 0)
        by_source[node_index[pre]].append((node_index[post], total, sign))

    offsets = np.zeros(len(nodes) + 1, dtype=np.uint32)
    targets: list[int] = []
    weights: list[int] = []
    signs: list[int] = []
    for i in range(len(nodes)):
        edges = sorted(by_source.get(i, []), key=lambda e: -e[1])
        for target, weight, sign in edges:
            targets.append(target)
            weights.append(weight)
            signs.append(sign)
        offsets[i + 1] = len(targets)

    npz_path = os.path.join(args.out, f"connectivity_mat{version}.npz")
    np.savez_compressed(
        npz_path,
        root_ids=np.array(nodes, dtype=np.uint64),
        offsets=offsets,
        targets=np.array(targets, dtype=np.uint32),
        weights=np.array(weights, dtype=np.float32),
        signs=np.array(signs, dtype=np.int8),
        materialization=np.array([version], dtype=np.int64),
    )

    print(f"  wrote {csv_path}")
    print(f"  wrote {npz_path}  ({len(nodes):,} nodes, {len(targets):,} edges)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
