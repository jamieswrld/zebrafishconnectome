/**
 * Provenance is the backbone of scientific honesty in this application.
 *
 * Every number shown to a user carries one of these classes. The UI must never
 * present a DERIVED/PREDICTED/SIMULATED/INFERRED quantity with the same visual
 * weight as a MEASURED one, and must never describe an inferred state as a
 * literal thought, feeling, or intention of the animal.
 */
export type EvidenceProvenance =
  /** Direct observation recorded in the source dataset (coordinates, synapses,
   *  molecular labels, calcium traces, delivered stimuli, recorded behaviour). */
  | 'measured'
  /** Deterministically computed from measured data (degree, density, path length).
   *  Reproducible; adds no assumptions beyond the computation itself. */
  | 'derived'
  /** Output of a forecasting / machine-learning model (e.g. ZAPBench baselines). */
  | 'predicted'
  /** Output of our computational connectome simulation. */
  | 'simulated'
  /** Our interpretation or classification of a pattern (e.g. "escape-like").
   *  Always the weakest claim. Must carry evidence and, where possible, confidence. */
  | 'inferred';

export const PROVENANCE_ORDER: readonly EvidenceProvenance[] = [
  'measured',
  'derived',
  'predicted',
  'simulated',
  'inferred',
] as const;

export interface ProvenanceDescriptor {
  readonly label: string;
  /** One-line explanation surfaced in tooltips and the DATA panel. */
  readonly description: string;
  /** Token name resolved in CSS (see src/app/globals.css). */
  readonly colorToken: string;
}

export const PROVENANCE_INFO: Record<EvidenceProvenance, ProvenanceDescriptor> = {
  measured: {
    label: 'MEASURED',
    description: 'Directly observed in the source dataset.',
    colorToken: '--prov-measured',
  },
  derived: {
    label: 'DERIVED',
    description: 'Computed deterministically from measured data.',
    colorToken: '--prov-derived',
  },
  predicted: {
    label: 'PREDICTED',
    description: 'Output of a forecasting model, not an observation.',
    colorToken: '--prov-predicted',
  },
  simulated: {
    label: 'SIMULATED',
    description: 'Output of a computational model of the connectome.',
    colorToken: '--prov-simulated',
  },
  inferred: {
    label: 'INFERRED',
    description:
      'Our interpretation of a pattern. Not a measurement, and not a claim about what the animal experiences.',
    colorToken: '--prov-inferred',
  },
};

/** A value paired with the epistemic class it belongs to. */
export interface Provenanced<T> {
  readonly value: T;
  readonly provenance: EvidenceProvenance;
  /** Identifier of the model/computation that produced a non-measured value. */
  readonly modelId?: string;
  readonly note?: string;
}

export function measured<T>(value: T, note?: string): Provenanced<T> {
  return { value, provenance: 'measured', note };
}

export function derived<T>(value: T, modelId?: string, note?: string): Provenanced<T> {
  return { value, provenance: 'derived', modelId, note };
}

/**
 * Ranks provenance from strongest to weakest claim. Used to pick the weakest
 * (most cautious) label when a figure combines several sources.
 */
export function weakestProvenance(classes: readonly EvidenceProvenance[]): EvidenceProvenance {
  let worst = 0;
  for (const c of classes) worst = Math.max(worst, PROVENANCE_ORDER.indexOf(c));
  return PROVENANCE_ORDER[worst] ?? 'inferred';
}
