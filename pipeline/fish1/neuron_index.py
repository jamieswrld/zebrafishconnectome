"""Writer for the CLN1 neuron-index container.

This is the Python counterpart of src/core/binary.ts and MUST stay byte
compatible with it. The layout is:

    [0..4)      magic b"CLN1"
    [4..8)      uint32 little-endian JSON descriptor length
    [8..8+n)    UTF-8 JSON descriptor
    padding     to the next 8-byte boundary
    lanes       in descriptor order, each 8-byte aligned

Only SOURCE voxel coordinates are written. Micrometre positions are derived in
the browser from the declared voxel size, so the published coordinate stays the
single source of truth and the two can never disagree.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from typing import Any, Optional

import numpy as np

MAGIC = b"CLN1"
FORMAT_VERSION = 1

_LANE_DTYPES = {
    "int32": np.int32,
    "uint32": np.uint32,
    "uint16": np.uint16,
    "uint8": np.uint8,
    "float32": np.float32,
    "uint64": np.uint64,
}

_BYTES_PER_ELEMENT = {
    "int32": 4,
    "uint32": 4,
    "uint16": 2,
    "uint8": 1,
    "float32": 4,
    "uint64": 8,
}


def _align8(n: int) -> int:
    return (n + 7) & ~7


@dataclass
class Lane:
    name: str
    lane_type: str
    components: int
    array: np.ndarray


def fnv1a32(data: bytes) -> int:
    """Matches fnv1a32 in src/core/binary.ts."""
    h = 0x811C9DC5
    for byte in data:
        h ^= byte
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def build_neuron_index(
    *,
    dataset_id: str,
    origin: str,
    count: int,
    version: dict[str, Any],
    voxel_space: dict[str, Any],
    position_provenance: str,
    regions: list[dict[str, Any]],
    positions_voxel: np.ndarray,
    lore_ids: np.ndarray,
    cell_types: np.ndarray,
    region_ids: Optional[np.ndarray] = None,
    flags: Optional[np.ndarray] = None,
    root_ids: Optional[np.ndarray] = None,
) -> bytes:
    """Serialises a population into the CLN1 container."""

    lanes: list[Lane] = [
        Lane("positionsVoxel", "int32", 3, np.ascontiguousarray(positions_voxel, dtype=np.int32)),
        Lane("loreIds", "uint32", 1, np.ascontiguousarray(lore_ids, dtype=np.uint32)),
        Lane("cellTypes", "uint8", 1, np.ascontiguousarray(cell_types, dtype=np.uint8)),
    ]
    if region_ids is not None:
        lanes.append(Lane("regionIds", "uint16", 1, np.ascontiguousarray(region_ids, dtype=np.uint16)))
    if flags is not None:
        lanes.append(Lane("flags", "uint8", 1, np.ascontiguousarray(flags, dtype=np.uint8)))
    if root_ids is not None:
        lanes.append(Lane("rootIds", "uint64", 1, np.ascontiguousarray(root_ids, dtype=np.uint64)))

    for lane in lanes:
        expected = count * lane.components
        if lane.array.size != expected:
            raise ValueError(
                f'Lane "{lane.name}" has {lane.array.size} values, expected {expected} '
                f"for {count} neurons."
            )

    def descriptor(lane_descriptors: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "format": "connectome-lab/neuron-index",
            "formatVersion": FORMAT_VERSION,
            "datasetId": dataset_id,
            "origin": origin,
            "count": count,
            "version": version,
            "voxelSpace": voxel_space,
            "positionProvenance": position_provenance,
            "lanes": lane_descriptors,
            "regions": regions,
        }

    # Two passes, exactly as the TypeScript encoder does: the descriptor holds
    # byte offsets, but its own encoded length shifts them. Probe with wide
    # placeholders so the digit count cannot grow on the real pass.
    probe_lanes = [
        {
            "name": lane.name,
            "type": lane.lane_type,
            "components": lane.components,
            "byteOffset": 9999999999,
            "byteLength": 9999999999,
        }
        for lane in lanes
    ]
    probe = json.dumps(descriptor(probe_lanes), separators=(",", ":")).encode("utf-8")
    data_start = _align8(8 + len(probe))

    lane_descriptors: list[dict[str, Any]] = []
    cursor = data_start
    for lane in lanes:
        cursor = _align8(cursor)
        byte_length = lane.array.size * _BYTES_PER_ELEMENT[lane.lane_type]
        lane_descriptors.append(
            {
                "name": lane.name,
                "type": lane.lane_type,
                "components": lane.components,
                "byteOffset": cursor,
                "byteLength": byte_length,
            }
        )
        cursor += byte_length
    total = _align8(cursor)

    payload = json.dumps(descriptor(lane_descriptors), separators=(",", ":")).encode("utf-8")
    if 8 + len(payload) > data_start:
        raise RuntimeError("Descriptor grew between encoding passes.")

    buffer = bytearray(total)
    buffer[0:4] = MAGIC
    struct.pack_into("<I", buffer, 4, len(payload))
    buffer[8 : 8 + len(payload)] = payload

    for lane, desc in zip(lanes, lane_descriptors):
        start = desc["byteOffset"]
        # Force little-endian on write: the browser decoder reads LE views.
        arr = lane.array.astype(_LANE_DTYPES[lane.lane_type].__name__, copy=False)
        raw = arr.astype(arr.dtype.newbyteorder("<"), copy=False).tobytes()
        buffer[start : start + len(raw)] = raw

    return bytes(buffer)


def validate_container(data: bytes) -> dict[str, Any]:
    """Re-reads a container and checks every invariant the browser checks."""
    if len(data) < 8:
        raise ValueError("Container shorter than its header.")
    if data[0:4] != MAGIC:
        raise ValueError(f"Bad magic {data[0:4]!r}; expected {MAGIC!r}.")

    (json_length,) = struct.unpack_from("<I", data, 4)
    if 8 + json_length > len(data):
        raise ValueError("Descriptor length exceeds file size.")

    desc = json.loads(data[8 : 8 + json_length].decode("utf-8"))
    if desc["format"] != "connectome-lab/neuron-index":
        raise ValueError(f'Unknown format "{desc["format"]}".')
    if desc["formatVersion"] != FORMAT_VERSION:
        raise ValueError(f"Unsupported format version {desc['formatVersion']}.")

    count = desc["count"]
    names = {lane["name"] for lane in desc["lanes"]}
    for required in ("positionsVoxel", "loreIds", "cellTypes"):
        if required not in names:
            raise ValueError(f'Missing required lane "{required}".')

    for lane in desc["lanes"]:
        expected = count * lane["components"] * _BYTES_PER_ELEMENT[lane["type"]]
        if lane["byteLength"] != expected:
            raise ValueError(
                f'Lane "{lane["name"]}" declares {lane["byteLength"]} bytes, needs {expected}.'
            )
        if lane["byteOffset"] + lane["byteLength"] > len(data):
            raise ValueError(f'Lane "{lane["name"]}" extends past end of file.')
        if lane["byteOffset"] % _BYTES_PER_ELEMENT[lane["type"]] != 0:
            raise ValueError(f'Lane "{lane["name"]}" is misaligned.')

    return desc


def read_lane(data: bytes, desc: dict[str, Any], name: str) -> Optional[np.ndarray]:
    for lane in desc["lanes"]:
        if lane["name"] != name:
            continue
        dtype = np.dtype(_LANE_DTYPES[lane["type"]]).newbyteorder("<")
        arr = np.frombuffer(
            data,
            dtype=dtype,
            count=desc["count"] * lane["components"],
            offset=lane["byteOffset"],
        )
        return arr.reshape(desc["count"], lane["components"]) if lane["components"] > 1 else arr
    return None
