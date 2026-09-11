import { describe, expect, it } from 'vitest';
import {
  PROVENANCE_INFO,
  PROVENANCE_ORDER,
  derived,
  measured,
  weakestProvenance,
} from '@/core/provenance';
import { DATA_ORIGIN_INFO, type DataOrigin } from '@/core/types';
import { RUNTIME_MODE_INFO } from '@/core/activity';
import { INFERRED_STATE_DEFINITIONS } from '@/core/inference';
import { ERROR_COPY, DataError, type DataErrorCode } from '@/core/errors';
import { mapFish1CellType } from '@/datasets/fish1/constants';

/**
 * Guards on the honesty rules.
 *
 * These are not style checks. Each one corresponds to a specific way this
 * application could mislead someone about what the data actually shows.
 */

describe('provenance classes', () => {
  it('describes every class', () => {
    for (const p of PROVENANCE_ORDER) {
      expect(PROVENANCE_INFO[p].label).toBeTruthy();
      expect(PROVENANCE_INFO[p].description.length).toBeGreaterThan(10);
    }
  });

  it('orders measured as the strongest and inferred as the weakest claim', () => {
    expect(PROVENANCE_ORDER[0]).toBe('measured');
    expect(PROVENANCE_ORDER.at(-1)).toBe('inferred');
  });

  it('reports the weakest class when sources are combined', () => {
    // A figure mixing a measurement with an inference is only as strong as the
    // inference.
    expect(weakestProvenance(['measured', 'inferred'])).toBe('inferred');
    expect(weakestProvenance(['measured', 'derived'])).toBe('derived');
    expect(weakestProvenance(['measured'])).toBe('measured');
    expect(weakestProvenance(['derived', 'simulated', 'predicted'])).toBe('simulated');
  });

  it('tags helper-wrapped values correctly', () => {
    expect(measured(5).provenance).toBe('measured');
    expect(derived(5, 'degree-v1').provenance).toBe('derived');
    expect(derived(5, 'degree-v1').modelId).toBe('degree-v1');
  });
});

describe('data origin badges', () => {
  it('marks generated populations as not real biology', () => {
    expect(DATA_ORIGIN_INFO['development-sample'].isRealBiology).toBe(false);
    expect(DATA_ORIGIN_INFO['synthetic-benchmark'].isRealBiology).toBe(false);
  });

  it('marks dataset-derived populations as real biology', () => {
    expect(DATA_ORIGIN_INFO['upstream-live'].isRealBiology).toBe(true);
    expect(DATA_ORIGIN_INFO['preprocessed-export'].isRealBiology).toBe(true);
  });

  it('gives synthetic origins a badge that says so on its own', () => {
    for (const origin of ['development-sample', 'synthetic-benchmark'] as DataOrigin[]) {
      const badge = DATA_ORIGIN_INFO[origin].badge;
      expect(badge).toMatch(/SAMPLE|SYNTHETIC/);
      expect(DATA_ORIGIN_INFO[origin].description).toMatch(/no biological measurements/i);
    }
  });
});

describe('runtime modes', () => {
  it('never labels a model output as measured', () => {
    expect(RUNTIME_MODE_INFO.recorded.provenance).toBe('measured');
    expect(RUNTIME_MODE_INFO.predicted.provenance).toBe('predicted');
    expect(RUNTIME_MODE_INFO.simulated.provenance).toBe('simulated');
  });

  it('gives each mode a distinct badge', () => {
    const badges = Object.values(RUNTIME_MODE_INFO).map((m) => m.badge);
    expect(new Set(badges).size).toBe(badges.length);
  });
});

describe('inferred state vocabulary', () => {
  it('names behavioural or circuit responses, never emotions', () => {
    const forbidden =
      /\b(fear|afraid|anger|angry|happy|sad|thought|thinking|feel|feels|emotion|conscious)\b/i;
    for (const definition of Object.values(INFERRED_STATE_DEFINITIONS)) {
      expect(definition.label).not.toMatch(forbidden);
      // The definition text may mention fear only to disclaim it.
      const claims = definition.definition.replace(/not subjective fear\./i, '');
      expect(claims).not.toMatch(forbidden);
    }
  });

  it('defines what each readout actually measures', () => {
    for (const definition of Object.values(INFERRED_STATE_DEFINITIONS)) {
      expect(definition.definition.length).toBeGreaterThan(20);
    }
  });
});

describe('Fish1 cell type mapping', () => {
  it('maps the documented values', () => {
    expect(mapFish1CellType('exc')).toBe('excitatory');
    expect(mapFish1CellType('inh')).toBe('inhibitory');
  });

  it('treats "na" as unannotated rather than as a third polarity', () => {
    expect(mapFish1CellType('na')).toBe('unknown');
    expect(mapFish1CellType(null)).toBe('unknown');
    expect(mapFish1CellType(undefined)).toBe('unknown');
    expect(mapFish1CellType('')).toBe('unknown');
  });
});

describe('error taxonomy', () => {
  it('gives every code distinct, actionable copy', () => {
    const codes = Object.keys(ERROR_COPY) as DataErrorCode[];
    const titles = codes.map((c) => ERROR_COPY[c].title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const code of codes) {
      expect(ERROR_COPY[code].hint.length).toBeGreaterThan(10);
    }
  });

  it('distinguishes a failed connectivity query from an empty result', () => {
    // The single most misleading collapse a connectome viewer can make.
    expect(ERROR_COPY.connectivity_unavailable.hint).toMatch(/not the same as/i);
  });

  it('maps codes to sensible HTTP statuses', () => {
    expect(new DataError({ code: 'not_found', message: 'x' }).httpStatus).toBe(404);
    expect(new DataError({ code: 'auth_missing', message: 'x' }).httpStatus).toBe(501);
    expect(new DataError({ code: 'query_too_large', message: 'x' }).httpStatus).toBe(413);
  });

  it('marks transient failures retryable and permanent ones not', () => {
    expect(new DataError({ code: 'timeout', message: 'x' }).retryable).toBe(true);
    expect(new DataError({ code: 'rate_limited', message: 'x' }).retryable).toBe(true);
    expect(new DataError({ code: 'not_found', message: 'x' }).retryable).toBe(false);
  });

  it('serialises without leaking internals', () => {
    const json = new DataError({
      code: 'auth_rejected',
      message: 'token bad',
      detail: 'regenerate it',
      datasetId: 'fish1',
    }).toJSON();
    expect(json.error.code).toBe('auth_rejected');
    expect(Object.keys(json.error).sort()).toEqual(
      ['code', 'datasetId', 'detail', 'message', 'retryable'].sort(),
    );
  });
});
