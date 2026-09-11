'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BrainRenderer, type RendererStats } from '@/renderer/BrainRenderer';
import { AXIS_PRESETS } from '@/renderer/camera';
import { detectGpuSupport, type GpuSupport } from '@/renderer/types';
import { syncRendererWithState, useBrainStore } from '@/state/brainStore';
import { rendererRef } from '@/state/rendererRef';
import { DATA_ORIGIN_INFO } from '@/core/types';
import { LOAD_STAGE_LABEL, type LoadStage } from '@/core/adapter';
import { DebugPanel } from './DebugPanel';
import { ErrorNotice, OriginBadge } from './Badges';

/**
 * The viewport.
 *
 * Owns the canvas and the renderer's lifecycle, and nothing else. React renders
 * this component roughly once; every subsequent frame is driven by the renderer
 * on its own requestAnimationFrame loop with zero React involvement. Hover and
 * selection arrive as plain integers through callbacks.
 */

const BOOT_SEQUENCE: LoadStage[] = [
  'gpu-init',
  'manifest',
  'downloading',
  'decoding',
  'uploading',
  'ready',
];

export function BrainViewport({ debug }: { debug: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [gpu, setGpu] = useState<GpuSupport | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [deviceLost, setDeviceLost] = useState<string | null>(null);
  const [gpuReady, setGpuReady] = useState(false);

  const load = useBrainStore((s) => s.load);
  const index = useBrainStore((s) => s.index);
  const metadata = useBrainStore((s) => s.metadata);
  const hoverIndex = useBrainStore((s) => s.hoverIndex);
  const stats = useBrainStore((s) => s.stats);
  const visibleCount = useBrainStore((s) => s.visibleCount);
  const selection = useBrainStore((s) => s.selection);

  const selectIndex = useBrainStore((s) => s.selectIndex);
  const setHoverIndex = useBrainStore((s) => s.setHoverIndex);
  const setStats = useBrainStore((s) => s.setStats);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let renderer: BrainRenderer | null = null;

    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    void (async () => {
      const support = await detectGpuSupport();
      if (disposed) return;
      setGpu(support);

      if (!support.webgpu && !support.webgl2) {
        setInitError(
          'This browser exposes neither WebGPU nor WebGL2, so the brain cannot be rendered.',
        );
        return;
      }

      try {
        renderer = await BrainRenderer.create({
          canvas,
          // WebGPU when available; WebGL2 is a genuine fallback, not a stub.
          preferredApi: 'auto',
          reducedMotion,
          callbacks: {
            onSelect: (i) => selectIndex(i),
            onHover: (i) => setHoverIndex(i),
            onStats: (s: RendererStats) => setStats(s),
            onDeviceLost: (reason) => setDeviceLost(reason),
          },
        });
        if (disposed) {
          renderer.dispose();
          return;
        }
        rendererRef.current = renderer;
        // The dataset may already have loaded while the GPU device was being
        // requested. Push whatever the store holds so the population is never
        // stranded because it arrived first.
        syncRendererWithState();
        setGpuReady(true);
      } catch (e) {
        setInitError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      disposed = true;
      renderer?.dispose();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [selectIndex, setHoverIndex, setStats]);

  const applyPreset = useCallback((presetId: string) => {
    const preset = AXIS_PRESETS.find((p) => p.id === presetId);
    if (preset) rendererRef.current?.applyCameraPreset(preset);
  }, []);

  const hoverLoreId =
    index && hoverIndex >= 0 && hoverIndex < index.count ? index.loreIds[hoverIndex] : null;

  const booting = load.stage !== 'ready' && load.stage !== 'error';
  const showBoot = booting || !gpuReady;

  return (
    <div className="viewport-wrap">
      <canvas
        ref={canvasRef}
        className="viewport-canvas"
        aria-label="Three-dimensional zebrafish brain viewer"
        role="application"
      />

      {/* The selected neuron is also exposed as text, because canvas content is
          not reachable by a screen reader. */}
      <p className="sr-only" aria-live="polite">
        {selection.loreId
          ? `Selected neuron ${selection.loreId}${selection.neuron ? `, cell type ${selection.neuron.cellType}` : ''}.`
          : 'No neuron selected.'}
      </p>

      {!showBoot && index ? (
        <>
          <div className="hud">
            <div className="hud__block">
              <div className="hud__label">{metadata?.title ?? 'DATASET'}</div>
              <div className="hud__sub">
                {metadata?.modality.join(' + ').toUpperCase() ?? '—'}
              </div>
            </div>
            <div className="hud__block">
              <div className="hud__label">Neurons loaded</div>
              <div className="hud__value">{index.count.toLocaleString()}</div>
            </div>
            <div className="hud__block">
              <div className="hud__label">Visible</div>
              <div className="hud__value">{visibleCount.toLocaleString()}</div>
            </div>
            <div className="hud__block">
              <div className="hud__label">Selected</div>
              <div className="hud__value">
                {selection.loreId ?? <span className="faint">—</span>}
              </div>
            </div>
            <div className="hud__block">
              <div className="hud__label">FPS</div>
              <div className="hud__value">{stats ? Math.round(stats.fps) : '—'}</div>
              <div className="hud__sub">
                {stats ? `${stats.cpuFrameMs.toFixed(1)} ms cpu` : ''}
              </div>
            </div>
          </div>

          <div className="viewport-badges">
            {metadata ? <OriginBadge origin={metadata.origin} /> : null}
            {metadata && !DATA_ORIGIN_INFO[metadata.origin].isRealBiology ? (
              <span
                className="badge badge--warn"
                title="This population contains no biological measurements."
              >
                NOT BIOLOGICAL DATA
              </span>
            ) : null}
            <span className="badge" title={stats?.device}>
              {((stats?.api ?? gpu?.webgpu) ? 'webgpu' : 'webgl2').toString().toUpperCase()}
            </span>
            <span className="badge" title="Current level of detail.">
              {stats?.lodLevel.replace('-', ' ').toUpperCase() ?? '—'}
            </span>
          </div>

          <div className="viewport-controls">
            <button className="btn" onClick={() => rendererRef.current?.resetCamera()}>
              Reset view
            </button>
            {AXIS_PRESETS.map((p) => (
              <button
                key={p.id}
                className="btn"
                onClick={() => applyPreset(p.id)}
                title={
                  metadata?.voxelSpace.anatomicalAxes
                    ? `View along ${p.label}`
                    : 'Axis-aligned view. This dataset does not document which anatomical direction each axis points, so no dorsal/lateral label is shown.'
                }
              >
                {p.label}
              </button>
            ))}
            <button
              className="btn"
              onClick={() => {
                if (selection.index >= 0) rendererRef.current?.focusIndex(selection.index);
              }}
              disabled={selection.index < 0}
            >
              Focus selected
            </button>
          </div>

          {hoverLoreId !== null ? <div className="hover-chip">lore {hoverLoreId}</div> : null}
        </>
      ) : null}

      {debug && stats ? <DebugPanel /> : null}

      {showBoot ? (
        <div className="boot">
          <div className="boot__steps">
            {BOOT_SEQUENCE.map((stage) => {
              const currentIndex = BOOT_SEQUENCE.indexOf(
                gpuReady ? (load.stage as LoadStage) : 'gpu-init',
              );
              const stageIndex = BOOT_SEQUENCE.indexOf(stage);
              const state =
                stageIndex < currentIndex
                  ? 'done'
                  : stageIndex === currentIndex
                    ? 'active'
                    : 'pending';
              return (
                <div key={stage} className={`boot__step boot__step--${state}`}>
                  <span>{state === 'done' ? '·' : state === 'active' ? '>' : ' '}</span>
                  <span>{LOAD_STAGE_LABEL[stage]}</span>
                </div>
              );
            })}
          </div>
          {load.bytesTotal ? (
            <div className="boot__bar">
              <span style={{ width: `${Math.round((load.fraction ?? 0) * 100)}%` }} />
            </div>
          ) : null}
          <div className="hud__sub">{load.message}</div>
        </div>
      ) : null}

      {load.stage === 'error' && load.error ? (
        <div className="boot">
          <div style={{ maxWidth: 460, width: '100%' }}>
            <ErrorNotice error={load.error} />
          </div>
        </div>
      ) : null}

      {initError ? (
        <div className="boot">
          <div className="notice notice--error" style={{ maxWidth: 460 }}>
            <div className="notice__title">Graphics initialisation failed</div>
            <div>{initError}</div>
            {gpu?.reason ? <div className="notice__hint">{gpu.reason}</div> : null}
          </div>
        </div>
      ) : null}

      {deviceLost ? (
        <div className="boot">
          <div className="notice notice--error" style={{ maxWidth: 460 }}>
            <div className="notice__title">GPU device lost</div>
            <div>{deviceLost}</div>
            <div className="notice__hint">
              The GPU context was released by the system. Reload the page to reinitialise it.
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
