import { fish1Metadata } from '@/datasets/fish1/server';
import { FISH1_DATASET_ID } from '@/datasets/fish1/constants';
import { errorResponse, jsonResponse, badRequest } from '../../../http';

/**
 * Dataset metadata, including live access status.
 *
 * For Fish1 this resolves the current CAVE materialization version, which is
 * the only reliable way to tell a user whether the dataset is actually
 * reachable with the configured token.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ dataset: string }> },
) {
  try {
    const { dataset } = await context.params;
    if (dataset !== FISH1_DATASET_ID) {
      return badRequest(
        `Dataset "${dataset}" has no server-side metadata endpoint.`,
        'Only Fish1 requires authenticated metadata resolution; other adapters describe themselves in the browser.',
      );
    }
    // Short cache: the materialization version can change upstream.
    return jsonResponse(await fish1Metadata(), 120);
  } catch (e) {
    return errorResponse(e);
  }
}
