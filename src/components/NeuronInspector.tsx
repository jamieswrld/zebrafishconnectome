'use client';

import { cellTypeFromCode, type ConnectionPartner } from '@/core/types';
import {
  CELL_COLORS,
  COLOR_CIRCUIT_IN,
  COLOR_CIRCUIT_OUT,
  rgbToCss,
} from '@/renderer/backends/palette';
import { unresolvedPartners, useBrainStore } from '@/state/brainStore';
import { rendererRef } from '@/state/rendererRef';
import { ErrorNotice, InfoNotice, ProvenanceBadge } from './Badges';

/**
 * Right panel: everything known about the selected neuron.
 *
 * Two rules govern this component:
 *
 *  1. Only fields we actually possess are shown. A dataset without root IDs
 *     does not get an empty "Root ID" row.
 *  2. "No connections" and "the connectivity query failed" are rendered
 *     differently, always. Collapsing those two into a zero is the single most
 *     misleading thing a connectome viewer can do.
 */
export function NeuronInspector() {
  const index = useBrainStore((s) => s.index);
  const metadata = useBrainStore((s) => s.metadata);
  const selection = useBrainStore((s) => s.selection);
  const circuit = useBrainStore((s) => s.circuit);
  const skeleton = useBrainStore((s) => s.skeleton);
  const lookup = useBrainStore((s) => s.loreIdLookup);

  const requestConnections = useBrainStore((s) => s.requestConnections);
  const requestSkeleton = useBrainStore((s) => s.requestSkeleton);
  const clearCircuit = useBrainStore((s) => s.clearCircuit);
  const setIsolated = useBrainStore((s) => s.setIsolated);
  const selectLoreId = useBrainStore((s) => s.selectLoreId);
  const clearSelection = useBrainStore((s) => s.clearSelection);

  if (selection.index < 0 && !selection.loreId) {
    return (
      <aside className="panel panel--right" aria-label="Neuron inspector">
        <section className="panel-section">
          <div className="panel-section__head">
            <span className="label">Neuron</span>
          </div>
          <p className="faint" style={{ fontSize: 11.5, margin: 0 }}>
            Click a soma in the viewport, or press <kbd className="mono">/</kbd> to search by
            identifier.
          </p>
        </section>
      </aside>
    );
  }

  const { neuron } = selection;
  const capabilities = metadata?.capabilities;
  const localCellType =
    index && selection.index >= 0 ? cellTypeFromCode(index.cellTypes[selection.index]) : null;
  const cellType = neuron?.cellType ?? localCellType ?? 'unknown';
  const unresolved = unresolvedPartners(circuit.data, lookup);

  const incoming = circuit.data?.partners.filter((p) => p.direction === 'incoming') ?? [];
  const outgoing = circuit.data?.partners.filter((p) => p.direction === 'outgoing') ?? [];

  return (
    <aside className="panel panel--right" aria-label="Neuron inspector">
      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Neuron</span>
          <button className="btn" style={{ padding: '2px 6px' }} onClick={clearSelection}>
            Clear
          </button>
        </div>

        <div className="stat">
          <div className="label">Lore ID</div>
          <div className="value-lg">{selection.loreId ?? '—'}</div>
          <div className="faint" style={{ fontSize: 10 }}>
            Stable soma identifier. Unchanged by proofreading.
          </div>
        </div>

        {selection.loading ? (
          <p className="faint mono" style={{ fontSize: 11 }}>
            Loading metadata…
          </p>
        ) : null}

        {selection.error ? <ErrorNotice error={selection.error} compact /> : null}

        <dl className="kv">
          <dt>Cell type</dt>
          <dd style={{ color: rgbToCss(CELL_COLORS[cellType]) }}>
            {cellType}
            {neuron?.cellTypeRaw ? (
              <span className="faint"> ({neuron.cellTypeRaw})</span>
            ) : null}
          </dd>

          {neuron?.root ? (
            <>
              <dt>Root ID</dt>
              <dd>
                {neuron.root.rootId}
                <div className="faint" style={{ fontSize: 10 }}>
                  mat {neuron.root.materializationVersion ?? '—'}
                  {neuron.root.isLatest === null
                    ? ' · currency not checked'
                    : neuron.root.isLatest
                      ? ' · current'
                      : ' · superseded by an edit'}
                </div>
              </dd>
            </>
          ) : null}

          {neuron?.supervoxelId ? (
            <>
              <dt>Supervoxel</dt>
              <dd>{neuron.supervoxelId}</dd>
            </>
          ) : null}

          {neuron ? (
            <>
              <dt>Voxel</dt>
              <dd>
                {neuron.positionVoxel.map((v) => Math.round(v)).join(', ')}
                <div className="faint" style={{ fontSize: 10 }}>
                  source coordinates, {metadata?.voxelSpace.voxelSizeNm.join(' × ')} nm
                </div>
              </dd>
              <dt>Position</dt>
              <dd>{neuron.positionUm.map((v) => v.toFixed(1)).join(', ')} µm</dd>
            </>
          ) : null}

          {neuron?.regionId ? (
            <>
              <dt>Region</dt>
              <dd>
                {index?.regions.find((r) => r.id === neuron.regionId)?.name ?? neuron.regionId}
              </dd>
            </>
          ) : null}
        </dl>

        {neuron ? (
          <div style={{ marginTop: 8 }}>
            <ProvenanceBadge provenance={neuron.provenance} />
          </div>
        ) : null}
      </section>

      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Actions</span>
        </div>
        <div className="btn-row">
          <button
            className="btn"
            onClick={() => rendererRef.current?.focusIndex(selection.index)}
            disabled={selection.index < 0}
          >
            Focus
          </button>
          <button
            className={`btn${circuit.isolated ? ' btn--active' : ''}`}
            onClick={() => setIsolated(!circuit.isolated)}
            disabled={selection.index < 0}
            title="Restrict the visible population to this cell and its displayed partners."
          >
            Isolate
          </button>
          <button
            className="btn"
            onClick={() => void requestConnections({ direction: 'incoming' })}
            disabled={!capabilities?.connectivity || circuit.loading}
            title={
              capabilities?.connectivity
                ? 'Query presynaptic partners.'
                : 'This dataset does not provide connectivity.'
            }
          >
            Trace inputs
          </button>
          <button
            className="btn"
            onClick={() => void requestConnections({ direction: 'outgoing' })}
            disabled={!capabilities?.connectivity || circuit.loading}
          >
            Trace outputs
          </button>
          <button
            className="btn"
            onClick={() => void requestConnections({ direction: 'both' })}
            disabled={!capabilities?.connectivity || circuit.loading}
          >
            Both
          </button>
          <button
            className="btn"
            onClick={() => void requestSkeleton()}
            disabled={!capabilities?.skeletons || skeleton.loading}
            title={
              capabilities?.skeletons
                ? 'Fetch SWC morphology for this segment.'
                : 'This dataset does not provide skeletons.'
            }
          >
            Morphology
          </button>
          {circuit.data ? (
            <button className="btn" onClick={clearCircuit}>
              Clear circuit
            </button>
          ) : null}
        </div>

        {capabilities?.downloads && selection.loreId ? (
          <div className="btn-row" style={{ marginTop: 6 }}>
            {(['metadata', 'connectivity', 'swc'] as const).map((format) => (
              <a
                key={format}
                className="btn"
                style={{ borderBottom: '1px solid var(--border-strong)' }}
                href={`/api/neurons/${selection.loreId}/download?format=${format}&dataset=${metadata?.id}`}
              >
                ↓ {format}
              </a>
            ))}
          </div>
        ) : null}
      </section>

      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Connectivity</span>
          {circuit.data ? <ProvenanceBadge provenance={circuit.data.provenance} /> : null}
        </div>

        {!capabilities?.connectivity ? (
          <InfoNotice title="Not available">
            This dataset does not expose synaptic connectivity.
          </InfoNotice>
        ) : circuit.loading ? (
          <p className="faint mono" style={{ fontSize: 11 }}>
            Querying synapses…
          </p>
        ) : circuit.error ? (
          // Never rendered as zero. A failed query is its own state.
          <ErrorNotice error={circuit.error} compact />
        ) : !circuit.data ? (
          <p className="faint" style={{ fontSize: 11.5, margin: 0 }}>
            Not requested yet. Connectivity is fetched on demand, never at load.
          </p>
        ) : (
          <>
            <dl className="kv" style={{ gridTemplateColumns: '116px 1fr' }}>
              <dt>In synapses</dt>
              <dd>{circuit.data.totals.incomingSynapses.toLocaleString()}</dd>
              <dt>In partners</dt>
              <dd>{circuit.data.totals.incomingPartners.toLocaleString()}</dd>
              <dt>Out synapses</dt>
              <dd>{circuit.data.totals.outgoingSynapses.toLocaleString()}</dd>
              <dt>Out partners</dt>
              <dd>{circuit.data.totals.outgoingPartners.toLocaleString()}</dd>
              {circuit.data.totals.incomingExcitatory !== undefined ? (
                <>
                  <dt>In exc / inh</dt>
                  <dd>
                    {circuit.data.totals.incomingExcitatory.toLocaleString()} /{' '}
                    {(circuit.data.totals.incomingInhibitory ?? 0).toLocaleString()}
                  </dd>
                </>
              ) : null}
            </dl>

            {circuit.data.truncated ? (
              <div style={{ marginTop: 8 }}>
                <InfoNotice title="Result truncated">
                  {circuit.data.truncationReason ??
                    'Results were capped. Totals reflect the capped set only.'}
                </InfoNotice>
              </div>
            ) : null}

            {circuit.data.partners.length === 0 ? (
              <p className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>
                The query succeeded and returned no partners above the current threshold.
              </p>
            ) : null}

            {unresolved.length > 0 ? (
              <p className="faint" style={{ fontSize: 10.5, marginTop: 8 }}>
                {unresolved.length} partner{unresolved.length === 1 ? '' : 's'} could not be
                drawn: they have no soma annotation, or are absent from the loaded export. They
                are still listed below.
              </p>
            ) : null}

            {incoming.length > 0 ? (
              <PartnerList
                title="Inputs"
                color={rgbToCss(COLOR_CIRCUIT_IN)}
                partners={incoming}
                onSelect={selectLoreId}
              />
            ) : null}
            {outgoing.length > 0 ? (
              <PartnerList
                title="Outputs"
                color={rgbToCss(COLOR_CIRCUIT_OUT)}
                partners={outgoing}
                onSelect={selectLoreId}
              />
            ) : null}
          </>
        )}
      </section>

      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Morphology</span>
        </div>
        {!capabilities?.skeletons ? (
          <p className="faint" style={{ fontSize: 11.5, margin: 0 }}>
            Not provided by this dataset.
          </p>
        ) : skeleton.loading ? (
          <p className="faint mono" style={{ fontSize: 11 }}>
            Fetching skeleton…
          </p>
        ) : skeleton.error ? (
          <ErrorNotice error={skeleton.error} compact />
        ) : skeleton.data ? (
          <dl className="kv">
            <dt>Vertices</dt>
            <dd>{skeleton.data.vertexCount.toLocaleString()}</dd>
            <dt>Root ID</dt>
            <dd>{skeleton.data.rootId}</dd>
          </dl>
        ) : (
          <p className="faint" style={{ fontSize: 11.5, margin: 0 }}>
            Not requested. Skeleton rendering lands in the next milestone; the data path is live
            and the download works today.
          </p>
        )}
      </section>
    </aside>
  );
}

function PartnerList({
  title,
  color,
  partners,
  onSelect,
}: {
  title: string;
  color: string;
  partners: ConnectionPartner[];
  onSelect: (loreId: never) => void;
}) {
  return (
    <div style={{ marginTop: 10 }}>
      <div className="label" style={{ marginBottom: 4 }}>
        {title} · {partners.length}
      </div>
      <ul className="partner-list">
        {partners.map((p) => (
          <li key={`${p.direction}-${p.rootId ?? p.loreId}`}>
            <button
              className="partner"
              disabled={!p.loreId}
              onClick={() => p.loreId && onSelect(p.loreId as never)}
              title={
                p.loreId
                  ? `Select neuron ${p.loreId}`
                  : 'This partner segment has no soma annotation, so it cannot be selected.'
              }
            >
              <span className="partner__bar" style={{ background: color }} aria-hidden />
              <span>{p.loreId ?? <span className="faint">no soma · {p.rootId}</span>}</span>
              <span className="partner__count">{p.synapseCount}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
