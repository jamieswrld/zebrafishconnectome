import { NextResponse } from 'next/server';
import { DATASET_OPTIONS } from '@/datasets/registry';
import { errorResponse } from '../http';

/**
 * Lists the datasets this deployment knows about, with their access status.
 * Deliberately does not query upstream: this must stay fast and must work even
 * when CAVE is unreachable.
 */
export async function GET() {
  try {
    return NextResponse.json({ datasets: DATASET_OPTIONS });
  } catch (e) {
    return errorResponse(e);
  }
}
