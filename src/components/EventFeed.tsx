'use client';

import type { AgentEvent } from '@/embodiment/types';

/**
 * The action log: an append-only record of what the organism did and why.
 *
 * This is the beginning of the black-box recorder. Every line is a real event
 * emitted by the running simulation - nothing is scripted, and nothing is shown
 * that did not actually happen.
 */

const TYPE_COLOR: Partial<Record<AgentEvent['type'], string>> = {
  action_selected: 'var(--prov-simulated)',
  boundary_contact: 'var(--warn)',
  external_action_requested: 'var(--prov-predicted)',
  external_action_denied: 'var(--error)',
};

export function EventFeed({ events }: { events: readonly AgentEvent[] }) {
  return (
    <footer className="status-bar" aria-label="Action log">
      {events.length === 0 ? (
        <span style={{ color: 'var(--text-ghost)' }}>
          Action log — events appear as the simulation runs
        </span>
      ) : (
        events.slice(0, 6).map((event) => (
          <span key={event.id} style={{ whiteSpace: 'nowrap' }}>
            <span className="mono" style={{ color: 'var(--text-ghost)' }}>
              {event.timestamp.toFixed(1)}s
            </span>{' '}
            <span style={{ color: TYPE_COLOR[event.type] ?? 'var(--text-faint)' }}>
              {event.summary}
            </span>
          </span>
        ))
      )}
    </footer>
  );
}
