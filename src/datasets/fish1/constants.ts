import type { VoxelSpace } from '@/core/coords';
import type { DatasetCitation } from '@/core/types';

/**
 * Fish1 dataset constants.
 *
 * EVERY value in this file is taken verbatim from the official Fish1 release
 * material, not inferred:
 *   - https://fish1-release.storage.googleapis.com/programmatic.html
 *   - https://fish1-release.storage.googleapis.com/paper_data/ProgrammaticInteractionWithFish1Cave.ipynb
 *   - https://fish1-release.storage.googleapis.com/data_policy.html
 *
 * If any of these change upstream, they change here - nothing else in the
 * application hardcodes a Fish1 identifier.
 */

export const FISH1_DATASET_ID = 'fish1';

/** CAVE global (auth + info) server. */
export const DEFAULT_CAVE_GLOBAL_URL = 'https://global.brain-wire-test.org';

/**
 * Deployment-local server hosting the chunked graph and the skeleton cache.
 * The info service also reports this as the datastack's local server; the env
 * value is a fallback for when discovery fails.
 */
export const DEFAULT_CAVE_LOCAL_URL = 'https://pcgv3local.brain-wire-test.org';

export const DEFAULT_DATASTACK = 'fish1_full';

/** PyChunkedGraph segmentation table backing the datastack. */
export const DEFAULT_PCG_TABLE = 'fish1_v250915';

/** Where a user obtains a token. Shown verbatim in the setup instructions. */
export const CAVE_TOKEN_SETTINGS_PATH = '/sticky_auth/settings/tokens';

/**
 * Annotation tables, as returned by `client.annotation.get_tables()` in the
 * official notebook.
 */
export const FISH1_TABLES = {
  /** One row per segmented soma. `id` is the stable lore ID. */
  somas: 'somas',
  /** Axon-to-dendrite synapses with an excitatory/inhibitory tag. */
  synapsesAxDeLabel: 'synapses_axde_label',
  /** Axon-to-dendrite synapses (untagged). */
  synapsesAxDe: 'synapses_axde',
  /** Axon-to-axon synapses. */
  synapsesAxAx: 'synapses_axax',
  /** Presynaptic site IDs for axon-to-dendrite synapses. */
  synapsesAxDePreSiteId: 'synapses_axde_pre_synapse_id',
  /** Postsynaptic site IDs for axon-to-dendrite synapses. */
  synapsesAxDePostSiteId: 'synapses_axde_post_synapse_id',
  /** Per-synapse bounding boxes, for size filtering. */
  synapseSize: 'synapses_axon_to_dendrite_size',
  nucleus: 'nucleus_table',
  somaDistanceToLandmark: 'somas_distance_to_landmark',
} as const;

/**
 * Columns of the `somas` table, documented in the official release.
 *
 *   id               stable lore ID
 *   cell_type        "exc" | "inh" | "na"
 *   pt_root_id       current root ID (changes after proofreading)
 *   pt_supervoxel_id supervoxel at the soma location
 *   pt_position      [x, y, z] voxel coordinates (see FISH1_VOXEL_SPACE:
 *                    the data is in the 8 x 8 x 30 nm grid, not 16 x 16 x 30)
 *   created          annotation timestamp
 */
export const SOMA_COLUMNS = {
  loreId: 'id',
  cellType: 'cell_type',
  rootId: 'pt_root_id',
  supervoxelId: 'pt_supervoxel_id',
  position: 'pt_position',
  created: 'created',
} as const;

/**
 * `synapses_axde_label.tag` encodes synapse polarity as a STRING:
 *   '1' = inhibitory, '2' = excitatory
 * Documented in the official notebook, section 6.
 */
export const SYNAPSE_TAG = {
  inhibitory: '1',
  excitatory: '2',
} as const;

export const SYNAPSE_COLUMNS = {
  preRootId: 'pre_pt_root_id',
  postRootId: 'post_pt_root_id',
  prePosition: 'pre_pt_position',
  postPosition: 'post_pt_position',
  tag: 'tag',
} as const;

/**
 * Soma positions are published in the 8 x 8 x 30 nm voxel grid.
 *
 * The release prose states 16 x 16 x 30 nm for `somas.pt_position`, but the
 * released data contradicts it, on three independent grounds:
 *
 *  1. OUT OF BOUNDS. The published volume is 140000 x 32500 x 8689 voxels at
 *     16 nm (280000 x 65000 x 8689 at 8 nm), per
 *     https://storage.googleapis.com/fish1-public/clahe_231218/info
 *     The released CAVE somas export reaches y = 49,799, which cannot exist in
 *     a 32,500-voxel axis but sits comfortably inside the 65,000 of the 8 nm
 *     grid.
 *  2. SOMA DENSITY. At 8 nm the 30,346 released soma occupy
 *     163.7 x 275.4 x 120.9 um, a mean spacing of 5.6 um - the size of a larval
 *     zebrafish neuron. At 16 nm the spacing would be 9.0 um, too sparse for
 *     packed brain tissue.
 *  3. THE OFFICIAL NOTEBOOK. Its coordinate-lookup helper defaults to
 *     `resolution=(8, 8, 30)`.
 *
 * We therefore follow the data. Using 16 nm renders the brain at twice its true
 * width and length. Kept in exactly one place so a correction upstream is a
 * one-line change, and `pipeline/fish1/validate.py` now checks every exported
 * coordinate against the published volume bounds so this class of error cannot
 * ship again.
 */
export const FISH1_VOXEL_SPACE: VoxelSpace = {
  voxelSizeNm: [8, 8, 30],
  axisOrder: 'xyz',
  // Deliberately omitted: the release does not state which anatomical
  // direction each axis increases in. See FISH1_AXES in core/transforms.ts for
  // the derived interpretation used to place the reference body.
  anatomicalAxes: undefined,
};

/** Published volume extent in voxels at the 8 x 8 x 30 nm (mip 0) scale. */
export const FISH1_VOLUME_VOXELS: readonly [number, number, number] = [280000, 65000, 8689];

/** Counts published in the resource paper, for UI context only. */
export const FISH1_PUBLISHED_COUNTS = {
  somaCount: 180_000,
  synapseCount: 30_000_000,
  annotatedNeuronCount: 40_000,
} as const;

export const FISH1_CITATION: DatasetCitation = {
  text: 'Petkova, M. D., Januszewski, M., et al. (2025). A connectomic resource for neural cataloguing and circuit dissection of the larval zebrafish brain. bioRxiv.',
  url: 'https://www.biorxiv.org/content/10.1101/2025.06.10.658982v1',
};

export const FISH1_RELEASE_URL = 'https://fish1-release.storage.googleapis.com/index.html';

/**
 * Maps the dataset-native `cell_type` string onto our normalised polarity.
 * "na" means NOT ANNOTATED, which is different from "not excitatory or
 * inhibitory" - the cell simply was not molecularly labelled.
 */
export function mapFish1CellType(raw: unknown): 'excitatory' | 'inhibitory' | 'unknown' {
  if (raw === 'exc') return 'excitatory';
  if (raw === 'inh') return 'inhibitory';
  return 'unknown';
}
