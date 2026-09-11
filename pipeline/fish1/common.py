"""Shared Fish1 pipeline configuration and CAVE connection.

Every constant here is taken verbatim from the official Fish1 release material:
  https://fish1-release.storage.googleapis.com/programmatic.html
  https://fish1-release.storage.googleapis.com/paper_data/ProgrammaticInteractionWithFish1Cave.ipynb

Nothing in this pipeline runs in the browser. It produces static, version
addressed artefacts that the web application then serves.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Optional

GLOBAL_URL = os.environ.get("CAVE_GLOBAL_URL", "https://global.brain-wire-test.org/")
LOCAL_URL = os.environ.get("CAVE_LOCAL_URL", "https://pcgv3local.brain-wire-test.org")
DATASTACK = os.environ.get("FISH1_DATASTACK", "fish1_full")
PCG_TABLE = os.environ.get("FISH1_PCG_TABLE", "fish1_v250915")

TABLE_SOMAS = "somas"
TABLE_SYNAPSES_LABEL = "synapses_axde_label"
TABLE_SYNAPSE_SIZE = "synapses_axon_to_dendrite_size"

# Soma pt_position is published in voxels at 16 x 16 x 30 nm.
#
# Note the documented inconsistency: the official notebook's coordinate-lookup
# helper defaults to (8, 8, 30) for CloudVolume point lookups, which is the
# segmentation's own mip-0 grid, while the somas table column reference states
# 16 x 16 x 30 nm for pt_position. We use the soma-table value and keep it in
# one place so a correction upstream is a one-line change.
VOXEL_SIZE_NM = (16.0, 16.0, 30.0)

VOXEL_SPACE: dict[str, Any] = {
    "voxelSizeNm": list(VOXEL_SIZE_NM),
    "axisOrder": "xyz",
    # Omitted deliberately: the release does not state which anatomical
    # direction each axis increases in. Guessing would turn a rendering
    # convention into a false anatomical claim.
}

# Matches CELL_TYPE_CODE in src/core/types.ts. Renumbering is a breaking change.
CELL_TYPE_CODE = {
    "unknown": 0,
    "excitatory": 1,
    "inhibitory": 2,
    "modulatory": 3,
    "non-neuronal": 4,
}

# Matches NEURON_FLAG in src/core/types.ts.
FLAG_HAS_SKELETON = 1 << 0
FLAG_PROOFREAD = 1 << 1
FLAG_ANNOTATED = 1 << 2
FLAG_HAS_ACTIVITY = 1 << 3
FLAG_OUT_OF_BOUNDS = 1 << 4

CITATION = (
    "Petkova, M. D., Januszewski, M., et al. (2025). A connectomic resource for "
    "neural cataloguing and circuit dissection of the larval zebrafish brain. bioRxiv."
)


def map_cell_type(raw: Any) -> int:
    """Maps the dataset-native cell_type string to our compact code.

    "na" means NOT ANNOTATED. It is not a claim that the cell is neither
    excitatory nor inhibitory, so it maps to `unknown`.
    """
    if raw == "exc":
        return CELL_TYPE_CODE["excitatory"]
    if raw == "inh":
        return CELL_TYPE_CODE["inhibitory"]
    return CELL_TYPE_CODE["unknown"]


@dataclass
class Fish1Clients:
    client: Any
    cggraph: Any
    materialization_version: int


def connect(materialization_version: Optional[int] = None) -> Fish1Clients:
    """Connects to the Fish1 CAVE deployment.

    Authentication follows the official instructions: obtain a token from
      {GLOBAL_URL}/sticky_auth/settings/tokens
    then store it with

        import caveclient
        auth = caveclient.auth.AuthClient(server_address="%s")
        auth.save_token(token="YOUR_TOKEN_HERE", overwrite=True)

    which writes ~/.cloudvolume/secrets/cave-secret.json. The token is a
    personal credential: never commit it, and never pass it to the web app.
    """ % GLOBAL_URL

    try:
        import caveclient
        from caveclient import CAVEclient, chunkedgraph as cg
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise SystemExit(
            "caveclient is not installed. Run:  pip install -r pipeline/requirements.txt"
        ) from exc

    try:
        client = CAVEclient(datastack_name=DATASTACK, server_address=GLOBAL_URL)
    except Exception as exc:  # pragma: no cover - network dependent
        raise SystemExit(
            f"Could not connect to {GLOBAL_URL} as datastack {DATASTACK}.\n"
            f"  {exc}\n"
            "Check that a CAVE token is saved (see the docstring of connect())."
        ) from exc

    version = materialization_version or client.materialize.most_recent_version()
    client.materialize.version = version

    cggraph = cg.ChunkedGraphClient(
        server_address=LOCAL_URL,
        table_name=PCG_TABLE,
        auth_client=caveclient.auth.AuthClient(token=client.auth.token),
    )

    return Fish1Clients(client=client, cggraph=cggraph, materialization_version=version)


def version_block(materialization_version: int, generated_at: str) -> dict[str, Any]:
    return {
        "materializationVersion": materialization_version,
        "segmentationTable": PCG_TABLE,
        "generatedAt": generated_at,
        "label": f"mat {materialization_version}",
    }
