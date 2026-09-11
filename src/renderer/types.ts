import type { Mat4, Vec3f } from './math';
import type { MaterialId, MeshGeometry } from '@/core/mesh';

/**
 * Renderer contract.
 *
 * Deliberately framework-free: nothing under src/renderer imports React, and
 * React never holds per-neuron objects. The application sends TypedArrays down;
 * the renderer owns everything on the GPU.
 */

export type GraphicsApi = 'webgpu' | 'webgl2';

/** Per-neuron dynamic state, one byte per neuron. */
export const SOMA_STATE = {
  /** Passes the current filter set. Cleared neurons render dimmed or not at all. */
  VISIBLE: 1 << 0,
  SELECTED: 1 << 1,
  HOVERED: 1 << 2,
  /** Participates in the currently displayed local circuit. */
  IN_CIRCUIT: 1 << 3,
  /** Direction of the circuit relationship, for colouring. */
  CIRCUIT_INPUT: 1 << 4,
  CIRCUIT_OUTPUT: 1 << 5,
} as const;

/**
 * Static per-neuron GPU data, interleaved at 16 bytes:
 *   offset 0  vec3<f32> world position
 *   offset 12 u32       packed: cellType(8) | flags(8) | regionId(16)
 *
 * The neuron's own index is NOT stored: shaders read it from gl_VertexID /
 * instance_index, which saves 4 bytes x count and is what picking returns.
 */
export const SOMA_STRIDE_BYTES = 16;

export interface SomaBufferSet {
  readonly count: number;
  /** Interleaved static attributes; length = count * SOMA_STRIDE_BYTES. */
  readonly staticData: ArrayBuffer;
  /** Bit field of {@link SOMA_STATE}; length = count. */
  readonly state: Uint8Array;
  /** Per-neuron scalar for activity colouring; length = count. */
  readonly activity: Float32Array;
}

export function packSomaAttributes(cellType: number, flags: number, regionId: number): number {
  return ((cellType & 0xff) | ((flags & 0xff) << 8) | ((regionId & 0xffff) << 16)) >>> 0;
}

/** How soma colour is chosen on the GPU. */
export type ColorMode = 'cell-type' | 'region' | 'activity' | 'depth' | 'uniform';

export const COLOR_MODE_CODE: Record<ColorMode, number> = {
  'cell-type': 0,
  region: 1,
  activity: 2,
  depth: 3,
  uniform: 4,
};

/** What happens to neurons that fail the active filter. */
export type ContextMode = 'dim' | 'hide';

export interface ConnectionLineSet {
  /** Number of line segments. */
  readonly segmentCount: number;
  /** Two endpoints per segment, interleaved xyz. length = segmentCount * 6. */
  readonly positions: Float32Array;
  /** RGBA per endpoint. length = segmentCount * 8. */
  readonly colors: Float32Array;
}

export interface FrameParams {
  readonly viewProj: Mat4;
  readonly eye: Vec3f;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly devicePixelRatio: number;
  /** Base soma radius in world units before perspective scaling. */
  readonly somaRadius: number;
  /** Clamp for on-screen soma size, in device pixels. */
  readonly minPointPx: number;
  readonly maxPointPx: number;
  readonly colorMode: ColorMode;
  readonly contextMode: ContextMode;
  /** Brightness multiplier applied to filtered-out neurons in 'dim' mode. */
  readonly dimFactor: number;
  /** Global brightness, lowered when a local circuit is isolated. */
  readonly globalDim: number;
  readonly activityEnabled: boolean;
  /**
   * Camera orbit distance. The depth haze is computed RELATIVE to this, so the
   * volumetric cue looks the same whether the camera is 4 units from a brain or
   * 50 units from a whole animal. An absolute cue crushed the whole population
   * to near-black as soon as the camera pulled out.
   */
  readonly cameraDistance: number;
  /**
   * Transform applied to every soma position at draw time.
   *
   * Measured coordinates are uploaded once and never rewritten; when the
   * organism swims, its neurons move because this matrix moves. That keeps the
   * "measured position is immutable, pose is presentation" rule true even while
   * the body is being deformed and carried around a tank.
   */
  readonly somaModel?: Mat4;
  /**
   * Draws the uploaded line set. Orientation axes and circuit edges are
   * composed into that one set by BrainRenderer, so the backend needs no
   * knowledge of either.
   */
  readonly showConnections: boolean;

  /** Meshes to draw this frame (body, eyes, environment). */
  readonly meshDraws?: readonly MeshDraw[];
  /** Active clip planes, in render world space. */
  readonly clipPlanes?: readonly ClipPlane[];
  /** Whether clip planes also cut the soma cloud, not just surfaces. */
  readonly clipAffectsSoma?: boolean;
}

export interface FrameStats {
  drawCalls: number;
  somaDrawn: number;
  lineSegments: number;
  meshTriangles: number;
  /** Total bytes currently resident in GPU buffers, as reported by the backend. */
  gpuBufferBytes: number;
  /** GPU-side duration in ms when the backend can measure it, else null. */
  gpuTimeMs: number | null;
}

export interface BackendInitOptions {
  readonly canvas: HTMLCanvasElement;
  readonly onDeviceLost?: (reason: string) => void;
}

/**
 * A GPU backend. Two implementations exist (WebGPU, WebGL2) and the application
 * works fully on either; WebGPU is preferred where available.
 */
export interface RendererBackend {
  readonly api: GraphicsApi;
  /** Human-readable adapter/renderer string for the diagnostics panel. */
  readonly deviceDescription: string;

  resize(widthPx: number, heightPx: number): void;

  uploadSoma(buffers: SomaBufferSet): void;
  /** Uploads (or replaces) a named mesh. Safe to call once per asset. */
  uploadMesh(upload: MeshUpload): void;
  removeMesh(id: string): void;
  /** Partial update of the state lane; avoids re-uploading positions on filter. */
  updateSomaState(state: Uint8Array): void;
  /**
   * Uploads per-neuron activity.
   *
   * `first`/`count` bound the range that actually changed. A connectome-driven
   * simulation touches a small subset of a large population - 865 HMI cells out
   * of 30,346 loaded neurons - so uploading the whole buffer every tick would
   * move two orders of magnitude more data than the simulation produced.
   */
  updateActivity(activity: Float32Array, first?: number, count?: number): void;
  uploadConnections(lines: ConnectionLineSet | null): void;

  render(params: FrameParams): FrameStats;

  /**
   * Reads back the neuron index under a pixel, or -1.
   * `radiusPx` searches a square neighbourhood so tiny soma remain clickable.
   */
  pick(xPx: number, yPx: number, radiusPx: number): Promise<number>;

  destroy(): void;
}

export interface GpuSupport {
  readonly webgpu: boolean;
  readonly webgl2: boolean;
  readonly reason?: string;
}

export async function detectGpuSupport(): Promise<GpuSupport> {
  let webgpu = false;
  let reason: string | undefined;

  if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      webgpu = adapter !== null;
      if (!adapter) reason = 'No WebGPU adapter available on this device.';
    } catch (e) {
      reason = e instanceof Error ? e.message : 'WebGPU adapter request failed.';
    }
  } else {
    reason = 'navigator.gpu is not exposed by this browser.';
  }

  let webgl2 = false;
  if (typeof document !== 'undefined') {
    const probe = document.createElement('canvas');
    webgl2 = Boolean(probe.getContext('webgl2'));
  }

  return { webgpu, webgl2, reason };
}

/* -------------------------------------------------------------------------- */
/* Meshes (Phase 2: body, eyes, environment)                                  */
/* -------------------------------------------------------------------------- */

/** How much of the body surface is drawn, and how solid it looks. */
export type BodyDisplayMode = 'off' | 'ghost' | 'tissue' | 'solid' | 'xray';

export interface BodyDisplayDescriptor {
  readonly label: string;
  /** Base skin opacity. */
  readonly skinOpacity: number;
  /** Rim/fresnel emphasis, which is what makes thin tissue read as tissue. */
  readonly rim: number;
  /** Draw the body BEFORE soma with depth writes, hiding what is inside. */
  readonly occludesNeurons: boolean;
  readonly description: string;
}

export const BODY_DISPLAY_MODES: Record<BodyDisplayMode, BodyDisplayDescriptor> = {
  off: {
    label: 'OFF',
    skinOpacity: 0,
    rim: 0,
    occludesNeurons: false,
    description: 'Brain only. Identical to the Phase 1 viewer.',
  },
  ghost: {
    label: 'GHOST',
    skinOpacity: 0.12,
    rim: 0.65,
    occludesNeurons: false,
    description: 'A faint silhouette. Neurons dominate.',
  },
  tissue: {
    label: 'TISSUE',
    skinOpacity: 0.24,
    rim: 0.7,
    occludesNeurons: false,
    description: 'Translucent tissue. The brain stays visible inside.',
  },
  solid: {
    label: 'SOLID',
    skinOpacity: 0.97,
    rim: 0.3,
    occludesNeurons: true,
    description: 'Opaque external surface. Neurons are hidden inside the animal.',
  },
  xray: {
    label: 'XRAY',
    skinOpacity: 0.05,
    rim: 1.0,
    occludesNeurons: false,
    description: 'Edges only, emphasising the nervous system and the body outline.',
  },
};

/**
 * A half-space clip. A fragment is discarded when
 *   dot(position, normal) + distance > 0
 * so the plane normal points at the half that gets removed.
 */
export interface ClipPlane {
  readonly normal: Vec3f;
  readonly distance: number;
}

export const MAX_CLIP_PLANES = 4;

export interface MeshUpload {
  readonly id: string;
  readonly geometry: MeshGeometry;
}

export interface MeshDraw {
  readonly meshId: string;
  /** Rest space -> render world space. */
  readonly modelMatrix: Mat4;
  /** MAX_BONES * 16 floats, or null for a rigid mesh. */
  readonly boneMatrices: Float32Array | null;
  readonly material: MaterialId;
  readonly opacity: number;
  readonly rim: number;
  /** Multiplied into the material base colour. */
  readonly tint: Vec3f;
  /** Draw with depth writes enabled, before the soma pass. */
  readonly occluding: boolean;
}
