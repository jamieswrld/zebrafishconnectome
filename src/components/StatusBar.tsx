'use client';

import { DATA_ORIGIN_INFO } from '@/core/types';
import { useBrainStore } from '@/state/brainStore';

/**
 * Bottom status strip.
 *
 * Everything shown is measured or read from the loaded dataset. There are no
 * decorative indicators: no fake "ONLINE", no invented node counts. The empty
 * right-hand region is reserved for the activity timeline, which appears only
 * once a functional dataset is actually loaded.
 */
export function StatusBar() {
  const metadata = useBrainStore((s) => s.metadata);
  const index = useBrainStore((s) => s.index);
  const stats = useBrainStore((s) => s.stats);
  const load = useBrainStore((s) => s.load);
  const visible = useBrainStore((s) => s.visibleCount);

  const origin = metadata ? DATA_ORIGIN_INFO[metadata.origin] : null;

  return (
    <footer className="status-bar" aria-label="Status">
      <span>{load.stage.toUpperCase()}</span>
      {metadata ? <span>{metadata.title}</span> : null}
      {origin ? (
        <span style={{ color: origin.isRealBiology ? 'var(--prov-measured)' : 'var(--warn)' }}>
          {origin.badge}
        </span>
      ) : null}
      {metadata ? <span>{metadata.version.label}</span> : null}
      {index ? (
        <span>
          {visible.toLocaleString()} / {index.count.toLocaleString()} soma
        </span>
      ) : null}
      {stats ? <span>{stats.fps.toFixed(0)} fps</span> : null}
      {stats ? <span>{stats.cpuFrameMs.toFixed(1)} ms</span> : null}
      {stats ? <span>{stats.api}</span> : null}

      <span style={{ marginLeft: 'auto', color: 'var(--text-ghost)' }}>
        Activity timeline: requires a functional dataset (none loaded)
      </span>
    </footer>
  );
}
