'use client';

import { BODY_DISPLAY_MODES, type BodyDisplayMode } from '@/renderer/types';
import { REGISTRATION_METHOD_INFO } from '@/core/spaces';
import { FISH1_AXES } from '@/core/transforms';
import { useBrainStore } from '@/state/brainStore';
import { CLIP_AXIS_LABEL, useOrganismStore, type ClipAxis } from '@/state/organismStore';
import { ErrorNotice, InfoNotice, ProvenanceBadge } from './Badges';

const MODES: BodyDisplayMode[] = ['off', 'ghost', 'tissue', 'solid', 'xray'];
const AXES: ClipAxis[] = ['none', 'sagittal', 'coronal', 'transverse'];

/**
 * Left panel in organism mode: how much body to draw, and where to cut it.
 *
 * The registration block is the important part. The body is a modeled
 * reference, not the Fish1 specimen, and where it sits relative to the neurons
 * is an approximate alignment. Both facts are stated here rather than left for
 * a reader to discover.
 */
export function AnatomyPanel() {
  const organism = useOrganismStore();
  const index = useBrainStore((s) => s.index);
  const metadata = useBrainStore((s) => s.metadata);

  return (
    <aside className="panel panel--left" aria-label="Anatomy controls">
      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Body</span>
          {organism.loaded ? <span className="badge badge--warn">MODELED</span> : null}
        </div>

        {organism.error ? (
          <ErrorNotice error={organism.error} compact />
        ) : organism.loading ? (
          <p className="faint mono" style={{ fontSize: 11 }}>
            Loading reference body…
          </p>
        ) : null}

        <div className="btn-row">
          {MODES.map((mode) => (
            <button
              key={mode}
              className={`btn${organism.displayMode === mode ? ' btn--active' : ''}`}
              onClick={() => organism.setDisplayMode(mode)}
              title={BODY_DISPLAY_MODES[mode].description}
              disabled={!organism.loaded && mode !== 'off'}
            >
              {BODY_DISPLAY_MODES[mode].label}
            </button>
          ))}
        </div>
        <p className="faint" style={{ fontSize: 10.5, margin: '6px 0 0' }}>
          {BODY_DISPLAY_MODES[organism.displayMode].description}
        </p>
      </section>

      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Section</span>
          {organism.clip.axis !== 'none' ? (
            <span className="num faint">{organism.clip.offset.toFixed(2)}</span>
          ) : null}
        </div>
        <div className="btn-row">
          {AXES.map((axis) => (
            <button
              key={axis}
              className={`btn${organism.clip.axis === axis ? ' btn--active' : ''}`}
              onClick={() => organism.setClip({ axis })}
              disabled={!organism.loaded}
            >
              {CLIP_AXIS_LABEL[axis]}
            </button>
          ))}
        </div>

        {organism.clip.axis !== 'none' ? (
          <>
            <input
              className="range"
              style={{ marginTop: 8 }}
              type="range"
              min={-1.4}
              max={1.4}
              step={0.01}
              value={organism.clip.offset}
              onChange={(e) => organism.setClip({ offset: Number(e.target.value) })}
              aria-label="Section plane position"
            />
            <label className="toggle">
              <input
                type="checkbox"
                checked={organism.clip.flipped}
                onChange={(e) => organism.setClip({ flipped: e.target.checked })}
              />
              Flip side
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={organism.clip.affectsSoma}
                onChange={(e) => organism.setClip({ affectsSoma: e.target.checked })}
              />
              Cut neurons too
              <span className="toggle__count" title="Otherwise only the body surface is cut.">
                {organism.clip.affectsSoma ? 'both' : 'body'}
              </span>
            </label>
          </>
        ) : null}
      </section>

      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">View</span>
        </div>
        <div className="btn-row">
          <button className="btn" onClick={organism.frameWholeFish} disabled={!organism.loaded}>
            Whole fish
          </button>
          <button className="btn" onClick={organism.frameBrain}>
            Brain
          </button>
        </div>
      </section>

      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Provenance</span>
        </div>
        <dl className="kv" style={{ gridTemplateColumns: '74px 1fr' }}>
          <dt>Neurons</dt>
          <dd>
            {metadata?.title ?? '—'}
            <div style={{ marginTop: 3 }}>
              <ProvenanceBadge provenance="measured" />
            </div>
          </dd>
          <dt>Body</dt>
          <dd>
            Larval reference, ~7 dpf
            <div className="faint" style={{ fontSize: 10 }}>
              modeled, not the Fish1 specimen
            </div>
          </dd>
          {organism.registration ? (
            <>
              <dt>Registration</dt>
              <dd>
                {
                  REGISTRATION_METHOD_INFO[
                    organism.registration.steps[1]?.method ?? 'manual-approximate'
                  ].label
                }
                <div className="faint" style={{ fontSize: 10 }}>
                  error{' '}
                  {organism.registration.errorEstimateUm === null
                    ? 'not quantified'
                    : `${organism.registration.errorEstimateUm} µm`}
                </div>
              </dd>
            </>
          ) : null}
          {organism.manifest ? (
            <>
              <dt>Geometry</dt>
              <dd>
                {organism.triangleCount.toLocaleString()} tris ·{' '}
                {(organism.bytes / 1024).toFixed(0)} KB
              </dd>
            </>
          ) : null}
        </dl>

        <div style={{ marginTop: 8 }}>
          <InfoNotice title="Approximate body registration">
            The body is a modeled reference larva placed around the measured neurons by a rigid
            alignment derived from the published volume aspect ratio. It is not an atlas
            registration, and its error is not quantified. Measured coordinates are unchanged.
          </InfoNotice>
        </div>
      </section>

      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Fish1 axes</span>
        </div>
        <dl className="kv" style={{ gridTemplateColumns: '30px 1fr' }}>
          {FISH1_AXES.map((axis) => (
            <div key={axis.axis} style={{ display: 'contents' }}>
              <dt>{axis.axis}</dt>
              <dd>
                {axis.positiveDirection} · {axis.extentUm} µm
                <div className="faint" style={{ fontSize: 10 }}>
                  {axis.confidence} confidence
                </div>
              </dd>
            </div>
          ))}
        </dl>
        <p className="faint" style={{ fontSize: 10.5, margin: '6px 0 0' }}>
          Derived from the published volume dimensions, not stated by the release. Raw Fish1
          coordinates still carry no anatomical direction labels.
        </p>
      </section>

      {index ? (
        <section className="panel-section">
          <div className="panel-section__head">
            <span className="label">Coverage</span>
          </div>
          <div className="kv">
            <dt>Shown</dt>
            <dd>{index.count.toLocaleString()} soma</dd>
          </div>
          <p className="faint" style={{ fontSize: 10.5, margin: '6px 0 0' }}>
            Neurons appear only where Fish1 actually measured them. This export covers the HMI
            analysis region; it is not the complete nervous system, and no cells are invented to
            fill the body.
          </p>
        </section>
      ) : null}
    </aside>
  );
}
