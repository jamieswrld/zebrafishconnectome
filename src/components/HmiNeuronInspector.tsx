'use client';

import {
  CLASSIFICATION_PROVENANCE_INFO,
  HMI_CLASS_INFO,
  type ClassificationProvenance,
} from '@/core/hmi';
import type { InspectedNeuron } from '@/embodiment/experiment';

/**
 * One HMI neuron, inspected during a run.
 *
 * The organising rule of this panel is the horizontal rule in the middle of it:
 * everything above comes from the reconstruction, everything below is model
 * output. A simulated trace here is labelled SIMULATED and never called a
 * recording, because the Fish1 release contains no activity data at all.
 */

function ProvenanceTag({ provenance }: { provenance: ClassificationProvenance }) {
  const info = CLASSIFICATION_PROVENANCE_INFO[provenance];
  const measured =
    provenance === 'molecularly_measured' || provenance === 'functionally_measured';
  return (
    <span
      className={`badge ${measured ? 'badge--real' : 'badge--warn'}`}
      title={info.description}
    >
      {info.label}
    </span>
  );
}

/** A tiny sparkline of the recorded simulated rate. */
function Sparkline({ values }: { values: Float32Array }) {
  if (values.length < 2) {
    return (
      <p className="faint" style={{ fontSize: 10.5, margin: '4px 0 0' }}>
        No simulated state recorded yet. Start a run to follow this cell.
      </p>
    );
  }
  const width = 220;
  const height = 34;
  let peak = 0;
  for (const value of values) peak = Math.max(peak, value);
  const scale = peak > 0 ? peak : 1;
  const step = width / (values.length - 1);
  let path = '';
  for (let i = 0; i < values.length; i++) {
    const x = i * step;
    const y = height - (values[i] / scale) * (height - 2) - 1;
    path += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)} `;
  }
  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Recent simulated rate"
    >
      <path d={path} fill="none" stroke="var(--prov-simulated)" strokeWidth={1.2} />
    </svg>
  );
}

export function HmiNeuronInspector({
  neuron,
  notInCircuit,
  onClose,
  onIsolate,
  onAblate,
  ablated,
}: {
  neuron: InspectedNeuron | null;
  /** A neuron was picked, but it is not part of the reconstructed circuit. */
  notInCircuit: boolean;
  onClose: () => void;
  onIsolate: () => void;
  onAblate: () => void;
  ablated: boolean;
}) {
  if (notInCircuit) {
    return (
      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Selected neuron</span>
          <button className="btn" onClick={onClose}>
            CLOSE
          </button>
        </div>
        <p className="faint" style={{ fontSize: 11 }}>
          This soma is not part of the reconstructed HMI circuit. It has a measured position in
          Fish1, but no traced connectivity in this artefact and no state in the model. That is
          &ldquo;not reconstructed&rdquo;, not &ldquo;inactive&rdquo;.
        </p>
      </section>
    );
  }

  if (!neuron) return null;

  const sign =
    neuron.modelSign > 0
      ? 'excitatory'
      : neuron.modelSign < 0
        ? 'inhibitory'
        : 'no signed drive';

  return (
    <section className="panel-section">
      <div className="panel-section__head">
        <span className="label">Neuron {neuron.loreId}</span>
        <button className="btn" onClick={onClose}>
          CLOSE
        </button>
      </div>

      {/* ------------------------------------------------ measured/published */}
      <dl className="kv" style={{ gridTemplateColumns: '104px 1fr' }}>
        <dt>Lore ID</dt>
        <dd className="num">{neuron.loreId}</dd>
        <dt>Root ID</dt>
        <dd className="num" style={{ wordBreak: 'break-all' }}>
          {neuron.rootId === '0' ? 'not published' : neuron.rootId}
        </dd>
        <dt>Position</dt>
        <dd className="num">{neuron.positionVoxels.join(', ')} vox</dd>
        <dt>Hemisphere</dt>
        <dd>
          {neuron.hemisphere.toUpperCase()}{' '}
          <span className="faint">derived from the midline</span>
        </dd>
      </dl>

      <div className="panel-section__head" style={{ marginTop: 8 }}>
        <span className="label">Classification</span>
      </div>
      <dl className="kv" style={{ gridTemplateColumns: '104px 1fr' }}>
        <dt>Class</dt>
        <dd>
          {HMI_CLASS_INFO[neuron.className].label}{' '}
          <span className="faint">{HMI_CLASS_INFO[neuron.className].sourceClassifier}</span>
        </dd>
        <dt>Class source</dt>
        <dd>
          <ProvenanceTag provenance={neuron.classProvenance} />
        </dd>
        <dt>Label specificity</dt>
        <dd className="num">
          {neuron.classConfidence.toFixed(2)}{' '}
          {neuron.classConfidence < 1 ? (
            <span className="faint">the release itself hedges this label</span>
          ) : null}
        </dd>
        <dt>Neurotransmitter</dt>
        <dd>
          {neuron.transmitter.toUpperCase()}{' '}
          {neuron.transmitter === 'unknown' ? (
            <span className="faint">never published for this cell</span>
          ) : null}
        </dd>
        <dt>E/I source</dt>
        <dd>
          <ProvenanceTag provenance={neuron.transmitterProvenance} />
        </dd>
      </dl>
      <p className="faint" style={{ fontSize: 10.5, margin: '6px 0 0' }}>
        {HMI_CLASS_INFO[neuron.className].description}
      </p>

      <div className="panel-section__head" style={{ marginTop: 8 }}>
        <span className="label">Measured connectivity</span>
        <span className="badge badge--real">MEASURED</span>
      </div>
      <dl className="kv" style={{ gridTemplateColumns: '104px 1fr' }}>
        <dt>Incoming</dt>
        <dd className="num">
          {neuron.incoming} partners · {neuron.incomingSynapses} synapses
        </dd>
        <dt>Outgoing</dt>
        <dd className="num">
          {neuron.outgoing} partners · {neuron.outgoingSynapses} synapses
        </dd>
      </dl>
      {neuron.outgoing === 0 ? (
        <p className="faint" style={{ fontSize: 10.5, margin: '6px 0 0' }}>
          No outgoing contacts were traced from this cell. Outputs were traced from only 46 seed
          cells, so this means not traced, not that the cell has no partners.
        </p>
      ) : null}

      {/* -------------------------------------------------------- simulated */}
      <div className="panel-section__head" style={{ marginTop: 10 }}>
        <span className="label">Model state</span>
        <span className="badge badge--warn">SIMULATED</span>
      </div>
      <dl className="kv" style={{ gridTemplateColumns: '104px 1fr' }}>
        <dt>Current rate</dt>
        <dd className="num">{neuron.simulatedRate.toFixed(4)}</dd>
        <dt>Model sign</dt>
        <dd>
          {sign}
          {neuron.signConfidence > 0 && neuron.signConfidence < 1 ? (
            <span className="faint"> · imputed, weight {neuron.signConfidence.toFixed(2)}</span>
          ) : null}
        </dd>
      </dl>
      <Sparkline values={neuron.history} />
      <p className="faint" style={{ fontSize: 10.5, margin: '4px 0 0' }}>
        Simulated rate over recent time. This is model output, not recorded calcium: the Fish1
        release contains no activity data for any cell.
      </p>

      <div className="btn-row" style={{ marginTop: 8 }}>
        <button className="btn" onClick={onIsolate}>
          ISOLATE
        </button>
        <button className={`btn${ablated ? ' btn--active' : ''}`} onClick={onAblate}>
          {ablated ? 'RESTORE' : 'ABLATE'}
        </button>
      </div>
      <p className="faint" style={{ fontSize: 10.5, margin: '6px 0 0' }}>
        Ablating silences this cell in the MODEL only, and is reversible.
      </p>
    </section>
  );
}
