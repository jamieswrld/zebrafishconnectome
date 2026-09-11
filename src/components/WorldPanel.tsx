'use client';

import type { TimeScale } from '@/embodiment/clock';
import type { RuntimeSnapshot } from '@/embodiment/runtime';
import {
  PERMISSION_MODES,
  PLANNED_CAPABILITIES,
  SANDBOX_ECHO_CAPABILITY,
} from '@/embodiment/capabilities';
import { InfoNotice } from './Badges';

/**
 * Right panel in world mode: what the organism is doing and why.
 *
 * Every number here is a simulation variable. The headings say so explicitly,
 * because a bar labelled "threat 0.42" next to a swimming fish is exactly the
 * kind of thing a reader could mistake for a measurement of an animal.
 */
export function WorldPanel({
  snapshot,
  onTimeScale,
  timeScales,
}: {
  snapshot: RuntimeSnapshot | null;
  onTimeScale: (scale: TimeScale) => void;
  timeScales: readonly TimeScale[];
}) {
  return (
    <aside className="panel panel--right" aria-label="Organism state">
      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Clock</span>
          <span className="num faint">
            {snapshot ? `${snapshot.simulationTime.toFixed(1)}s` : '—'}
          </span>
        </div>
        <div className="btn-row">
          {timeScales.map((scale) => (
            <button
              key={scale}
              className={`btn${snapshot?.timeScale === scale ? ' btn--active' : ''}`}
              onClick={() => onTimeScale(scale)}
            >
              {scale === 0 ? 'PAUSE' : `${scale}x`}
            </button>
          ))}
        </div>
        <p className="faint" style={{ fontSize: 10.5, margin: '6px 0 0' }}>
          Physics 120 Hz, behaviour 15 Hz, both on fixed timesteps independent of the frame
          rate.
        </p>
      </section>

      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Controller</span>
          <span className="badge badge--warn">SIMULATED</span>
        </div>
        <dl className="kv" style={{ gridTemplateColumns: '92px 1fr' }}>
          <dt>Policy</dt>
          <dd>Procedural larval locomotion</dd>
          <dt>Connectome</dt>
          <dd>coupling OFF</dd>
        </dl>
        <p className="faint" style={{ fontSize: 10.5, margin: '6px 0 0' }}>
          Fish1 does not drive this motion. The controller exists to close the loop so a neural
          one can replace it at the same seam.
        </p>
      </section>

      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Motor command</span>
        </div>
        {snapshot ? (
          <dl className="kv" style={{ gridTemplateColumns: '92px 1fr' }}>
            <dt>Action</dt>
            <dd>{snapshot.selected?.action ?? 'GLIDE'}</dd>
            <dt>Forward</dt>
            <dd>{snapshot.motor.forwardDrive.toFixed(2)}</dd>
            <dt>Turn</dt>
            <dd>{snapshot.motor.turnDrive.toFixed(2)}</dd>
            <dt>Startle</dt>
            <dd>{snapshot.motor.startleDrive.toFixed(2)}</dd>
            <dt>Bout</dt>
            <dd>{snapshot.body.boutState}</dd>
          </dl>
        ) : (
          <p className="faint mono" style={{ fontSize: 11 }}>
            waiting...
          </p>
        )}
        {snapshot?.selected ? (
          <p className="faint" style={{ fontSize: 10.5, margin: '6px 0 0' }}>
            {snapshot.selected.reason} · {snapshot.selected.source}
          </p>
        ) : null}
      </section>

      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Drives</span>
          <span className="badge badge--warn">SIMULATED</span>
        </div>
        {snapshot && snapshot.drives.length > 0 ? (
          snapshot.drives.map((drive) => (
            <div key={drive.id} style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                <span className="muted">{drive.id}</span>
                <span className="num">{drive.value.toFixed(2)}</span>
              </div>
              <div style={{ height: 2, background: 'var(--border)' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${Math.min(Math.max(drive.value, 0), 1) * 100}%`,
                    background: 'var(--prov-simulated)',
                  }}
                />
              </div>
            </div>
          ))
        ) : (
          <p className="faint mono" style={{ fontSize: 11 }}>
            waiting...
          </p>
        )}
        <p className="faint" style={{ fontSize: 10.5, margin: '6px 0 0' }}>
          Control-system scalars, not feelings and not measurements. They describe this program,
          not any animal.
        </p>
      </section>

      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Agent state</span>
          <span className="badge badge--warn">SIMULATED</span>
        </div>
        {snapshot ? (
          <dl className="kv" style={{ gridTemplateColumns: '92px 1fr' }}>
            <dt>Energy</dt>
            <dd>{snapshot.agent.energy.toFixed(2)}</dd>
            <dt>Arousal</dt>
            <dd>{snapshot.agent.arousal.toFixed(2)}</dd>
            <dt>Novelty</dt>
            <dd>{snapshot.agent.novelty.toFixed(2)}</dd>
            <dt>Threat est.</dt>
            <dd>{snapshot.agent.threatEstimate.toFixed(2)}</dd>
          </dl>
        ) : null}
      </section>

      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">External capabilities</span>
        </div>
        <dl className="kv" style={{ gridTemplateColumns: '92px 1fr' }}>
          <dt>{SANDBOX_ECHO_CAPABILITY.id}</dt>
          <dd>
            {PERMISSION_MODES.observe.label}
            <div className="faint" style={{ fontSize: 10 }}>
              no I/O of any kind
            </div>
          </dd>
        </dl>
        <div style={{ marginTop: 8 }}>
          <InfoNotice title="No external access">
            The organism can only request capabilities that are explicitly registered. Exactly
            one is, it performs no network, filesystem or system access, and it is in OBSERVE
            mode. {PLANNED_CAPABILITIES.length} further capabilities are designed for and
            deliberately not registered.
          </InfoNotice>
        </div>
      </section>
    </aside>
  );
}
