import { NextResponse } from 'next/server';
import { DataError, toDataError } from '@/core/errors';

/**
 * Shared helpers for route handlers.
 *
 * Every failure crosses the wire as a typed {@link DataError} body so the
 * client can tell "this neuron has no partners" from "the connectivity query
 * failed" - a distinction the UI is required to preserve.
 */

export function errorResponse(e: unknown): NextResponse {
  const error = toDataError(e);
  // Never leak a stack trace or an upstream URL containing a token.
  return NextResponse.json(error.toJSON(), { status: error.httpStatus });
}

/**
 * Cache policy for authenticated upstream reads.
 *
 * Private, because a response was fetched with our server credential and may
 * reflect a specific materialization. Short max-age with a long
 * stale-while-revalidate keeps repeat inspection of the same neuron instant
 * without pinning stale data.
 */
export function jsonResponse(body: unknown, cacheSeconds = 300): NextResponse {
  return NextResponse.json(body, {
    headers: {
      'Cache-Control': `private, max-age=${cacheSeconds}, stale-while-revalidate=600`,
    },
  });
}

export function badRequest(message: string, detail?: string): NextResponse {
  return errorResponse(
    new DataError({ code: 'dataset_mismatch', message, detail, httpStatus: 400 }),
  );
}

/** Parses a bounded integer query parameter. */
export function intParam(
  params: URLSearchParams,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
