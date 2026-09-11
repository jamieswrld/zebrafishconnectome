import { NextResponse } from 'next/server';
import { classifyIdentifier } from '@/core/ids';
import { fish1Search } from '@/datasets/fish1/server';
import { FISH1_DATASET_ID } from '@/datasets/fish1/constants';
import { errorResponse, jsonResponse } from '../http';

/**
 * Identifier search.
 *
 * Accepts either a stable lore ID or a 64-bit root ID and resolves both to a
 * lore ID, because that is the only identifier worth selecting or sharing.
 * Region and annotation search will extend this once the relevant tables are
 * ingested; until then an unrecognised term returns no results rather than a
 * fabricated match.
 */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const term = (params.get('q') ?? '').trim();
    const dataset = params.get('dataset') ?? FISH1_DATASET_ID;

    if (term.length === 0) {
      return NextResponse.json({ results: [], kind: 'unknown' });
    }
    if (dataset !== FISH1_DATASET_ID) {
      return NextResponse.json({
        results: [],
        kind: classifyIdentifier(term),
        note: 'This dataset is searched entirely in the browser.',
      });
    }

    const results = await fish1Search(term);
    return jsonResponse({ results, kind: classifyIdentifier(term) }, 60);
  } catch (e) {
    return errorResponse(e);
  }
}
