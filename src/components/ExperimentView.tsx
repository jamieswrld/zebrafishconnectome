'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { loadReferenceBody } from '@/body/placement';
import { DataError, toDataError } from '@/core/errors';
import type { HmiCircuit, HmiPopulations } from '@/core/hmi';
import type { NeuronIndex } from '@/core/types';
import { EmbodiedRuntime } from '@/embodiment/runtime';
import {
  CONTROLLER_MODE_INFO,
  DEFAULT_EXPERIMENT_CONFIG,
  VisualMotionExperiment,
  type ControllerMode,
  type ExperimentConfig,
  type ExperimentSnapshot,
  type InspectedNeuron,
} from '@/embodiment/experiment';
import { loadHmiArtifacts } from '@/neural/loader';
import { MODELED_PROJECTIONS } from '@/neural/network';
import type { Ablation } from '@/neural/types';
import { BrainRenderer } from '@/renderer/BrainRenderer';
import { detectGpuSupport } from '@/renderer/types';
import { resolveAdapter, DEFAULT_DATASET_ID } from '@/datasets/registry';
import type { RendererStats } from '@/renderer/BrainRenderer';
import { ErrorNotice, InfoNotice } from './Badges';
import { HmiNeuronInspector } from './HmiNeuronInspector';
import { DecisionTimeline } from './DecisionTimeline';
import { HmiPanel } from './HmiPanel';
import { StimulusView } from './StimulusView';

/**
 * VISUAL MOTION DECISION - the Phase 3 experiment.
 *
 * Two views side by side: the world the animal is in, and the brain that is
 * deciding. The point of showing them together is that the user can watch
 * something happen in the circuit BEFORE anything happens to the body.
 *
 * Performance notes, because this page runs a renderer, a physics loop and a
 * neural model at once:
 *   - the neural model steps at a fixed 200 Hz inside the behaviour tick
 *   - activity reaches the GPU at most once per rendered frame, as a sparse
 *     update covering only the HMI cells, never the whole 30k population
 *   - React state updates are throttled to 15 Hz; the panels do not need to
 *     re-render 60 times a second and re-rendering them that often is the most
 *     expensive thing this page could do
 */

/** Which neurons the brain viewport shows. */
type ViewMode = 'all' | 'hmi' | 'active' | 'input' | 'output';

const VIEW_MODES: readonly { id: ViewMode; label: string }[] = [
  { id: 'all', label: 'ALL BRAIN' },
  { id: 'hmi', label: 'HMI ONLY' },
  { id: 'active', label: 'ACTIVE' },
  { id: 'input', label: 'INPUT' },
  { id: 'output', label: 'OUTPUT' },
];

/** UI refresh rate, Hz. The simulation is unaffected by this. */
const UI_HZ = 15;

/** GPU activity upload rate, Hz. The model still steps at 200 Hz. */
const ACTIVITY_HZ = 30;

const COHERENCE_STEPS = [0, 0.2, 0.4, 0.6, 0.8, 1];

export function ExperimentView() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<BrainRenderer | null>(null);
  const experimentRef = useRef<VisualMotionExperiment | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef(performance.now());
  const lastUiRef = useRef(0);
  const lastActivityRef = useRef(0);
  const lastFlowRef = useRef(0);
  const trailRef = useRef<[number, number][]>([]);
  const indexRef = useRef<NeuronIndex | null>(null);
  const hmiIndicesRef = useRef<Int32Array>(new Int32Array(0));
  const viewModeRef = useRef<ViewMode>('all');
  const scrubRef = useRef<number | null>(null);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<DataError | null>(null);
  const [circuit, setCircuit] = useState<HmiCircuit | null>(null);
  const [populations, setPopulations] = useState<HmiPopulations | null>(null);
  const [snapshot, setSnapshot] = useState<ExperimentSnapshot | null>(null);
  const [config, setConfig] = useState<ExperimentConfig>(DEFAULT_EXPERIMENT_CONFIG);
  const [mode, setMode] = useState<ControllerMode>('neural');
  const [viewMode, setViewMode] = useState<ViewMode>('all');
  const [running, setRunning] = useState(false);
  const [inspected, setInspected] = useState<InspectedNeuron | null>(null);
  const [pickedOutsideCircuit, setPickedOutsideCircuit] = useState(false);
  const [tick, setTick] = useState(0);
  const [signalFlow, setSignalFlow] = useState(false);
  const signalFlowRef = useRef(false);
  const [stats, setStats] = useState<RendererStats | null>(null);
  const [uploadCount, setUploadCount] = useState(0);
  /**
   * Diagnostics and benchmark switches, read once. `bench=1` forces continuous
   * rendering and auto-starts, because a still camera legitimately draws
   * nothing and a benchmark would then measure the idle path.
   */
  const optionsRef = useRef({
    debug: false,
    bench: false,
    idle: false,
    dataset: DEFAULT_DATASET_ID,
  });

  /* ---------------------------------------------------- URL configuration */
  // Read once on mount. Configuration only: no model state ever goes in a URL.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    optionsRef.current = {
      debug: params.get('debug') === '1',
      bench: params.get('bench') === '1',
      // Continuous rendering with the runtime present but no stimulus, so the
      // cost of an idle model can be compared against a running one.
      idle: params.get('idle') === '1',
      dataset: params.get('dataset') || DEFAULT_DATASET_ID,
    };
    const direction = params.get('direction');
    const coherence = params.get('coherence');
    const seed = params.get('seed');
    const loop = params.get('loop');
    setConfig((previous) => ({
      ...previous,
      seed: seed ? Number(seed) || previous.seed : previous.seed,
      loopMode: loop === 'open' || loop === 'closed' ? loop : previous.loopMode,
      stimulus: {
        ...previous.stimulus,
        direction:
          direction === 'left' || direction === 'right'
            ? direction
            : previous.stimulus.direction,
        coherence: coherence
          ? Math.min(Math.max(Number(coherence) || 0, 0), 1)
          : previous.stimulus.coherence,
      },
    }));
  }, []);

  /* ------------------------------------------------------------- setup */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;

    void (async () => {
      try {
        const support = await detectGpuSupport();
        if (!support.webgpu && !support.webgl2) {
          throw new Error('Neither WebGPU nor WebGL2 is available in this browser.');
        }

        // The circuit is required. If it will not load, say so and stop: a
        // spatial guess must never stand in for the measured circuit.
        const artifacts = await loadHmiArtifacts();
        if (disposed) return;
        setCircuit(artifacts.circuit);
        setPopulations(artifacts.populations);

        const renderer = await BrainRenderer.create({
          canvas,
          preferredApi: 'auto',
          reducedMotion:
            typeof window !== 'undefined' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches,
          callbacks: {
            onStats: setStats,
            onSelect: (neuronIndex) => {
              const current = experimentRef.current;
              if (!current || neuronIndex < 0) {
                setInspected(null);
                setPickedOutsideCircuit(false);
                return;
              }
              const node = current.nodeForNeuronIndex(neuronIndex);
              if (node === null) {
                // Most loaded soma are not HMI cells. Say so plainly rather
                // than showing circuit state for a cell that has none.
                setInspected(null);
                setPickedOutsideCircuit(true);
                return;
              }
              setPickedOutsideCircuit(false);
              setInspected(current.inspect(node));
            },
          },
        });
        if (disposed) {
          renderer.dispose();
          return;
        }
        rendererRef.current = renderer;
        renderer.setColorMode('activity');
        renderer.setActivityEnabled(true);
        if (optionsRef.current.bench) renderer.setContinuousRendering(true);

        const { geometry } = await loadReferenceBody();
        if (disposed) return;
        const embodied = new EmbodiedRuntime({ bones: geometry.bones, seed: config.seed });

        // The structural dataset gives the HMI cells somewhere to be drawn.
        let index: NeuronIndex | null = null;
        try {
          const adapter = resolveAdapter(optionsRef.current.dataset);
          index = await adapter.neuronIndex();
          if (disposed) return;
          renderer.setNeuronIndex(index);
          indexRef.current = index;
        } catch (e) {
          console.warn('Structural dataset unavailable; the circuit still runs.', e);
        }

        const experiment = new VisualMotionExperiment({
          embodied,
          circuit: artifacts.circuit,
          populations: artifacts.populations,
          neuronIndex: index,
        });
        experimentRef.current = experiment;
        experiment.configure(config);

        // Cache the HMI cells' indices in the loaded population so the view
        // modes can mask on them without rebuilding the map every time.
        hmiIndicesRef.current = experiment.activityUpdate().indices;

        setReady(true);
        lastFrameRef.current = performance.now();
        if (optionsRef.current.bench && !optionsRef.current.idle) {
          experiment.configure({
            ...config,
            stimulus: { ...config.stimulus, coherence: 1, duration: 3600 },
          });
          experiment.start();
          setRunning(true);
        }

        const loop = () => {
          if (disposed) return;
          rafRef.current = requestAnimationFrame(loop);
          const now = performance.now();
          const realDt = Math.min((now - lastFrameRef.current) / 1000, 0.1);
          lastFrameRef.current = now;

          const current = experimentRef.current;
          if (!current) return;
          const snap = current.update(realDt);

          // Activity upload, capped at ACTIVITY_HZ.
          //
          // The model steps at 200 Hz, but there is no point moving simulated
          // rates to the GPU faster than a display can show them. Profiling
          // also showed there is no buffer-level sparsity to exploit: the 865
          // HMI cells are interleaved through the 30,346 loaded soma with a
          // mean gap of 32, so any range-based scheme covers essentially the
          // whole span. Capping the rate is the win that was actually
          // available; an indexed indirection is the next step if the circuit
          // grows. See docs/NEURAL_RUNTIME.md.
          if (now - lastActivityRef.current > 1000 / ACTIVITY_HZ) {
            lastActivityRef.current = now;
            const activity = current.activityUpdate();
            if (activity.indices.length > 0) {
              renderer.setActivitySparse(activity.indices, activity.values);
            }
          }

          const position = snap.runtime.body.position;
          const trail = trailRef.current;
          if (
            trail.length === 0 ||
            Math.hypot(
              position[0] - trail[trail.length - 1][0],
              position[2] - trail[trail.length - 1][1],
            ) > 0.15
          ) {
            trail.push([position[0], position[2]]);
            if (trail.length > 400) trail.shift();
          }

          if (viewModeRef.current === 'active') applyViewMask('active');

          // Signal flow shares the activity cadence: it is a view of the same
          // model state, and there is no reason to rebuild it more often.
          if (signalFlowRef.current && now - lastFlowRef.current > 1000 / ACTIVITY_HZ) {
            lastFlowRef.current = now;
            renderer.setOverlayLines(current.signalFlow((i) => renderer.worldPositionOf(i)));
          }

          if (now - lastUiRef.current > 1000 / UI_HZ) {
            lastUiRef.current = now;
            setSnapshot(snap);
            if (optionsRef.current.debug) setUploadCount(renderer.lastActivityUploadCount());
            // Refresh the inspected cell so its rate and trace stay live.
            const following = current.neuronTrace.following();
            if (following >= 0) setInspected(current.inspect(following));
          }
        };
        rafRef.current = requestAnimationFrame(loop);
      } catch (e) {
        if (!disposed) setError(toDataError(e));
      }
    })();

    return () => {
      disposed = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rendererRef.current?.dispose();
      rendererRef.current = null;
      experimentRef.current = null;
    };
    // Built once; configuration changes are applied through `configure`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --------------------------------------------------------- view modes */

  const applyViewMask = useCallback(
    (requested: ViewMode) => {
      const renderer = rendererRef.current;
      const index = indexRef.current;
      const experiment = experimentRef.current;
      if (!renderer || !index) return;

      if (requested === 'all') {
        renderer.applyVisibilityMask(new Uint8Array(index.count).fill(1));
        renderer.setGlobalDim(0);
        return;
      }

      const mask = new Uint8Array(index.count);
      const hmi = hmiIndicesRef.current;

      if (requested === 'hmi') {
        for (const i of hmi) if (i >= 0) mask[i] = 1;
      } else if (requested === 'active' && experiment) {
        const activity = experiment.activityUpdate();
        for (let i = 0; i < activity.indices.length; i++) {
          if (activity.values[i] > 0.02) mask[activity.indices[i]] = 1;
        }
      } else if (experiment && circuit && populations) {
        const wanted = requested === 'input' ? 'input-layer' : null;
        const byLore = new Map<number, number>();
        for (let i = 0; i < index.count; i++) byLore.set(index.loreIds[i], i);
        if (wanted) {
          const population = populations.populations.find((p) => p.id === wanted);
          for (const lore of population?.loreIds ?? []) {
            const target = byLore.get(lore);
            if (target !== undefined) mask[target] = 1;
          }
        } else {
          // Output pathway: the measured descending spinal projection neurons.
          for (const population of populations.populations) {
            if (!population.id.startsWith('spn')) continue;
            for (const lore of population.loreIds) {
              const target = byLore.get(lore);
              if (target !== undefined) mask[target] = 1;
            }
          }
        }
      }
      renderer.applyVisibilityMask(mask);
    },
    [circuit, populations],
  );

  useEffect(() => {
    viewModeRef.current = viewMode;
    applyViewMask(viewMode);
  }, [viewMode, applyViewMask]);

  useEffect(() => {
    signalFlowRef.current = signalFlow;
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (!signalFlow) renderer.setOverlayLines(null);
  }, [signalFlow]);

  /* ----------------------------------------------------------- controls */

  const apply = useCallback((next: ExperimentConfig) => {
    setConfig(next);
    experimentRef.current?.configure(next);
    setTick((t) => t + 1);
  }, []);

  const start = useCallback(() => {
    const experiment = experimentRef.current;
    if (!experiment) return;
    trailRef.current = [];
    experiment.configure(config);
    experiment.start();
    setRunning(true);
  }, [config]);

  const pause = useCallback(() => {
    const experiment = experimentRef.current;
    if (!experiment) return;
    if (experiment.isRunning()) {
      experiment.pause();
      setRunning(false);
    } else {
      experiment.resume();
      setRunning(true);
    }
  }, []);

  const reset = useCallback(() => {
    const experiment = experimentRef.current;
    if (!experiment) return;
    experiment.reset();
    trailRef.current = [];
    rendererRef.current?.clearActivity();
    setRunning(false);
    setSnapshot(null);
    setTick((t) => t + 1);
  }, []);

  const setControllerMode = useCallback((next: ControllerMode) => {
    experimentRef.current?.setControllerMode(next);
    rendererRef.current?.clearActivity();
    setMode(next);
  }, []);

  const toggleAblation = useCallback(
    (ablation: Ablation) => {
      const existing = config.ablations.some((a) => a.id === ablation.id);
      apply({
        ...config,
        ablations: existing
          ? config.ablations.filter((a) => a.id !== ablation.id)
          : [...config.ablations, ablation],
      });
    },
    [config, apply],
  );

  const download = useCallback(() => {
    const experiment = experimentRef.current;
    if (!experiment) return;
    const result = experiment.result();
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${result.experimentId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }, []);

  const shareLink = useCallback(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams({
      direction: config.stimulus.direction,
      coherence: config.stimulus.coherence.toFixed(2),
      seed: String(config.seed),
      loop: config.loopMode,
    });
    const url = `${window.location.origin}${window.location.pathname}?${params}`;
    void navigator.clipboard?.writeText(url);
    window.history.replaceState(null, '', `?${params}`);
  }, [config]);

  /* -------------------------------------------------------------- render */

  const experiment = experimentRef.current;
  const network = experiment?.currentNetwork() ?? null;

  const ABLATIONS: readonly { ablation: Ablation; note: string }[] = [
    {
      ablation: {
        id: 'ablate-cross',
        label: 'Class II crossed inhibition',
        target: { kind: 'projection', projectionId: MODELED_PROJECTIONS[0].id },
      },
      note: 'Removes the one MODELED pathway. Tests how much the behaviour rests on it.',
    },
    {
      ablation: {
        id: 'ablate-recurrence',
        label: 'Class I ipsilateral recurrence',
        target: { kind: 'recurrence', className: 'I' },
      },
      note: 'Removes the 300 MEASURED recurrent pairs that produce the integration.',
    },
    {
      ablation: {
        id: 'ablate-left',
        label: 'Left hemisphere',
        target: { kind: 'hemisphere', hemisphere: 'left' },
      },
      note: 'Silences one side entirely. Decisions in one direction become impossible.',
    },
    {
      ablation: {
        id: 'ablate-readout',
        label: 'SPN_turning readout',
        target: { kind: 'class', className: 'SPN_turning' },
      },
      note: 'Silences the measured descending output the decision is read from.',
    },
  ];

  if (error) {
    return (
      <div className="content" style={{ padding: 24 }}>
        <ErrorNotice error={error} />
        <InfoNotice title="Neural model unavailable">
          The HMI circuit artefact could not be loaded, so the connectome-driven controller
          cannot run. The world and the baseline procedural controller are unaffected. Nothing
          has been substituted for the measured circuit.
        </InfoNotice>
      </div>
    );
  }

  return (
    <div className="experiment">
      {/* ------------------------------------------------------- controls */}
      <aside className="panel panel--left" aria-label="Experiment controls">
        <section className="panel-section">
          <div className="panel-section__head">
            <span className="label">Experiment</span>
            <span className="num faint">
              {snapshot ? `${snapshot.runtime.simulationTime.toFixed(3)} s` : '0.000 s'}
            </span>
          </div>
          <div className="btn-row">
            <button className="btn" onClick={start} disabled={!ready}>
              START
            </button>
            <button className="btn" onClick={pause} disabled={!ready}>
              {running ? 'PAUSE' : 'RESUME'}
            </button>
            <button className="btn" onClick={reset} disabled={!ready}>
              RESET
            </button>
          </div>
          <p className="faint" style={{ fontSize: 10.5, margin: '6px 0 0' }}>
            Visual motion decision. A configuration plus a seed fully determines the run.
          </p>
        </section>

        <section className="panel-section">
          <div className="panel-section__head">
            <span className="label">Controller</span>
            <span className={`badge ${mode === 'neural' ? 'badge--real' : 'badge--warn'}`}>
              {snapshot?.connectomeCoupled ? 'COUPLING ON' : 'COUPLING OFF'}
            </span>
          </div>
          <div className="btn-row">
            {(['neural', 'baseline', 'manual'] as const).map((id) => (
              <button
                key={id}
                className={`btn${mode === id ? ' btn--active' : ''}`}
                onClick={() => setControllerMode(id)}
              >
                {CONTROLLER_MODE_INFO[id].label}
              </button>
            ))}
          </div>
          <p className="faint" style={{ fontSize: 10.5, margin: '6px 0 0' }}>
            {CONTROLLER_MODE_INFO[mode].description}
          </p>
        </section>

        <section className="panel-section">
          <div className="panel-section__head">
            <span className="label">Motion</span>
          </div>
          <div className="btn-row">
            {(['left', 'right'] as const).map((direction) => (
              <button
                key={direction}
                className={`btn${config.stimulus.direction === direction ? ' btn--active' : ''}`}
                onClick={() =>
                  apply({ ...config, stimulus: { ...config.stimulus, direction } })
                }
              >
                {direction === 'left' ? '← LEFT' : 'RIGHT →'}
              </button>
            ))}
          </div>

          <div className="slider-row">
            <span className="label">Coherence</span>
            <span className="num">{(config.stimulus.coherence * 100).toFixed(0)}%</span>
          </div>
          <div className="btn-row">
            {COHERENCE_STEPS.map((value) => (
              <button
                key={value}
                className={`btn${Math.abs(config.stimulus.coherence - value) < 0.01 ? ' btn--active' : ''}`}
                onClick={() =>
                  apply({ ...config, stimulus: { ...config.stimulus, coherence: value } })
                }
              >
                {(value * 100).toFixed(0)}
              </button>
            ))}
          </div>

          <label className="slider-row">
            <span className="label">Speed</span>
            <input
              className="range"
              type="range"
              min={0.1}
              max={1.5}
              step={0.05}
              value={config.stimulus.speed}
              onChange={(e) =>
                apply({
                  ...config,
                  stimulus: { ...config.stimulus, speed: Number(e.target.value) },
                })
              }
            />
            <span className="num">{config.stimulus.speed.toFixed(2)} rad/s</span>
          </label>

          <label className="slider-row">
            <span className="label">Duration</span>
            <input
              className="range"
              type="range"
              min={2}
              max={40}
              step={1}
              value={config.stimulus.duration}
              onChange={(e) =>
                apply({
                  ...config,
                  stimulus: { ...config.stimulus, duration: Number(e.target.value) },
                })
              }
            />
            <span className="num">{config.stimulus.duration.toFixed(0)} s</span>
          </label>

          <label className="slider-row">
            <span className="label">Noise</span>
            <input
              className="range"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={config.stimulus.noise}
              onChange={(e) =>
                apply({
                  ...config,
                  stimulus: { ...config.stimulus, noise: Number(e.target.value) },
                })
              }
            />
            <span className="num">{config.stimulus.noise.toFixed(2)}</span>
          </label>
        </section>

        <section className="panel-section">
          <div className="panel-section__head">
            <span className="label">Loop</span>
          </div>
          <div className="btn-row">
            {(['open', 'closed'] as const).map((loop) => (
              <button
                key={loop}
                className={`btn${config.loopMode === loop ? ' btn--active' : ''}`}
                onClick={() => apply({ ...config, loopMode: loop })}
              >
                {loop.toUpperCase()}
              </button>
            ))}
          </div>
          <p className="faint" style={{ fontSize: 10.5, margin: '6px 0 0' }}>
            {config.loopMode === 'closed'
              ? "The fish's own rotation subtracts from the retinal motion, so turning toward the pattern reduces the evidence driving the turn."
              : 'Retinal motion is the stimulus alone. The animal cannot affect what it sees.'}
          </p>
        </section>

        <section className="panel-section">
          <div className="panel-section__head">
            <span className="label">Seed</span>
            <span className="num faint">{config.seed}</span>
          </div>
          <div className="btn-row">
            {[1, 7, 42, 99].map((seed) => (
              <button
                key={seed}
                className={`btn${config.seed === seed ? ' btn--active' : ''}`}
                onClick={() => apply({ ...config, seed })}
              >
                {seed}
              </button>
            ))}
          </div>
          <div className="btn-row">
            <button className="btn btn--block" onClick={shareLink}>
              COPY SHAREABLE LINK
            </button>
          </div>
          <div className="btn-row">
            <button className="btn btn--block" onClick={download} disabled={!ready}>
              DOWNLOAD RESULT (JSON)
            </button>
          </div>
        </section>

        <section className="panel-section">
          <div className="panel-section__head">
            <span className="label">In silico ablation</span>
            <span className="badge badge--warn">MODEL ONLY</span>
          </div>
          {ABLATIONS.map(({ ablation, note }) => {
            const active = config.ablations.some((a) => a.id === ablation.id);
            return (
              <div key={ablation.id} className="projection">
                <button
                  className={`btn btn--block${active ? ' btn--active' : ''}`}
                  onClick={() => toggleAblation(ablation)}
                >
                  {active ? 'RESTORE' : 'ABLATE'} · {ablation.label}
                </button>
                <p className="faint" style={{ fontSize: 10.5, margin: '4px 0 0' }}>
                  {note}
                </p>
              </div>
            );
          })}
          <p className="faint" style={{ fontSize: 10.5, margin: '6px 0 0' }}>
            Ablations change the MODEL, not an animal. Re-run with the same seed to compare
            against the control run.
          </p>
        </section>
      </aside>

      {/* --------------------------------------------------------- viewports */}
      <div className="experiment__stage">
        <div className="experiment__views">
          <div className="experiment__view">
            <div className="experiment__view-head">
              <span className="label">World / fish</span>
              <span className="faint num">
                {snapshot
                  ? `${snapshot.runtime.body.distanceTravelled.toFixed(1)} mm swum`
                  : '—'}
              </span>
            </div>
            <StimulusView
              stimulus={config.stimulus}
              evidence={snapshot?.evidence ?? null}
              body={snapshot?.runtime.body ?? null}
              active={snapshot?.stimulusActive ?? false}
              trail={trailRef.current}
            />
          </div>

          <div className="experiment__view">
            <div className="experiment__view-head">
              <span className="label">Brain / HMI</span>
              <div className="btn-row">
                {VIEW_MODES.map((entry) => (
                  <button
                    key={entry.id}
                    className={`btn${viewMode === entry.id ? ' btn--active' : ''}`}
                    onClick={() => setViewMode(entry.id)}
                  >
                    {entry.label}
                  </button>
                ))}
                <button
                  className={`btn${signalFlow ? ' btn--active' : ''}`}
                  onClick={() => setSignalFlow((on) => !on)}
                  title="Draw measured synaptic contacts, brightened by how much the model is currently driving them"
                >
                  SIGNAL FLOW
                </button>
              </div>
            </div>
            <div className="viewport-wrap">
              <canvas ref={canvasRef} className="viewport-canvas" />
              <span className="viewport-badges">
                <span className="badge">POSITIONS MEASURED</span>
                <span className="badge badge--warn">ACTIVITY SIMULATED</span>
                {signalFlow ? (
                  <span className="badge badge--warn">SIMULATED PROPAGATION</span>
                ) : null}
              </span>
              {optionsRef.current.debug && stats ? (
                <div className="debug">
                  <div className="debug__head">DIAGNOSTICS</div>
                  <DebugRow k="api" v={stats.api} />
                  <DebugRow k="render fps" v={stats.renderFps.toFixed(1)} />
                  <DebugRow k="cpu frame" v={`${stats.cpuFrameMs.toFixed(2)} ms`} />
                  <DebugRow k="draw calls" v={String(stats.drawCalls)} />
                  <DebugRow k="mesh triangles" v={stats.meshTriangles.toLocaleString()} />
                  <DebugRow k="soma total" v={stats.somaTotal.toLocaleString()} />
                  <DebugRow
                    k="gpu buffers"
                    v={`${(stats.gpuBufferBytes / (1024 * 1024)).toFixed(2)} MB`}
                  />
                  <DebugRow
                    k="neural step"
                    v={`${(snapshot?.neuralStepMs ?? 0).toFixed(3)} ms`}
                  />
                  <DebugRow
                    k="sim update"
                    v={`${(snapshot?.runtime.updateMs ?? 0).toFixed(3)} ms`}
                  />
                  <DebugRow k="activity upload" v={`${uploadCount} neurons`} />
                  <DebugRow
                    k="hmi nodes"
                    v={network ? network.nodeCount.toLocaleString() : '0'}
                  />
                  <div className="debug__row">{stats.device}</div>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {/* ------------------------------------------------------- readout */}
        <div className="experiment__readout">
          <div className="hud__block">
            <div className="hud__label">Evidence</div>
            <div className="hud__value">
              L {(snapshot?.evidence.leftwardEvidence ?? 0).toFixed(2)} · R{' '}
              {(snapshot?.evidence.rightwardEvidence ?? 0).toFixed(2)}
            </div>
            <div className="hud__sub">simulated sensor</div>
          </div>
          <div className="hud__block">
            <div className="hud__label">Decision</div>
            <div className="hud__value">
              {snapshot?.populations
                ? Math.abs(snapshot.populations.decisionVariable) >=
                  snapshot.populations.threshold
                  ? snapshot.populations.decisionVariable > 0
                    ? 'RIGHT'
                    : 'LEFT'
                  : 'PENDING'
                : '—'}
            </div>
            <div className="hud__sub">
              {snapshot?.populations
                ? `dv ${snapshot.populations.decisionVariable.toFixed(3)}`
                : 'integrating'}
            </div>
          </div>
          <div className="hud__block">
            <div className="hud__label">Action</div>
            <div className="hud__value">
              {snapshot?.intent
                ? snapshot.intent.action === 'turn_right'
                  ? 'TURN RIGHT'
                  : 'TURN LEFT'
                : 'NONE'}
            </div>
            <div className="hud__sub">
              {snapshot?.intent
                ? `latency ${snapshot.intent.evidence.latency.toFixed(3)} s`
                : '—'}
            </div>
          </div>
          <div className="hud__block">
            <div className="hud__label">Source</div>
            <div className="hud__value">
              {snapshot?.connectomeCoupled ? 'CONNECTOME' : 'PROCEDURAL'}
            </div>
            <div className="hud__sub">
              {snapshot?.connectomeCoupled ? 'constrained HMI simulation' : 'no connectome'}
            </div>
          </div>
          <div className="hud__block">
            <div className="hud__label">Neural step</div>
            <div className="hud__value">{(snapshot?.neuralStepMs ?? 0).toFixed(2)} ms</div>
            <div className="hud__sub">200 Hz fixed</div>
          </div>
        </div>

        {/* ------------------------------------------------------ timeline */}
        {experiment ? (
          <DecisionTimeline
            trace={experiment.trace}
            threshold={snapshot?.populations?.threshold ?? 0.15}
            currentTime={snapshot?.runtime.simulationTime ?? 0}
            onScrub={(time) => {
              scrubRef.current = time;
              setTick((t) => t + 1);
            }}
          />
        ) : null}
      </div>

      {/* ----------------------------------------------------------- panel */}
      {circuit && network ? (
        <HmiPanel
          inspector={
            inspected || pickedOutsideCircuit ? (
              <HmiNeuronInspector
                neuron={inspected}
                notInCircuit={pickedOutsideCircuit}
                ablated={config.ablations.some(
                  (a) => a.id === `ablate-node-${inspected?.node}`,
                )}
                onClose={() => {
                  setInspected(null);
                  setPickedOutsideCircuit(false);
                }}
                onIsolate={() => setViewMode('hmi')}
                onAblate={() => {
                  if (!inspected) return;
                  toggleAblation({
                    id: `ablate-node-${inspected.node}`,
                    label: `Neuron ${inspected.loreId}`,
                    target: { kind: 'neuron', node: inspected.node },
                  });
                }}
              />
            ) : null
          }
          circuit={circuit}
          network={network}
          populations={snapshot?.populations ?? null}
          intent={snapshot?.intent ?? null}
          provenance={experiment!.modelProvenance()}
          mappedNeurons={experiment!.mappedNeuronCount()}
        />
      ) : (
        <aside className="panel panel--right">
          <section className="panel-section">
            <div className="panel-section__head">
              <span className="label">Circuit</span>
            </div>
            <p className="faint">Loading the measured HMI circuit…</p>
          </section>
        </aside>
      )}
      <span className="sr-only">{tick}</span>
    </div>
  );
}

function DebugRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="debug__row">
      <span>{k}</span>
      <b>{v}</b>
    </div>
  );
}
