'use client';

import { useBrainStore } from '@/state/brainStore';

/**
 * Developer diagnostics, shown with ?debug=1.
 *
 * The point of this panel is to keep the project honest as it grows: every
 * number is measured, none is decorative, and a regression in frame time or
 * buffer footprint is visible immediately rather than three milestones later.
 */
export function DebugPanel() {
  const stats = useBrainStore((s) => s.stats);
  const index = useBrainStore((s) => s.index);
  const filterMs = useBrainStore((s) => s.filterElapsedMs);
  const visible = useBrainStore((s) => s.visibleCount);
  const circuit = useBrainStore((s) => s.circuit);
  const setDisplay = useBrainStore((s) => s.setDisplay);

  if (!stats) return null;

  const buffersMb = stats.gpuBufferBytes / (1024 * 1024);
  // Rough CPU-side footprint of the index: what we hold outside the GPU.
  const indexMb = index
    ? (index.positionsUm.byteLength +
        index.positionsVoxel.byteLength +
        index.loreIds.byteLength +
        index.cellTypes.byteLength +
        index.regionIds.byteLength +
        index.flags.byteLength) /
      (1024 * 1024)
    : 0;

  return (
    <aside className="debug" aria-label="Performance diagnostics">
      <div className="debug__head">
        <span className="label">Diagnostics</span>
        <button
          className="btn"
          style={{ padding: '1px 5px' }}
          onClick={() => setDisplay({ debugOpen: false })}
        >
          ×
        </button>
      </div>

      <Row k="fps (raf)" v={stats.fps.toFixed(1)} />
      <Row k="render fps" v={stats.renderFps.toFixed(1)} />
      <Row k="cpu frame" v={`${stats.cpuFrameMs.toFixed(2)} ms`} />
      <Row
        k="gpu frame"
        v={stats.gpuFrameMs === null ? 'n/a' : `${stats.gpuFrameMs.toFixed(2)} ms`}
      />
      <Row k="draw calls" v={String(stats.drawCalls)} />
      <Row k="soma total" v={stats.somaTotal.toLocaleString()} />
      <Row k="soma visible" v={visible.toLocaleString()} />
      <Row k="line segments" v={stats.lineSegments.toLocaleString()} />
      <Row k="gpu buffers" v={`${buffersMb.toFixed(2)} MB`} />
      <Row k="cpu index" v={`${indexMb.toFixed(2)} MB`} />
      <Row k="filter pass" v={`${filterMs.toFixed(2)} ms`} />
      <Row k="api" v={stats.api} />
      <Row k="lod" v={stats.lodLevel} />
      <Row k="cam dist" v={stats.cameraDistance.toFixed(3)} />
      <Row k="partners" v={circuit.data ? String(circuit.data.partners.length) : '—'} />
      <div
        className="debug__row"
        style={{ marginTop: 6, display: 'block', color: 'var(--text-ghost)' }}
      >
        {stats.device}
      </div>
    </aside>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="debug__row">
      <span>{k}</span>
      <b>{v}</b>
    </div>
  );
}
