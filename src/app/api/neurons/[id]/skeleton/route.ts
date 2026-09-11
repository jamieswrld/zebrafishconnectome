import { asLoreId, isLoreId } from '@/core/ids';
import { fish1GetSkeleton } from '@/datasets/fish1/server';
import { FISH1_DATASET_ID } from '@/datasets/fish1/constants';
import { badRequest, errorResponse, jsonResponse } from '../../../http';

/**
 * Neuron morphology.
 *
 * Skeletons are fetched ONE AT A TIME, on explicit request. Loading morphology
 * for every cell at boot is exactly the kind of thing that makes a connectome
 * viewer unusable, so there is no bulk variant of this endpoint.
 *
 * TypedArrays are serialised as plain arrays here; the browser adapter
 * rehydrates them. Skeletons are single-neuron sized, so the JSON overhead is
 * acceptable in exchange for a cacheable, inspectable response.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const dataset = new URL(request.url).searchParams.get('dataset') ?? FISH1_DATASET_ID;

    if (!isLoreId(id)) return badRequest(`"${id}" is not a valid lore ID.`);
    if (dataset !== FISH1_DATASET_ID) {
      return badRequest(`Dataset "${dataset}" has no skeleton service.`);
    }

    const skeleton = await fish1GetSkeleton(asLoreId(id));
    return jsonResponse(
      {
        datasetId: skeleton.datasetId,
        loreId: skeleton.loreId,
        rootId: skeleton.rootId,
        vertexCount: skeleton.vertexCount,
        verticesUm: Array.from(skeleton.verticesUm),
        parents: Array.from(skeleton.parents),
        radiiUm: skeleton.radiiUm ? Array.from(skeleton.radiiUm) : undefined,
        compartments: skeleton.compartments ? Array.from(skeleton.compartments) : undefined,
      },
      // Morphology for a given root ID is immutable, so cache it hard.
      3600,
    );
  } catch (e) {
    return errorResponse(e);
  }
}
