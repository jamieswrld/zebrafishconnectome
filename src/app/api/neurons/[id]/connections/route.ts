import { asLoreId, isLoreId } from '@/core/ids';
import { TRAVERSAL_LIMITS } from '@/core/types';
import { fish1GetConnections } from '@/datasets/fish1/server';
import { FISH1_DATASET_ID } from '@/datasets/fish1/constants';
import { badRequest, errorResponse, intParam, jsonResponse } from '../../../http';

/**
 * First-order connectivity for one neuron.
 *
 * Returns one entry per PARTNER, aggregated over the synapses between the pair.
 * Fish1 holds roughly 30 million synapses; nothing here ever ships a
 * per-synapse list to the browser by default.
 *
 * Multi-hop expansion is deliberately not done here. Depth > 1 is driven by the
 * client, which calls this endpoint per frontier node through a worker, so a
 * large traversal stays cancellable and cannot occupy a server request for
 * minutes.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const params = new URL(request.url).searchParams;
    const dataset = params.get('dataset') ?? FISH1_DATASET_ID;

    if (!isLoreId(id)) {
      return badRequest(`"${id}" is not a valid lore ID.`);
    }
    if (dataset !== FISH1_DATASET_ID) {
      return badRequest(`Dataset "${dataset}" is not served by this endpoint.`);
    }

    const directionParam = params.get('direction') ?? 'both';
    if (!['incoming', 'outgoing', 'both'].includes(directionParam)) {
      return badRequest(`Unknown direction "${directionParam}".`);
    }

    const result = await fish1GetConnections(asLoreId(id), {
      direction: directionParam as 'incoming' | 'outgoing' | 'both',
      minSynapses: intParam(params, 'minSynapses', 1, 1, 10_000),
      topN: intParam(params, 'topN', 50, 1, TRAVERSAL_LIMITS.maxPartnersPerHop),
      // Resolving partner lore IDs costs an extra query per 200 partners; it is
      // what makes partners clickable, so it is on by default.
      resolvePartnerIdentities: params.get('resolveIdentities') !== '0',
    });

    return jsonResponse(result);
  } catch (e) {
    return errorResponse(e);
  }
}
