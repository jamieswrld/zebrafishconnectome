'use client';

import { useMemo } from 'react';
import { countByCellType } from '@/core/filters';
import { ALL_CELL_TYPES } from '@/core/filters';
import type { CellPolarity } from '@/core/types';
import { CELL_COLORS, rgbToCss } from '@/renderer/backends/palette';
import { useBrainStore } from '@/state/brainStore';
import { rendererRef } from '@/state/rendererRef';
import { DATASET_OPTIONS, BENCHMARK_SIZES } from '@/datasets/registry';
import type { ColorMode } from '@/renderer/types';

/**
 * Left panel: dataset selection, population filters, and display options.
 *
 * Filtering runs as a single TypedArray pass and pushes a mask straight to the
 * GPU state lane, so toggling a population of 200,000 neurons is sub-millisecond
 * and nothing in React re-renders per neuron. The measured pass time is shown,
 * because a claim of "instantaneous" should be checkable.
 */
import { CircuitsPanel } from './CircuitsPanel';

export function FilterPanel({
  onDatasetChange,
}: {
  onDatasetChange: (datasetId: string) => void;
}) {
  const datasetId = useBrainStore((s) => s.datasetId);
  const index = useBrainStore((s) => s.index);
  const filters = useBrainStore((s) => s.filters);
  const visibleCount = useBrainStore((s) => s.visibleCount);
  const filterMs = useBrainStore((s) => s.filterElapsedMs);
  const display = useBrainStore((s) => s.display);
  const toggleCellType = useBrainStore((s) => s.toggleCellType);
  const setFilters = useBrainStore((s) => s.setFilters);
  const resetFilters = useBrainStore((s) => s.resetFilters);
  const setDisplay = useBrainStore((s) => s.setDisplay);

  // Counts are a full pass over the population, so they are computed once per
  // loaded index rather than on every filter change.
  const counts = useMemo(() => (index ? countByCellType(index) : null), [index]);

  const colorModes: Array<{ id: ColorMode; label: string; enabled: boolean; title: string }> = [
    {
      id: 'cell-type',
      label: 'Type',
      enabled: true,
      title: 'Colour by neurotransmitter polarity.',
    },
    {
      id: 'region',
      label: 'Region',
      enabled: (index?.regions.length ?? 0) > 0,
      title: 'Colour by region label. Hues are arbitrary and carry no anatomical meaning.',
    },
    {
      id: 'depth',
      label: 'Depth',
      enabled: true,
      title: 'Colour by distance from the camera.',
    },
    {
      id: 'activity',
      label: 'Activity',
      enabled: false,
      title: 'Requires a functional dataset. No activity source is loaded.',
    },
  ];

  return (
    <aside className="panel panel--left" aria-label="Filters and display options">
      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Dataset</span>
        </div>
        <select
          className="field"
          value={datasetId}
          onChange={(e) => onDatasetChange(e.target.value)}
          aria-label="Select dataset"
        >
          {DATASET_OPTIONS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
          <optgroup label="Synthetic benchmark">
            {BENCHMARK_SIZES.map((n) => (
              <option key={n} value={`benchmark-${n}`}>
                {n.toLocaleString()} soma
              </option>
            ))}
          </optgroup>
        </select>
        <p className="faint" style={{ fontSize: 10.5, marginTop: 6, marginBottom: 0 }}>
          {DATASET_OPTIONS.find((d) => d.id === datasetId)?.note ??
            'Deterministic synthetic population for renderer benchmarking. Not biology.'}
        </p>
      </section>

      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Cell type</span>
          <button className="btn" style={{ padding: '2px 6px' }} onClick={resetFilters}>
            Reset
          </button>
        </div>
        {ALL_CELL_TYPES.map((type) => (
          <CellTypeToggle
            key={type}
            type={type}
            checked={filters.cellTypes.has(type)}
            count={counts?.[type] ?? 0}
            onToggle={() => toggleCellType(type)}
          />
        ))}
        <p className="faint" style={{ fontSize: 10.5, margin: '6px 0 0' }}>
          &ldquo;Unknown&rdquo; means the cell was not molecularly annotated, not that it is
          neither excitatory nor inhibitory.
        </p>
      </section>

      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Annotation</span>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={filters.onlyAnnotated}
            onChange={(e) => setFilters({ onlyAnnotated: e.target.checked })}
          />
          Annotated only
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={filters.onlyWithSkeleton}
            onChange={(e) => setFilters({ onlyWithSkeleton: e.target.checked })}
          />
          Has skeleton
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={filters.onlyProofread}
            onChange={(e) => setFilters({ onlyProofread: e.target.checked })}
          />
          Proofread only
        </label>
        {filters.restrictToIndices ? (
          <label className="toggle">
            <input
              type="checkbox"
              checked
              onChange={() => setFilters({ restrictToIndices: null })}
            />
            Restricted to circuit
            <span className="toggle__count">{filters.restrictToIndices.size}</span>
          </label>
        ) : null}
      </section>

      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Layers</span>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={display.showConnections}
            onChange={(e) => setDisplay({ showConnections: e.target.checked })}
          />
          Connections
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={display.showAxes}
            onChange={(e) => setDisplay({ showAxes: e.target.checked })}
          />
          Volume bounds
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={display.contextMode === 'hide'}
            onChange={(e) => setDisplay({ contextMode: e.target.checked ? 'hide' : 'dim' })}
          />
          Hide filtered
          <span
            className="toggle__count"
            title="Otherwise filtered neurons stay as dim context."
          >
            {display.contextMode === 'hide' ? 'cull' : 'dim'}
          </span>
        </label>
      </section>

      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Colour by</span>
        </div>
        <div className="btn-row">
          {colorModes.map((m) => (
            <button
              key={m.id}
              className={`btn${display.colorMode === m.id ? ' btn--active' : ''}`}
              disabled={!m.enabled}
              title={m.title}
              onClick={() => setDisplay({ colorMode: m.id })}
            >
              {m.label}
            </button>
          ))}
        </div>
      </section>

      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Level of detail</span>
        </div>
        <div className="btn-row">
          <button className="btn" onClick={() => rendererRef.current?.forceLod(null)}>
            Auto
          </button>
          <button className="btn" onClick={() => rendererRef.current?.forceLod('whole-brain')}>
            Whole brain
          </button>
          <button
            className="btn"
            onClick={() => rendererRef.current?.forceLod('local-circuit')}
          >
            Circuit
          </button>
        </div>
        <p className="faint" style={{ fontSize: 10.5, margin: '6px 0 0' }}>
          LOD follows camera distance. Synapse points and morphology are only permitted at
          circuit scale and closer.
        </p>
      </section>

      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Population</span>
        </div>
        <div className="kv">
          <dt>Loaded</dt>
          <dd>{index ? index.count.toLocaleString() : '—'}</dd>
          <dt>Visible</dt>
          <dd>{visibleCount.toLocaleString()}</dd>
          <dt>Filter</dt>
          <dd>{filterMs.toFixed(2)} ms</dd>
        </div>
      </section>
      <CircuitsPanel />
    </aside>
  );
}

function CellTypeToggle({
  type,
  checked,
  count,
  onToggle,
}: {
  type: CellPolarity;
  checked: boolean;
  count: number;
  onToggle: () => void;
}) {
  const color = rgbToCss(CELL_COLORS[type]);
  return (
    <label className="toggle" style={{ color: checked ? color : undefined }}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span className="swatch" style={{ background: color }} aria-hidden />
      <span style={{ color: 'var(--text-dim)' }}>{type}</span>
      <span className="toggle__count">{count.toLocaleString()}</span>
    </label>
  );
}
