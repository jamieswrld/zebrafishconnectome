'use client';

import type { HmiCircuit } from '@/core/hmi';
import type { NeuralModelProvenance, NeuralMotorIntent, PopulationState } from '@/neural/types';
import { NEURAL_MODEL_CATEGORY_INFO, SIGN_POLICY_INFO } from '@/neural/types';
import { MODELED_PROJECTIONS, SENSORY_INTERFACE, type NeuralNetwork } from '@/neural/network';
import { InfoNotice } from './Badges';

/**
 * The circuit panel: left versus right, and what the decision rests on.
 *
 * The population values shown here are SUMMARIES for a reader. The model does
 * not reduce itself to them - it integrates 1,730 nodes - and the panel says so
 * rather than implying the circuit is six numbers.
 */

function BilateralBar({
  label,
  left,
  right,
  neuronCount,
}: {
  label: string;
  left: number;
  right: number;
  neuronCount: number;
}) {
  const scale = (v: number) => `${Math.min(Math.max(v, 0), 1) * 100}%`;
  return (
    <div className="bilateral">
      <div className="bilateral__head">
        <span>{label}</span>
        <span className="faint num">{neuronCount}</span>
      </div>
      <div className="bilateral__bars">
        <div className="bilateral__side bilateral__side--left">
          <span className="bilateral__fill" style={{ width: scale(left) }} />
        </div>
        <div className="bilateral__side">
          <span className="bilateral__fill" style={{ width: scale(right) }} />
        </div>
      </div>
      <div className="bilateral__nums">
        <span className="num">{left.toFixed(3)}</span>
        <span className="faint">L · R</span>
        <span className="num">{right.toFixed(3)}</span>
      </div>
    </div>
  );
}

export function HmiPanel({
  circuit,
  network,
  populations,
  intent,
  provenance,
  mappedNeurons,
  inspector,
}: {
  circuit: HmiCircuit;
  network: NeuralNetwork;
  populations: PopulationState | null;
  intent: NeuralMotorIntent | null;
  provenance: NeuralModelProvenance;
  mappedNeurons: number;
  /** Rendered at the top of the panel when a circuit neuron is selected. */
  inspector?: React.ReactNode;
}) {
  const decision = populations?.decisionVariable ?? 0;
  const threshold = populations?.threshold ?? 0.15;
  const crossed = Math.abs(decision) >= threshold;
  const pop = (id: string) => populations?.populations.find((p) => p.id === id);

  return (
    <aside className="panel panel--right" aria-label="Hindbrain motion integrator">
      {inspector}
      {/* ---------------------------------------------------------- coupling */}
      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Connectome coupling</span>
          <span className={`badge ${crossed ? 'badge--real' : ''}`}>ON</span>
        </div>
        <dl className="kv" style={{ gridTemplateColumns: '104px 1fr' }}>
          <dt>Decision network</dt>
          <dd>Fish1 HMI</dd>
          <dt>Connectivity</dt>
          <dd>
            MEASURED <span className="faint">· {circuit.edgeCount} traced pairs</span>
          </dd>
          <dt>Dynamics</dt>
          <dd>MODELED</dd>
          <dt>Neural activity</dt>
          <dd>SIMULATED</dd>
          <dt>Motor plant</dt>
          <dd>PROCEDURAL</dd>
        </dl>
      </section>

      {/* -------------------------------------------------------- decision */}
      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Decision variable</span>
          <span className="num faint">
            {decision >= 0 ? '+' : ''}
            {decision.toFixed(3)}
          </span>
        </div>
        <div className="decision-meter">
          <span
            className="decision-meter__threshold"
            style={{ left: `${50 - (threshold / 0.4) * 50}%` }}
          />
          <span
            className="decision-meter__threshold"
            style={{ left: `${50 + (threshold / 0.4) * 50}%` }}
          />
          <span
            className={`decision-meter__fill${crossed ? ' decision-meter__fill--crossed' : ''}`}
            style={{
              left: decision >= 0 ? '50%' : `${50 + (decision / 0.4) * 50}%`,
              width: `${Math.min(Math.abs(decision) / 0.4, 1) * 50}%`,
            }}
          />
        </div>
        <div className="bilateral__nums">
          <span className="faint">LEFT</span>
          <span className="faint">threshold ±{threshold.toFixed(2)}</span>
          <span className="faint">RIGHT</span>
        </div>
        <p className="faint" style={{ fontSize: 10.5, margin: '6px 0 0' }}>
          Difference between the mean simulated rate of the measured SPN_turning population on
          each side.
        </p>
      </section>

      {/* ----------------------------------------------------- populations */}
      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Populations</span>
          <span className="badge badge--warn">SIMULATED</span>
        </div>
        {(['I', 'II', 'SPN_turning', 'SPN_forward'] as const).map((id) => {
          const entry = pop(id);
          if (!entry) return null;
          return (
            <BilateralBar
              key={id}
              label={entry.label}
              left={entry.left}
              right={entry.right}
              neuronCount={entry.neuronCount}
            />
          );
        })}
        <p className="faint" style={{ fontSize: 10.5, margin: '6px 0 0' }}>
          Population means, shown for readability. The model integrates all{' '}
          {network.nodeCount.toLocaleString()} nodes individually.
        </p>
      </section>

      {/* -------------------------------------------------------- decision */}
      {intent ? (
        <section className="panel-section">
          <div className="panel-section__head">
            <span className="label">Last action</span>
            <span className="badge badge--real">
              {intent.action === 'turn_right' ? 'TURN RIGHT' : 'TURN LEFT'}
            </span>
          </div>
          <dl className="kv" style={{ gridTemplateColumns: '104px 1fr' }}>
            <dt>Source</dt>
            <dd>Connectome-constrained HMI simulation</dd>
            <dt>Decision var</dt>
            <dd className="num">{intent.evidence.decisionVariable.toFixed(4)}</dd>
            <dt>Threshold</dt>
            <dd className="num">{intent.evidence.threshold.toFixed(2)}</dd>
            <dt>Crossed at</dt>
            <dd className="num">{intent.time.toFixed(3)} s</dd>
            <dt>Latency</dt>
            <dd className="num">{intent.evidence.latency.toFixed(3)} s from onset</dd>
            <dt>Confidence</dt>
            <dd className="num">{intent.confidence.toFixed(2)}</dd>
            <dt>Execution</dt>
            <dd>procedural turn bout</dd>
          </dl>
        </section>
      ) : null}

      {/* --------------------------------------------------------- network */}
      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Network</span>
          <span className="faint num">{network.nodeCount.toLocaleString()} nodes</span>
        </div>
        <dl className="kv" style={{ gridTemplateColumns: '104px 1fr' }}>
          <dt>Measured cells</dt>
          <dd className="num">{network.stats.measuredNodes.toLocaleString()}</dd>
          <dt>Mirror cells</dt>
          <dd className="num">
            {network.stats.mirroredNodes.toLocaleString()}{' '}
            <span className="faint">derived</span>
          </dd>
          <dt>Excitatory</dt>
          <dd className="num">{network.stats.excitatoryEdges.toLocaleString()} edges</dd>
          <dt>Inhibitory</dt>
          <dd className="num">{network.stats.inhibitoryEdges.toLocaleString()} edges</dd>
          <dt>Unsigned</dt>
          <dd className="num">
            {network.stats.unsignedEdges.toLocaleString()}{' '}
            <span className="faint">no drive</span>
          </dd>
          <dt>Sign policy</dt>
          <dd>{SIGN_POLICY_INFO[network.options.signPolicy].label}</dd>
          <dt>Drawn on brain</dt>
          <dd className="num">{mappedNeurons.toLocaleString()} cells</dd>
        </dl>
      </section>

      {/* ------------------------------------------------------ provenance */}
      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">What is real</span>
          <span className="badge">{NEURAL_MODEL_CATEGORY_INFO[provenance.category].label}</span>
        </div>
        <dl className="kv" style={{ gridTemplateColumns: '118px 1fr' }}>
          <dt>Neuron position</dt>
          <dd>MEASURED</dd>
          <dt>Connectivity</dt>
          <dd>MEASURED</dd>
          <dt>E/I identity</dt>
          <dd>MEASURED where labelled</dd>
          <dt>Functional class</dt>
          <dd>PREDICTED from morphology</dd>
          <dt>Hemisphere</dt>
          <dd>DERIVED from the fitted midline</dd>
          <dt>Neural activity</dt>
          <dd>SIMULATED</dd>
          <dt>Visual input</dt>
          <dd>SIMULATED</dd>
          <dt>Body movement</dt>
          <dd>SIMULATED</dd>
        </dl>
      </section>

      {/* ------------------------------------------------------- modeled */}
      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Modeled pathways</span>
          <span className="badge badge--warn">{network.projections.length} ACTIVE</span>
        </div>
        {MODELED_PROJECTIONS.map((projection) => {
          const enabled = network.projections.some((p) => p.id === projection.id);
          return (
            <div key={projection.id} className="projection">
              <div className="projection__head">
                <span>{projection.label}</span>
                <span className={`badge ${enabled ? 'badge--warn' : ''}`}>
                  {enabled ? 'ON' : 'ABLATED'}
                </span>
              </div>
              <p className="faint" style={{ fontSize: 10.5, margin: '4px 0' }}>
                {projection.justification}
              </p>
              <ul className="evidence-list">
                {projection.evidence.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          );
        })}
        <InfoNotice title="Sensory interface is modeled">
          {SENSORY_INTERFACE.justification} {SENSORY_INTERFACE.convention}
        </InfoNotice>
      </section>

      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Limits</span>
        </div>
        <ul className="evidence-list">
          {provenance.caveats.map((caveat) => (
            <li key={caveat}>{caveat}</li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
