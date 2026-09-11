import { boundsCenter, boundsRadius, computeBounds, type Bounds3 } from '@/core/coords';
import type { NeuronIndex } from '@/core/types';
import { OrbitCamera, DEFAULT_VIEW, type CameraPreset, type CameraState } from './camera';
import { LODController, type LodLevel, type LodPolicy } from './LODController';
import { PickingSystem } from './PickingSystem';
import { AxesLayer } from './layers/AxesLayer';
import {
  ConnectionLayer,
  mergeLineSets,
  type CircuitEdgeInput,
} from './layers/ConnectionLayer';
import { SomaLayer } from './layers/SomaLayer';
import { BodyLayer } from './layers/BodyLayer';
import { WebGL2Backend } from './backends/webgl2';
import { WebGPUBackend } from './backends/webgpu';
import type {
  BodyDisplayMode,
  ClipPlane,
  ColorMode,
  ContextMode,
  FrameParams,
  FrameStats,
  GraphicsApi,
  MeshDraw,
  RendererBackend,
} from './types';
import type { MeshGeometry } from '@/core/mesh';
import type { Mat4 } from './math';
import type { FishPose } from '@/body/rig';

/**
 * The renderer root.
 *
 * Owns the GPU backend, the camera, and all visual layers. React never reaches
 * past this object: the application sends TypedArrays and identifiers in, and
 * receives indices and statistics back through callbacks. Nothing below this
 * file imports React, and this file holds no React state.
 */

export interface RendererStats {
  /**
   * requestAnimationFrame callbacks per second. This is the browser's tick
   * rate, NOT the rate at which the brain is redrawn: idle frames are skipped
   * when nothing has changed.
   */
  fps: number;
  /**
   * Frames actually rendered per second. This is the number that reflects
   * renderer throughput, and the one a benchmark should quote.
   */
  renderFps: number;
  /** Wall-clock time for a rendered frame, ms. Skipped frames are excluded. */
  cpuFrameMs: number;
  gpuFrameMs: number | null;
  drawCalls: number;
  somaTotal: number;
  somaVisible: number;
  lineSegments: number;
  meshTriangles: number;
  gpuBufferBytes: number;
  api: GraphicsApi;
  device: string;
  lodLevel: LodLevel;
  cameraDistance: number;
}

export interface BrainRendererCallbacks {
  onHover?: (neuronIndex: number) => void;
  onSelect?: (neuronIndex: number) => void;
  onStats?: (stats: RendererStats) => void;
  onLodChange?: (level: LodLevel) => void;
  onDeviceLost?: (reason: string) => void;
  onCameraChange?: (serialized: string) => void;
}

export interface BrainRendererOptions {
  canvas: HTMLCanvasElement;
  /** Force a backend; otherwise WebGPU is used when available. */
  preferredApi?: GraphicsApi | 'auto';
  reducedMotion?: boolean;
  callbacks?: BrainRendererCallbacks;
}

const STATS_INTERVAL_MS = 400;

export class BrainRenderer {
  readonly camera = new OrbitCamera();
  readonly soma = new SomaLayer();
  readonly connections = new ConnectionLayer();
  readonly axes = new AxesLayer();
  readonly lod = new LODController();
  readonly body = new BodyLayer();
  readonly picking: PickingSystem;

  private backend: RendererBackend | null = null;
  private canvas: HTMLCanvasElement;
  private callbacks: BrainRendererCallbacks;
  private rafHandle = 0;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;

  private colorMode: ColorMode = 'cell-type';
  private contextMode: ContextMode = 'dim';
  private dimFactor = 0.13;
  private globalDim = 1;
  private showConnections = true;
  private showAxes = true;
  private activityEnabled = false;

  private sceneBounds: Bounds3 = { min: [0, 0, 0], max: [0, 0, 0] };
  private lastFrameTime = 0;
  private frameCount = 0;
  private renderCount = 0;
  private frameTimeAccum = 0;
  private lastStatsAt = 0;
  private fps = 0;
  private renderFps = 0;
  /**
   * Disables the idle-frame skip so every animation frame is drawn. Used by the
   * benchmark to measure sustained throughput; pointless (and power-hungry) in
   * normal use, where a still camera over static data should cost nothing.
   */
  private continuousRendering = false;
  private lastStats: FrameStats = {
    drawCalls: 0,
    somaDrawn: 0,
    lineSegments: 0,
    meshTriangles: 0,
    gpuBufferBytes: 0,
    gpuTimeMs: null,
  };
  private somaModel: Mat4 = (() => {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  })();
  private clipPlanes: ClipPlane[] = [];
  private clipAffectsSoma = false;
  private extraMeshDraws: MeshDraw[] = [];
  private cachedVisibleCount = 0;
  private visibleCountDirty = true;
  private needsRender = true;

  // Pointer interaction state.
  private dragging: 'orbit' | 'pan' | null = null;
  private lastPointer: { x: number; y: number } | null = null;
  private pointerDownAt = 0;
  private pointerDownPos: { x: number; y: number } | null = null;
  private activePointers = new Map<number, { x: number; y: number }>();
  private lastPinchDistance = 0;

  private constructor(options: BrainRendererOptions) {
    this.canvas = options.canvas;
    this.callbacks = options.callbacks ?? {};
    this.camera.smoothing = !options.reducedMotion;
    this.picking = new PickingSystem(() => this.backend);
  }

  static async create(options: BrainRendererOptions): Promise<BrainRenderer> {
    const renderer = new BrainRenderer(options);
    await renderer.initBackend(options.preferredApi ?? 'auto');
    renderer.attachInput();
    renderer.observeResize();
    renderer.start();
    return renderer;
  }

  private async initBackend(preferred: GraphicsApi | 'auto'): Promise<void> {
    const onDeviceLost = (reason: string) => {
      this.callbacks.onDeviceLost?.(reason);
      this.stop();
    };

    if (preferred !== 'webgl2') {
      try {
        this.backend = await WebGPUBackend.create(this.canvas, onDeviceLost);
        return;
      } catch (e) {
        if (preferred === 'webgpu') throw e;
        // Fall through to WebGL2: the soma cloud must render on any modern GPU,
        // so an unavailable WebGPU is a downgrade, never a blocked application.
      }
    }
    this.backend = new WebGL2Backend({ canvas: this.canvas, onDeviceLost });
  }

  get api(): GraphicsApi {
    return this.backend?.api ?? 'webgl2';
  }

  get deviceDescription(): string {
    return this.backend?.deviceDescription ?? 'unknown';
  }

  /* ---------------------------------------------------------------------- */
  /* Data                                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Distance at which a bounding sphere of `radius` fits on screen.
   *
   * Uses the NARROWER of the vertical and horizontal fields of view. A brain is
   * elongated, and a tall/narrow viewport is horizontally tighter than fovY
   * suggests, so framing on fovY alone let the population overflow the sides.
   */
  private framingDistance(radius: number): number {
    const fovY = this.camera.desired.fovY;
    const aspect = this.canvas.width / Math.max(this.canvas.height, 1);
    const fovX = 2 * Math.atan(Math.tan(fovY / 2) * aspect);
    const fov = Math.min(fovY, fovX);
    // 1.12 leaves a small margin so soma do not touch the edge.
    return (radius / Math.sin(fov / 2)) * 1.12;
  }

  setNeuronIndex(index: NeuronIndex): void {
    const buffers = this.soma.build(index);
    this.backend?.uploadSoma(buffers);

    this.sceneBounds = computeBounds(this.soma.worldPositions, index.count);
    const radius = Math.max(boundsRadius(this.sceneBounds), 1e-4);
    this.lod.setSceneRadius(radius);

    const center = boundsCenter(this.sceneBounds);
    this.camera.focus([center[0], center[1], center[2]], this.framingDistance(radius));
    this.camera.applyPreset(DEFAULT_VIEW);
    this.camera.snap();

    this.axes.build(this.sceneBounds);
    this.uploadLines();
    this.visibleCountDirty = true;
    this.requestRender();
  }

  /* ---------------------------------------------------------------------- */
  /* Body                                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Loads the reference body surface. Uploading a mesh does NOT change anything
   * about the neuron buffers; the body is an additional layer drawn around
   * measured data.
   */
  setBodyGeometry(geometry: MeshGeometry): void {
    const upload = this.body.setGeometry(geometry);
    this.backend?.uploadMesh(upload);
    this.requestRender();
  }

  /**
   * Places the whole soma population. Identity in brain/organism mode; in world
   * mode it carries the neurons along with the swimming body.
   */
  setSomaModelMatrix(matrix: Float32Array): void {
    this.somaModel.set(matrix);
    this.requestRender();
  }

  /** Maps body rest space into the same render space the soma were placed in. */
  setBodyModelMatrix(matrix: Float32Array): void {
    this.body.setModelMatrix(matrix);
    this.requestRender();
  }

  /** World placement of the organism (position and heading) in world mode. */
  setBodyPlacement(matrix: Float32Array): void {
    this.body.setPlacement(matrix);
    this.requestRender();
  }

  setBodyPose(pose: FishPose): void {
    this.body.setPose(pose);
    this.requestRender();
  }

  setBodyDisplayMode(mode: BodyDisplayMode): void {
    this.body.displayMode = mode;
    this.requestRender();
  }

  bodyDisplayMode(): BodyDisplayMode {
    return this.body.displayMode;
  }

  uploadMesh(id: string, geometry: MeshGeometry): void {
    this.backend?.uploadMesh({ id, geometry });
    this.requestRender();
  }

  removeMesh(id: string): void {
    this.backend?.removeMesh(id);
    this.requestRender();
  }

  /** Draw list for anything that is not the body (tank, debug surfaces). */
  setExtraMeshDraws(draws: MeshDraw[]): void {
    this.extraMeshDraws = draws;
    this.requestRender();
  }

  /**
   * Anatomical section planes. A fragment is removed where
   * dot(position, normal) + distance > 0.
   */
  setClipPlanes(planes: ClipPlane[], affectsSoma: boolean): void {
    this.clipPlanes = planes;
    this.clipAffectsSoma = affectsSoma;
    this.requestRender();
  }

  clipPlaneCount(): number {
    return this.clipPlanes.length;
  }

  applyVisibilityMask(mask: Uint8Array): void {
    this.soma.applyVisibilityMask(mask);
    this.visibleCountDirty = true;
    this.requestRender();
  }

  setSelectedIndex(index: number): void {
    this.soma.setSelected(index);
    this.requestRender();
  }

  setHoveredIndex(index: number): void {
    this.soma.setHovered(index);
    this.requestRender();
  }

  /**
   * Displays a local circuit. Edge geometry is built from indices already
   * resolved by the application, so the renderer never performs a lookup that
   * could block the frame.
   */
  setCircuit(
    edges: readonly CircuitEdgeInput[],
    inputs: Int32Array | null,
    outputs: Int32Array | null,
  ): void {
    this.soma.setCircuit(inputs, outputs);
    if (edges.length === 0) {
      this.connections.clear();
    } else {
      const maxSynapseCount = edges.reduce((m, e) => Math.max(m, e.synapseCount), 1);
      this.connections.build(edges, this.soma.worldPositions, { maxSynapseCount });
    }
    this.uploadLines();
    this.requestRender();
  }

  clearCircuit(): void {
    this.soma.setCircuit(null, null);
    this.connections.clear();
    this.uploadLines();
    this.requestRender();
  }

  setActivity(values: Float32Array): void {
    this.soma.setActivity(values);
    this.requestRender();
  }

  private uploadLines(): void {
    const sets = [
      this.showConnections ? this.connections.current() : null,
      this.showAxes ? this.axes.current() : null,
    ];
    this.backend?.uploadConnections(mergeLineSets(sets));
  }

  /* ---------------------------------------------------------------------- */
  /* Display options                                                         */
  /* ---------------------------------------------------------------------- */

  setColorMode(mode: ColorMode): void {
    this.colorMode = mode;
    this.requestRender();
  }

  setContextMode(mode: ContextMode): void {
    this.contextMode = mode;
    this.requestRender();
  }

  setDimFactor(value: number): void {
    this.dimFactor = Math.max(0, Math.min(1, value));
    this.requestRender();
  }

  /** Lowers overall brightness so an isolated circuit reads clearly. */
  setGlobalDim(value: number): void {
    this.globalDim = Math.max(0, Math.min(1, value));
    this.requestRender();
  }

  setShowConnections(show: boolean): void {
    this.showConnections = show;
    this.uploadLines();
    this.requestRender();
  }

  setShowAxes(show: boolean): void {
    this.showAxes = show;
    this.uploadLines();
    this.requestRender();
  }

  setActivityEnabled(enabled: boolean): void {
    this.activityEnabled = enabled;
    this.requestRender();
  }

  setContinuousRendering(enabled: boolean): void {
    this.continuousRendering = enabled;
    this.requestRender();
  }

  setReducedMotion(reduced: boolean): void {
    this.camera.smoothing = !reduced;
  }

  forceLod(level: LodLevel | null): void {
    this.lod.force(level);
    this.requestRender();
  }

  lodPolicy(): LodPolicy {
    return this.lod.policy();
  }

  /* ---------------------------------------------------------------------- */
  /* Camera                                                                  */
  /* ---------------------------------------------------------------------- */

  focusIndex(index: number, distance?: number): void {
    const p = this.soma.worldPositionOf(index);
    if (!p) return;
    const radius = boundsRadius(this.sceneBounds);
    this.camera.focus(p, distance ?? Math.max(radius * 0.12, 0.05));
    this.requestRender();
  }

  /**
   * Frames an arbitrary axis-aligned box in render space. Used to pull the
   * camera out to the whole animal and to dive back to the brain, so both
   * transitions are the same operation on different bounds.
   */
  frameBounds(
    min: readonly [number, number, number],
    max: readonly [number, number, number],
  ): void {
    const centre: [number, number, number] = [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ];
    const radius = Math.max(
      Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2,
      1e-4,
    );
    this.camera.focus(centre, this.framingDistance(radius));
    this.requestRender();
  }

  resetCamera(): void {
    const center = boundsCenter(this.sceneBounds);
    const radius = Math.max(boundsRadius(this.sceneBounds), 1e-4);
    this.camera.focus([center[0], center[1], center[2]], this.framingDistance(radius));
    this.camera.applyPreset(DEFAULT_VIEW);
    this.requestRender();
  }

  applyCameraPreset(preset: CameraPreset): void {
    this.camera.applyPreset(preset);
    this.requestRender();
  }

  restoreCamera(state: Partial<CameraState>): void {
    Object.assign(this.camera.desired, state);
    this.camera.snap();
    this.requestRender();
  }

  sceneRadius(): number {
    return Math.max(boundsRadius(this.sceneBounds), 1e-4);
  }

  /* ---------------------------------------------------------------------- */
  /* Frame loop                                                              */
  /* ---------------------------------------------------------------------- */

  private requestRender(): void {
    this.needsRender = true;
  }

  private start(): void {
    this.lastFrameTime = performance.now();
    this.lastStatsAt = this.lastFrameTime;
    const loop = () => {
      if (this.disposed) return;
      this.rafHandle = requestAnimationFrame(loop);
      this.frame();
    };
    this.rafHandle = requestAnimationFrame(loop);
  }

  private stop(): void {
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  private frame(): void {
    const backend = this.backend;
    if (!backend) return;

    const now = performance.now();
    const dt = Math.min((now - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = now;

    const cameraMoving = this.camera.update(dt);
    if (cameraMoving) this.needsRender = true;

    if (this.lod.update(this.camera.current.distance)) {
      this.callbacks.onLodChange?.(this.lod.level());
      this.needsRender = true;
    }

    if (this.soma.consumeStateDirty()) {
      backend.updateSomaState(this.soma.state);
      this.needsRender = true;
    }
    if (this.soma.consumeActivityDirty()) {
      backend.updateActivity(this.soma.activity);
      this.needsRender = true;
    }

    // Idle frames are skipped entirely: a still camera over a static dataset
    // should not keep a discrete GPU busy.
    if (!this.needsRender && !this.continuousRendering) {
      this.updateStats(now, 0, false);
      return;
    }
    this.needsRender = false;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const aspect = this.canvas.width / Math.max(this.canvas.height, 1);
    const { viewProj } = this.camera.matrices(aspect, backend.api === 'webgpu');

    const policy = this.lod.policy();
    const params: FrameParams = {
      viewProj,
      eye: this.camera.eye(),
      widthPx: this.canvas.width,
      heightPx: this.canvas.height,
      devicePixelRatio: dpr,
      somaRadius: this.lod.interpolatedSomaRadius(this.camera.current.distance),
      minPointPx: policy.minPointPx,
      maxPointPx: policy.maxPointPx,
      colorMode: this.colorMode,
      contextMode: this.contextMode,
      dimFactor: this.dimFactor,
      globalDim: this.globalDim,
      activityEnabled: this.activityEnabled,
      cameraDistance: this.camera.current.distance,
      somaModel: this.somaModel,
      showConnections: true,
      meshDraws: [...this.body.buildDraws(), ...this.extraMeshDraws],
      clipPlanes: this.clipPlanes,
      clipAffectsSoma: this.clipAffectsSoma,
    };

    this.lastStats = backend.render(params);
    this.updateStats(now, performance.now() - now, true);

    if (cameraMoving) this.callbacks.onCameraChange?.(this.camera.serialize());
  }

  private updateStats(now: number, cpuMs: number, rendered: boolean): void {
    this.frameCount++;
    if (rendered) {
      this.renderCount++;
      this.frameTimeAccum += cpuMs;
    }
    if (now - this.lastStatsAt < STATS_INTERVAL_MS) return;

    const elapsed = (now - this.lastStatsAt) / 1000;
    this.fps = this.frameCount / elapsed;
    this.renderFps = this.renderCount / elapsed;
    // Averaged over RENDERED frames only, so skipped frames cannot dilute it
    // toward zero and make the renderer look faster than it is.
    const cpuFrameMs = this.renderCount > 0 ? this.frameTimeAccum / this.renderCount : 0;
    this.frameCount = 0;
    this.renderCount = 0;
    this.frameTimeAccum = 0;
    this.lastStatsAt = now;

    if (this.visibleCountDirty) {
      this.cachedVisibleCount = this.soma.visibleCount();
      this.visibleCountDirty = false;
    }

    // When no frame was drawn in this window, per-frame counters from an older
    // frame are stale; reporting them next to "render fps 0" reads as a
    // contradiction. Resident buffer size is still current, so it is kept.
    const idle = this.renderFps === 0;

    this.callbacks.onStats?.({
      fps: this.fps,
      renderFps: this.renderFps,
      cpuFrameMs,
      gpuFrameMs: this.lastStats.gpuTimeMs,
      drawCalls: idle ? 0 : this.lastStats.drawCalls,
      somaTotal: this.soma.count,
      somaVisible: this.cachedVisibleCount,
      lineSegments: idle ? 0 : this.lastStats.lineSegments,
      meshTriangles: idle ? 0 : this.lastStats.meshTriangles,
      gpuBufferBytes: this.lastStats.gpuBufferBytes,
      api: this.api,
      device: this.deviceDescription,
      lodLevel: this.lod.level(),
      cameraDistance: this.camera.current.distance,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Input                                                                   */
  /* ---------------------------------------------------------------------- */

  private observeResize(): void {
    const apply = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (w === this.canvas.width && h === this.canvas.height) return;
      this.backend?.resize(w, h);
      this.requestRender();
    };
    this.resizeObserver = new ResizeObserver(apply);
    this.resizeObserver.observe(this.canvas);
    apply();
  }

  private canvasPixel(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / Math.max(rect.width, 1);
    const scaleY = this.canvas.height / Math.max(rect.height, 1);
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  private attachInput(): void {
    const canvas = this.canvas;
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', (e) => {
      // Can throw if the browser does not consider this pointer id active
      // (synthetic events, some pen/touch stacks). Losing capture only means
      // a drag may end early; it must not take the handler down with it.
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* continue without capture */
      }
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.activePointers.size === 1) {
        // Middle button or shift pans; primary button orbits.
        this.dragging = e.button === 1 || e.shiftKey ? 'pan' : 'orbit';
        this.lastPointer = { x: e.clientX, y: e.clientY };
        this.pointerDownAt = performance.now();
        this.pointerDownPos = { x: e.clientX, y: e.clientY };
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (this.activePointers.has(e.pointerId)) {
        this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }

      if (this.activePointers.size === 2) {
        this.handlePinch();
        return;
      }

      if (this.dragging && this.lastPointer) {
        const dx = e.clientX - this.lastPointer.x;
        const dy = e.clientY - this.lastPointer.y;
        this.lastPointer = { x: e.clientX, y: e.clientY };
        const rect = canvas.getBoundingClientRect();
        if (this.dragging === 'orbit') {
          this.camera.orbit((dx / rect.width) * Math.PI * 2, (-dy / rect.height) * Math.PI);
        } else {
          this.camera.pan(dx / rect.width, dy / rect.height);
        }
        this.requestRender();
        return;
      }

      // Hover picking only when not dragging, throttled inside PickingSystem.
      const p = this.canvasPixel(e);
      this.picking.requestHover(p.x, p.y, (index) => {
        this.setHoveredIndex(index);
        this.callbacks.onHover?.(index);
      });
    });

    const endPointer = (e: PointerEvent) => {
      this.activePointers.delete(e.pointerId);
      if (this.activePointers.size < 2) this.lastPinchDistance = 0;
      if (this.activePointers.size === 0) {
        const wasDragging = this.dragging;
        this.dragging = null;
        this.lastPointer = null;

        // A short, near-stationary press is a click, not the end of an orbit.
        const dt = performance.now() - this.pointerDownAt;
        const start = this.pointerDownPos;
        const moved = start ? Math.hypot(e.clientX - start.x, e.clientY - start.y) : Infinity;
        if (wasDragging && dt < 400 && moved < 5) {
          const p = this.canvasPixel(e);
          void this.picking.pickAt(p.x, p.y).then((index) => {
            this.setSelectedIndex(index);
            this.callbacks.onSelect?.(index);
          });
        }
        this.pointerDownPos = null;
      }
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);

    canvas.addEventListener('pointerleave', () => {
      this.picking.clearHover();
      this.setHoveredIndex(-1);
      this.callbacks.onHover?.(-1);
    });

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // Exponential so each notch changes scale by a constant ratio.
        const factor = Math.exp(e.deltaY * 0.0014);
        this.camera.zoom(factor);
        this.requestRender();
      },
      { passive: false },
    );

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private handlePinch(): void {
    const points = [...this.activePointers.values()];
    if (points.length < 2) return;
    const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    if (this.lastPinchDistance > 0 && distance > 0) {
      this.camera.zoom(this.lastPinchDistance / distance);
      this.requestRender();
    }
    this.lastPinchDistance = distance;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.resizeObserver?.disconnect();
    this.backend?.destroy();
    this.backend = null;
  }
}
