'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BrainRenderer, type RendererStats } from '@/renderer/BrainRenderer';
import { detectGpuSupport } from '@/renderer/types';
import { TIME_SCALES, type TimeScale } from '@/embodiment/clock';
import { EmbodiedRuntime, type RuntimeSnapshot } from '@/embodiment/runtime';
import {
  DEFAULT_EXPERIMENT_CONFIG,
  VisualMotionExperiment,
  type ControllerMode,
  type ExperimentSnapshot,
} from '@/embodiment/experiment';
import { loadHmiArtifacts } from '@/neural/loader';
import { computeBodyPlacement, loadReferenceBody } from '@/body/placement';
import { resolveAdapter, DEFAULT_DATASET_ID } from '@/datasets/registry';
import { buildTank } from '@/world/tank';
import { composeTRS, invert, mat4, multiply, type Mat4 } from '@/renderer/math';
import { BODY_LENGTH_UM } from '@/core/transforms';
import type { AgentEvent } from '@/embodiment/types';
import { AppHeader } from './AppHeader';
import { ErrorNotice } from './Badges';
import { WorldPanel } from './WorldPanel';
import { EventFeed } from './EventFeed';

/**
 * World mode: the organism swimming in a simulated tank.
 *
 * This is a genuinely closed loop running every tick — world state, sensory
 * frame, behaviour policy, motor command, body mechanics, new world state — not
 * a looping animation. The fish stops where it stops because drag took its
 * momentum, and it turns because the controller chose to.
 *
 * It owns its own renderer instance. Entering the world is a real transition,
 * unlike BRAIN <-> ORGANISM which share one renderer and one camera.
 */

/** Render units per millimetre of world. Keeps the tank a comfortable size. */
const WORLD_SCALE = 0.12;
/** Body rest space is micrometres; the body model matrix converts to render units. */
const BODY_RENDER_SCALE = (WORLD_SCALE / 1000) * 1;

export type CameraMode = 'free' | 'follow' | 'top' | 'side';

export function WorldView() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<BrainRenderer | null>(null);
  const runtimeRef = useRef<EmbodiedRuntime | null>(null);
  const rafRef = useRef(0);
  const lastFrameRef = useRef(0);
  const bodyMatrix = useRef<Mat4>(mat4());

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  /**
   * The connectome-driven controller, available in world mode once the measured
   * HMI circuit has loaded. It wraps the SAME EmbodiedRuntime, so switching
   * controllers swaps the policy and nothing else about the world.
   */
  const experimentRef = useRef<VisualMotionExperiment | null>(null);
  const controllerModeRef = useRef<ControllerMode>('baseline');
  const [controllerMode, setControllerMode] = useState<ControllerMode>('baseline');
  const [neuralAvailable, setNeuralAvailable] = useState(false);
  const [neural, setNeural] = useState<ExperimentSnapshot | null>(null);
  const [stimulusDirection, setStimulusDirection] = useState<'left' | 'right'>('right');
  const [stats, setStats] = useState<RendererStats | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [cameraMode, setCameraMode] = useState<CameraMode>('follow');
  const cameraModeRef = useRef<CameraMode>('follow');
  const [debug, setDebug] = useState(false);
  const [showNeurons, setShowNeurons] = useState(false);
  const [neuronCount, setNeuronCount] = useState(0);
  const [solidBody, setSolidBody] = useState(true);
  /** dataset render space -> body rest space, used to carry neurons with the body. */
  const somaToBodyRest = useRef<Mat4>(mat4());
  const somaModel = useRef<Mat4>(mat4());

  useEffect(() => {
    cameraModeRef.current = cameraMode;
  }, [cameraMode]);

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

        const renderer = await BrainRenderer.create({
          canvas,
          preferredApi: 'auto',
          reducedMotion:
            typeof window !== 'undefined' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches,
          callbacks: { onStats: setStats },
        });
        if (disposed) {
          renderer.dispose();
          return;
        }
        rendererRef.current = renderer;

        const { geometry } = await loadReferenceBody();
        if (disposed) return;
        renderer.setBodyGeometry(geometry);
        renderer.setBodyDisplayMode('solid');
        // Hidden until the user asks for them; world mode is about behaviour.
        renderer.setGlobalDim(0);

        const runtime = new EmbodiedRuntime({ bones: geometry.bones, seed: 20250610 });
        runtimeRef.current = runtime;

        // The tank is static geometry uploaded once.
        const tank = buildTank(runtime.world.bounds, WORLD_SCALE);
        renderer.uploadMesh('world:tank', tank);
        renderer.setExtraMeshDraws([
          {
            meshId: 'world:tank',
            modelMatrix: mat4(),
            boneMatrices: null,
            material: 'environment',
            opacity: 0.16,
            rim: 0.3,
            tint: [1, 1, 1],
            occluding: false,
          },
        ]);

        // Start in FOLLOW at a few body lengths. A 4 mm larva in a 35 mm dish is
        // correctly about a tenth of the tank across, so framing the whole tank
        // leaves the animal an unreadable speck.
        const bodyLengthRender = (BODY_LENGTH_UM / 1000) * WORLD_SCALE;
        renderer.camera.applyPreset({
          id: 'follow',
          label: 'FOLLOW',
          yaw: 0.7,
          pitch: 0.55,
        });
        renderer.camera.focus([0, 0, 0], bodyLengthRender * 2.6);
        renderer.camera.snap();

        // The connectome is loaded lazily and only to be DISPLAYED inside the
        // moving body. Measured positions are uploaded once; the per-frame
        // somaModel matrix is what carries them along with the animal.
        void (async () => {
          try {
            const adapter = resolveAdapter(DEFAULT_DATASET_ID);
            const index = await adapter.neuronIndex();
            if (disposed) return;
            renderer.setNeuronIndex(index);
            setNeuronCount(index.count);

            // computeBodyPlacement gives bodyRest -> datasetRender; we need the
            // inverse so soma can be expressed in body rest space and then
            // placed by the same matrix that places the body.
            // setNeuronIndex re-frames the camera on the brain, so restore the
            // follow framing FIRST: a later failure must not leave the camera
            // pointing at the wrong thing.
            renderer.camera.focus(
              [
                runtime.position()[0] * WORLD_SCALE,
                runtime.position()[1] * WORLD_SCALE,
                runtime.position()[2] * WORLD_SCALE,
              ],
              bodyLengthRender * 2.6,
            );

            const placement = computeBodyPlacement(index, geometry);
            if (!invert(somaToBodyRest.current, placement.modelMatrix)) {
              throw new Error('Body placement matrix is not invertible.');
            }
          } catch (e) {
            // The world is fully usable without the connectome; showing the
            // neurons is an optional overlay. Report why rather than hiding it.
            console.warn('Connectome overlay unavailable:', e);
          }
        })();

        // The measured HMI circuit is optional in world mode: if it will not
        // load, the world still works and the neural controller is simply not
        // offered. Nothing is substituted for it.
        void (async () => {
          try {
            const artifacts = await loadHmiArtifacts();
            if (disposed) return;
            const experiment = new VisualMotionExperiment({
              embodied: runtime,
              circuit: artifacts.circuit,
              populations: artifacts.populations,
              neuronIndex: null,
            });
            experiment.configure({
              ...DEFAULT_EXPERIMENT_CONFIG,
              stimulus: { ...DEFAULT_EXPERIMENT_CONFIG.stimulus, duration: 3600 },
            });
            // Created in neural mode; put it back to baseline so world mode
            // starts where it did before.
            experiment.setControllerMode('baseline');
            experimentRef.current = experiment;
            setNeuralAvailable(true);
          } catch (e) {
            console.warn('HMI circuit unavailable; the neural controller is not offered.', e);
          }
        })();

        const unsubscribe = runtime.events.subscribe(() => {
          // Pull a window rather than appending per event: the feed is a view
          // of the log, and the log is already the source of truth.
          setEvents([...runtime.events.recent(40)].reverse());
        });

        setReady(true);
        lastFrameRef.current = performance.now();

        const loop = () => {
          if (disposed) return;
          rafRef.current = requestAnimationFrame(loop);

          const now = performance.now();
          const realDt = (now - lastFrameRef.current) / 1000;
          lastFrameRef.current = now;

          // In neural mode the experiment owns the tick, because it also has to
          // advance the stimulus and the network. It wraps the same runtime, so
          // everything below is unchanged.
          let snap: RuntimeSnapshot;
          const experiment = experimentRef.current;
          if (controllerModeRef.current === 'neural' && experiment) {
            const frame = experiment.update(realDt);
            snap = frame.runtime;
            setNeural(frame);
          } else {
            snap = runtime.update(realDt);
          }
          setSnapshot(snap);

          // Body placement: rest space (um) -> world (mm) -> render units.
          composeTRS(
            bodyMatrix.current,
            [
              snap.body.position[0] * WORLD_SCALE,
              snap.body.position[1] * WORLD_SCALE,
              snap.body.position[2] * WORLD_SCALE,
            ],
            // Heading is measured from +x toward +z; the body model faces +x.
            -snap.body.heading,
            BODY_RENDER_SCALE,
          );
          renderer.setBodyModelMatrix(bodyMatrix.current);
          renderer.setBodyPose(snap.body.pose);

          // Neurons ride the body: dataset render space -> body rest -> world.
          multiply(somaModel.current, bodyMatrix.current, somaToBodyRest.current);
          renderer.setSomaModelMatrix(somaModel.current);

          if (cameraModeRef.current === 'follow') {
            renderer.camera.focus([
              snap.body.position[0] * WORLD_SCALE,
              snap.body.position[1] * WORLD_SCALE,
              snap.body.position[2] * WORLD_SCALE,
            ]);
          }
        };
        rafRef.current = requestAnimationFrame(loop);

        return () => unsubscribe();
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
      }
    })();

    return () => {
      disposed = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, []);

  const setTimeScale = useCallback((scale: TimeScale) => {
    runtimeRef.current?.setTimeScale(scale);
  }, []);

  const applyControllerMode = useCallback(
    (mode: ControllerMode) => {
      const experiment = experimentRef.current;
      if (!experiment) return;
      experiment.setControllerMode(mode);
      controllerModeRef.current = mode;
      setControllerMode(mode);
      if (mode === 'neural') {
        experiment.configure({
          ...experiment.currentConfig(),
          // A long-running stimulus, so world mode shows sustained optomotor
          // behaviour rather than a single trial.
          stimulus: {
            ...experiment.currentConfig().stimulus,
            direction: stimulusDirection,
            duration: 3600,
          },
        });
        experiment.start();
      } else {
        setNeural(null);
      }
    },
    [stimulusDirection],
  );

  const applyStimulusDirection = useCallback((direction: 'left' | 'right') => {
    setStimulusDirection(direction);
    const experiment = experimentRef.current;
    if (!experiment || controllerModeRef.current !== 'neural') return;
    experiment.configure({
      ...experiment.currentConfig(),
      stimulus: { ...experiment.currentConfig().stimulus, direction, duration: 3600 },
    });
    experiment.start();
  }, []);

  const applyCamera = useCallback((mode: CameraMode) => {
    setCameraMode(mode);
    const renderer = rendererRef.current;
    const runtime = runtimeRef.current;
    if (!renderer || !runtime) return;
    const half = Math.max(runtime.world.bounds.halfWidth, runtime.world.bounds.halfDepth);
    if (mode === 'top') {
      renderer.camera.applyPreset({
        id: 'top',
        label: 'TOP',
        yaw: 0,
        pitch: Math.PI / 2 - 0.02,
      });
      renderer.frameBounds(
        [-half * WORLD_SCALE, -2, -half * WORLD_SCALE],
        [half * WORLD_SCALE, 2, half * WORLD_SCALE],
      );
    } else if (mode === 'side') {
      renderer.camera.applyPreset({ id: 'side', label: 'SIDE', yaw: 0, pitch: 0.05 });
      renderer.frameBounds(
        [-half * WORLD_SCALE, -2, -half * WORLD_SCALE],
        [half * WORLD_SCALE, 2, half * WORLD_SCALE],
      );
    } else if (mode === 'follow') {
      const bodyLength = (BODY_LENGTH_UM / 1000) * WORLD_SCALE;
      renderer.camera.applyPreset({ id: 'follow', label: 'FOLLOW', yaw: 0.7, pitch: 0.55 });
      renderer.camera.setDistance(bodyLength * 2.6);
    }
  }, []);

  const reset = useCallback(() => {
    runtimeRef.current?.reset();
    setEvents([]);
  }, []);

  return (
    <div className="shell">
      <AppHeader />

      <div className="workspace">
        <div className="viewport-wrap">
          <canvas
            ref={canvasRef}
            className="viewport-canvas"
            role="application"
            aria-label="Simulated tank containing the digital organism"
          />

          <p className="sr-only" aria-live="polite">
            {snapshot
              ? `Current action ${snapshot.selected?.action ?? 'none'}, bout state ${snapshot.body.boutState}.`
              : 'Simulation starting.'}
          </p>

          {ready && snapshot ? (
            <>
              <div className="hud">
                <div className="hud__block">
                  <div className="hud__label">Current action</div>
                  <div className="hud__value">{snapshot.selected?.action ?? 'GLIDE'}</div>
                  <div className="hud__sub">{snapshot.body.boutState}</div>
                </div>
                <div className="hud__block">
                  <div className="hud__label">Sim time</div>
                  <div className="hud__value">{snapshot.simulationTime.toFixed(1)}s</div>
                  <div className="hud__sub">{snapshot.timeScale.toFixed(2)}×</div>
                </div>
                <div className="hud__block">
                  <div className="hud__label">Distance</div>
                  <div className="hud__value">{snapshot.body.distanceTravelled.toFixed(0)}</div>
                  <div className="hud__sub">mm swum</div>
                </div>
              </div>

              <div className="viewport-badges">
                <span
                  className="badge badge--warn"
                  title="Nothing here is measured from Fish1."
                >
                  SIMULATED BODY MOTION
                </span>
                <span className="badge badge--warn">CONNECTOME COUPLING OFF</span>
                {showNeurons ? (
                  <span
                    className="badge badge--real"
                    title="Real Fish1 soma, carried by the body pose."
                  >
                    {neuronCount.toLocaleString()} MEASURED SOMA
                  </span>
                ) : null}
                <span className="badge">{stats?.api?.toUpperCase() ?? '—'}</span>
              </div>

              <div className="viewport-controls">
                {(['free', 'follow', 'top', 'side'] as CameraMode[]).map((mode) => (
                  <button
                    key={mode}
                    className={`btn${cameraMode === mode ? ' btn--active' : ''}`}
                    onClick={() => applyCamera(mode)}
                  >
                    {mode}
                  </button>
                ))}
                <button className="btn" onClick={reset}>
                  Reset
                </button>
                <button
                  className={`btn${solidBody ? ' btn--active' : ''}`}
                  onClick={() => {
                    const next = !solidBody;
                    setSolidBody(next);
                    rendererRef.current?.setBodyDisplayMode(next ? 'solid' : 'tissue');
                  }}
                  title="Solid body, or a ghost through which the neurons are visible."
                >
                  Body
                </button>
                <button
                  className={`btn${showNeurons ? ' btn--active' : ''}`}
                  onClick={() => {
                    const next = !showNeurons;
                    setShowNeurons(next);
                    // Showing neurons only makes sense through a translucent body.
                    if (next) {
                      setSolidBody(false);
                      rendererRef.current?.setBodyDisplayMode('tissue');
                    }
                    rendererRef.current?.setGlobalDim(next ? 1 : 0);
                  }}
                  disabled={neuronCount === 0}
                  title={
                    neuronCount > 0
                      ? `Show ${neuronCount.toLocaleString()} measured Fish1 soma inside the moving body.`
                      : 'Connectome still loading.'
                  }
                >
                  Neurons
                </button>
                <button
                  className={`btn${debug ? ' btn--active' : ''}`}
                  onClick={() => setDebug((d) => !d)}
                >
                  Debug
                </button>
              </div>

              {debug ? (
                <aside className="debug" aria-label="World diagnostics">
                  <div className="debug__head">
                    <span className="label">World debug</span>
                  </div>
                  <DebugRow
                    k="position"
                    v={snapshot.body.position.map((v) => v.toFixed(1)).join(', ')}
                  />
                  <DebugRow
                    k="heading"
                    v={`${((snapshot.body.heading * 180) / Math.PI).toFixed(0)}°`}
                  />
                  <DebugRow
                    k="speed"
                    v={`${Math.hypot(snapshot.body.velocity[0], snapshot.body.velocity[2]).toFixed(2)} mm/s`}
                  />
                  <DebugRow k="bout" v={snapshot.body.boutState} />
                  <DebugRow k="tail phase" v={snapshot.body.pose.tailPhase.toFixed(2)} />
                  <DebugRow k="forward drive" v={snapshot.motor.forwardDrive.toFixed(2)} />
                  <DebugRow k="turn drive" v={snapshot.motor.turnDrive.toFixed(2)} />
                  <DebugRow k="physics steps" v={String(snapshot.physicsSteps)} />
                  <DebugRow k="behaviour steps" v={String(snapshot.behaviorSteps)} />
                  <DebugRow k="sim update" v={`${snapshot.updateMs.toFixed(2)} ms`} />
                  <DebugRow k="render fps" v={stats ? stats.renderFps.toFixed(1) : '—'} />
                  <DebugRow
                    k="render frame"
                    v={stats ? `${stats.cpuFrameMs.toFixed(2)} ms` : '—'}
                  />
                  <DebugRow
                    k="mesh tris"
                    v={stats ? stats.meshTriangles.toLocaleString() : '—'}
                  />
                  {snapshot.sensory ? (
                    <>
                      <DebugRow
                        k="wall dist"
                        v={`${snapshot.sensory.contact.nearestBoundaryDistance.toFixed(1)} mm`}
                      />
                      <DebugRow
                        k="loom rate"
                        v={`${snapshot.sensory.visual.targetLoomRate.toFixed(3)} rad/s`}
                      />
                    </>
                  ) : null}
                </aside>
              ) : null}
            </>
          ) : null}

          {error ? (
            <div className="boot">
              <div className="notice notice--error" style={{ maxWidth: 460 }}>
                <div className="notice__title">World failed to start</div>
                <div>{error.message}</div>
              </div>
            </div>
          ) : !ready ? (
            <div className="boot">
              <div className="hud__sub mono">STARTING SIMULATION</div>
            </div>
          ) : null}
        </div>

        <WorldPanel
          snapshot={snapshot}
          onTimeScale={setTimeScale}
          timeScales={TIME_SCALES}
          controllerMode={controllerMode}
          neuralAvailable={neuralAvailable}
          onControllerMode={applyControllerMode}
          neural={neural}
          stimulusDirection={stimulusDirection}
          onStimulusDirection={applyStimulusDirection}
        />
      </div>

      <EventFeed events={events} />
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
