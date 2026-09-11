import { asLoreId, isLoreId } from '@/core/ids';
import { fish1GetNeuron } from '@/datasets/fish1/server';
import { FISH1_DATASET_ID } from '@/datasets/fish1/constants';
import { badRequest, errorResponse, jsonResponse } from '../../http';

/**
 * Single-neuron metadata.
 *
 * `id` is a STABLE LORE ID, never a root ID: root IDs change under
 * proofreading, so they are not a durable address for a neuron. Pass
 * `?checkLatestRoot=1` to additionally verify the segment's root ID against the
 * live chunked graph - an extra upstream call, so it is opt-in.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const params = new URL(request.url).searchParams;
    const dataset = params.get('dataset') ?? FISH1_DATASET_ID;

    if (!isLoreId(id)) {
      return badRequest(
        `"${id}" is not a valid lore ID.`,
        'Lore IDs are short integers. A long 64-bit value is a root ID; resolve it through /api/search first.',
      );
    }
    if (dataset !== FISH1_DATASET_ID) {
      return badRequest(
        `Dataset "${dataset}" is not served by this endpoint.`,
        'Synthetic and development datasets are resolved entirely in the browser.',
      );
    }

    const neuron = await fish1GetNeuron(asLoreId(id), {
      checkLatestRoot: params.get('checkLatestRoot') === '1',
    });
    return jsonResponse(neuron);
  } catch (e) {
    return errorResponse(e);
  }
}
