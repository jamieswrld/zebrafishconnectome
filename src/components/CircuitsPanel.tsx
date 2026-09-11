'use client';

import { useCallback, useState } from 'react';

import type { HmiCircuit, HmiPopulations } from '@/core/hmi';
import { loadHmiArtifacts } from '@/neural/loader';
import { rendererRef } from '@/state/rendererRef';
import { useBrainStore } from '@/state/brainStore';
import { InfoNotice } from './Badges';

/**
 * CIRCUITS: named, reconstructed circuits inside the whole connectome.
 *
 * This is what makes the scientific circuit discoverable from the connectome
 * viewer rather than only from the experiment page. Selecting one focuses the
 * cells that actually belong to it - by published label, never by a bounding
 * box - and explains what is known about it.
 */

interface CircuitDescription {
  readonly id: string;
  readonly name: string;
  readonly function: string;
  readonly structure: string;
  readonly data: string;
  readonly activity: string;
  readonly output: string;
  readonly citations: readonly string[];
}

const HMI_DESCRIPTION: CircuitDescription = {
  id: 'hmi',
  name: 'Hindbrain motion integrator',
  function: 'Evidence accumulation for directional visuomotor decisions.',
  structure:
    'Recurrent ipsilateral integration by Class I cells, whose 300 traced recurrent pairs all stay within one hemisphere, combined with interhemispheric competition through Class II cells, whose axons cross the midline and which are 92% Gad1b where labelled.',
  data: 'Fish1 structural connectomics: manually reconstructed cells with traced synaptic contacts.',
  activity:
    'Simulated. The Fish1 release is a structural EM dataset and contains no recorded activity for these cells.',
  output:
    'Descending spinal projection neurons, which are the measured output of this reconstruction. The spinal pattern generator and the musculature are not reconstructed.',
  citations: [
    'Petkova, M. D., Januszewski, M., et al. (2025). A connectomic resource for neural cataloguing and circuit dissection of the larval zebrafish brain. bioRxiv.',
    'Boulanger-Weill, J., et al. Correlative light and electron microscopy reveals the fine circuit structure underlying evidence accumulation in larval zebrafish.',
  ],
};

export function CircuitsPanel() {
  const [circuit, setCircuit] = useState<HmiCircuit | null>(null);
  const [populations, setPopulations] = useState<HmiPopulations | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const neuronIndex = useBrainStore((state) => state.index);

  const load = useCallback(async () => {
    if (circuit) return { circuit, populations };
    setLoading(true);
    setError(null);
    try {
      const artifacts = await loadHmiArtifacts();
      setCircuit(artifacts.circuit);
      setPopulations(artifacts.populations);
      return { circuit: artifacts.circuit, populations: artifacts.populations };
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, [circuit, populations]);

  const focus = useCallback(async () => {
    const loaded = await load();
    if (!loaded?.circuit) return; // load() has already reported why.
    const renderer = rendererRef.current;
    // Say what is missing rather than doing nothing: a button that silently
    // fails is worse than one that explains itself.
    if (!renderer) {
      setError('The renderer is still starting up. Try again in a moment.');
      return;
    }
    if (!neuronIndex) {
      setError('No structural dataset is loaded, so there is nowhere to draw the circuit.');
      return;
    }

    // Membership is by stable lore id, which is the only identifier that means
    // the same thing in both artefacts.
    const byLore = new Map<number, number>();
    for (let i = 0; i < neuronIndex.count; i++) byLore.set(neuronIndex.loreIds[i], i);

    const mask = new Uint8Array(neuronIndex.count);
    let found = 0;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < loaded.circuit.neuronCount; i++) {
      const target = byLore.get(loaded.circuit.loreIds[i]);
      if (target === undefined) continue;
      mask[target] = 1;
      found++;
      const world = renderer.worldPositionOf(target);
      if (world) {
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], world[axis]);
          max[axis] = Math.max(max[axis], world[axis]);
        }
      }
    }
    if (found === 0) {
      setError('No HMI cells are present in the currently loaded dataset.');
      return;
    }
    renderer.applyVisibilityMask(mask);
    if (Number.isFinite(min[0])) renderer.frameBounds(min, max);
    setFocused(true);
  }, [load, neuronIndex]);

  const clearFocus = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer || !neuronIndex) return;
    renderer.applyVisibilityMask(new Uint8Array(neuronIndex.count).fill(1));
    renderer.resetCamera();
    setFocused(false);
  }, [neuronIndex]);

  return (
    <section className="panel-section">
      <div className="panel-section__head">
        <span className="label">Circuits</span>
        <span className="badge">1 RECONSTRUCTED</span>
      </div>

      <div className="projection">
        <div className="projection__head">
          <span>{HMI_DESCRIPTION.name}</span>
          <span className="badge badge--real">MEASURED</span>
        </div>

        <dl className="kv" style={{ gridTemplateColumns: '76px 1fr', marginTop: 6 }}>
          <dt>Function</dt>
          <dd>{HMI_DESCRIPTION.function}</dd>
          <dt>Structure</dt>
          <dd>{HMI_DESCRIPTION.structure}</dd>
          <dt>Data</dt>
          <dd>{HMI_DESCRIPTION.data}</dd>
          <dt>Activity</dt>
          <dd>{HMI_DESCRIPTION.activity}</dd>
          <dt>Output</dt>
          <dd>{HMI_DESCRIPTION.output}</dd>
        </dl>

        {circuit ? (
          <dl className="kv" style={{ gridTemplateColumns: '76px 1fr', marginTop: 6 }}>
            <dt>Cells</dt>
            <dd className="num">{circuit.neuronCount.toLocaleString()} with a soma position</dd>
            <dt>Contacts</dt>
            <dd className="num">
              {circuit.edgeCount.toLocaleString()} pairs ·{' '}
              {circuit.synapseCount.toLocaleString()} synapses
            </dd>
            <dt>Traced from</dt>
            <dd className="num">{circuit.tracing.cellsWithTracedContacts} cells</dd>
          </dl>
        ) : null}

        {populations ? (
          <ul className="evidence-list">
            {populations.populations.map((population) => (
              <li key={population.id}>
                <strong>{population.label}</strong> — {population.loreIds.length} cells.{' '}
                {population.definition}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="btn-row" style={{ marginTop: 8 }}>
          <button
            className="btn"
            onClick={focused ? clearFocus : () => void focus()}
            disabled={loading}
          >
            {loading ? 'LOADING…' : focused ? 'SHOW ALL' : 'FOCUS CIRCUIT'}
          </button>
          <a className="btn" href="/experiments/visual-motion">
            SIMULATE
          </a>
        </div>

        {error ? (
          <p
            className="faint"
            style={{ fontSize: 10.5, margin: '6px 0 0', color: 'var(--error)' }}
          >
            {error}
          </p>
        ) : null}

        <p className="faint" style={{ fontSize: 10.5, margin: '8px 0 0' }}>
          Citations:{' '}
          {HMI_DESCRIPTION.citations.map((citation, index) => (
            <span key={citation}>
              {index > 0 ? ' ' : ''}
              {citation}
            </span>
          ))}
        </p>
      </div>

      <InfoNotice title="Membership is by published label">
        Cells belong to this circuit because the release publishes a label for them, not because
        they fall inside a region of space. A cell with no published label is not an HMI cell.
      </InfoNotice>
    </section>
  );
}
