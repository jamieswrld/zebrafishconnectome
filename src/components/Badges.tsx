'use client';

import { ERROR_COPY, type DataError } from '@/core/errors';
import { PROVENANCE_INFO, type EvidenceProvenance } from '@/core/provenance';
import { DATA_ORIGIN_INFO, type DataOrigin } from '@/core/types';
import { RUNTIME_MODE_INFO, type RuntimeMode } from '@/core/activity';

/**
 * Provenance and origin badges.
 *
 * These are the load-bearing honesty components. A number's epistemic class
 * travels with it everywhere it is shown, and a dataset that is not real
 * biology says so in the viewport rather than in a footnote.
 */

export function ProvenanceBadge({
  provenance,
  modelId,
}: {
  provenance: EvidenceProvenance;
  modelId?: string;
}) {
  const info = PROVENANCE_INFO[provenance];
  return (
    <span
      className="badge"
      style={{
        color: `var(${info.colorToken})`,
        borderColor: `color-mix(in srgb, var(${info.colorToken}) 38%, transparent)`,
      }}
      title={modelId ? `${info.description} Model: ${modelId}` : info.description}
    >
      <span className="badge__dot" aria-hidden />
      {info.label}
    </span>
  );
}

export function OriginBadge({ origin }: { origin: DataOrigin }) {
  const info = DATA_ORIGIN_INFO[origin];
  return (
    <span
      className={info.isRealBiology ? 'badge badge--real' : 'badge badge--warn'}
      title={info.description}
    >
      <span className="badge__dot" aria-hidden />
      {info.badge}
    </span>
  );
}

/**
 * Runtime-mode badge. RECORDED, PREDICTED and SIMULATED must never be
 * visually confusable, so each carries its provenance colour.
 */
export function RuntimeModeBadge({ mode }: { mode: RuntimeMode }) {
  const info = RUNTIME_MODE_INFO[mode];
  const token = PROVENANCE_INFO[info.provenance].colorToken;
  return (
    <span
      className="badge"
      style={{
        color: `var(${token})`,
        borderColor: `color-mix(in srgb, var(${token}) 38%, transparent)`,
      }}
      title={info.description}
    >
      <span className="badge__dot" aria-hidden />
      {info.badge}
    </span>
  );
}

/**
 * Typed error display.
 *
 * Shows the specific failure and the action that resolves it. There is
 * deliberately no generic "something went wrong" path: every DataErrorCode has
 * its own copy in ERROR_COPY.
 */
export function ErrorNotice({ error, compact }: { error: DataError; compact?: boolean }) {
  const copy = ERROR_COPY[error.code];
  return (
    <div className="notice notice--error" role="alert">
      <div className="notice__title">{copy.title}</div>
      <div>{error.detail ?? copy.hint}</div>
      {!compact && error.message !== copy.title ? (
        <div className="notice__hint mono">{error.message}</div>
      ) : null}
    </div>
  );
}

export function InfoNotice({
  title,
  children,
  variant = 'warn',
}: {
  title: string;
  children: React.ReactNode;
  variant?: 'warn' | 'plain';
}) {
  return (
    <div className={variant === 'warn' ? 'notice notice--warn' : 'notice'}>
      <div className="notice__title">{title}</div>
      <div>{children}</div>
    </div>
  );
}
