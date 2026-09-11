import type {
  BackendInitOptions,
  ConnectionLineSet,
  FrameParams,
  FrameStats,
  RendererBackend,
  SomaBufferSet,
} from '../types';
import { COLOR_MODE_CODE, SOMA_STRIDE_BYTES } from '../types';
import { PALETTE_GLSL } from './palette';

/**
 * WebGL2 rendering backend.
 *
 * The whole soma population is one interleaved vertex buffer drawn with a
 * single `drawArrays(POINTS)` call. Neuron index comes from `gl_VertexID`, so
 * no per-neuron object, mesh, or draw call exists anywhere.
 *
 * Picking renders neuron indices into an R32UI attachment on demand (not every
 * frame) and reads back a small neighbourhood, which keeps selection O(1) on
 * the CPU regardless of population size.
 */

const SOMA_VERT = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec3 a_position;
layout(location = 1) in uint a_packed;
layout(location = 2) in uint a_state;
layout(location = 3) in float a_activity;

uniform mat4 u_viewProj;
uniform vec3 u_eye;
uniform float u_pointScale;
uniform float u_somaRadius;
uniform float u_minPointPx;
uniform float u_maxPointPx;
uniform int u_colorMode;
uniform int u_contextMode;
uniform float u_dimFactor;
uniform float u_globalDim;
uniform int u_activityEnabled;
uniform vec3 u_background;
uniform float u_depthCue;

out vec4 v_color;
flat out int v_discard;

${PALETTE_GLSL}

void main() {
  uint cellType = a_packed & 0xFFu;
  uint regionId = (a_packed >> 16) & 0xFFFFu;
  uint state = a_state;

  bool visible    = (state & 1u) != 0u;
  bool selected   = (state & 2u) != 0u;
  bool hovered    = (state & 4u) != 0u;
  bool inCircuit  = (state & 8u) != 0u;
  bool circuitIn  = (state & 16u) != 0u;
  bool circuitOut = (state & 32u) != 0u;

  // Emphasised neurons stay visible regardless of the active filter, otherwise
  // selecting a cell and then filtering it out would silently lose it.
  bool emphasised = selected || hovered || inCircuit;

  if (!visible && !emphasised && u_contextMode == 1) {
    // 'hide' context mode: cull entirely off-screen.
    v_discard = 1;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  v_discard = 0;

  vec4 clip = u_viewProj * vec4(a_position, 1.0);
  gl_Position = clip;

  float dist = max(clip.w, 1e-4);
  float sizePx = (u_somaRadius * 2.0 * u_pointScale) / dist;

  vec3 color = somaBaseColor(cellType, regionId, u_colorMode, a_activity, u_activityEnabled);

  if (u_colorMode == 3) {
    // Depth colouring: near cells brighter than far ones.
    float t = clamp(dist * 0.35, 0.0, 1.0);
    color = mix(vec3(0.82, 0.88, 0.95), vec3(0.20, 0.26, 0.34), t);
  }

  float brightness = 1.0;

  if (!visible && !emphasised) {
    brightness *= u_dimFactor;
  } else {
    brightness *= u_globalDim;
  }

  if (inCircuit) {
    color = circuitIn ? COLOR_CIRCUIT_IN : (circuitOut ? COLOR_CIRCUIT_OUT : color);
    brightness = 1.0;
    sizePx *= 1.7;
  }
  if (hovered) {
    color = COLOR_HOVER;
    brightness = 1.0;
    sizePx *= 2.0;
  }
  if (selected) {
    color = COLOR_SELECTED;
    brightness = 1.0;
    sizePx *= 2.6;
  }

  // Distance haze: gives the point cloud genuine volumetric depth without any
  // post-processing pass.
  float haze = 1.0 - clamp((dist - 0.4) * u_depthCue, 0.0, 0.72);
  if (!selected && !hovered) brightness *= haze;

  color = mix(u_background, color, clamp(brightness, 0.0, 1.0));

  gl_PointSize = clamp(sizePx, u_minPointPx, u_maxPointPx);
  v_color = vec4(color, 1.0);
}`;

const SOMA_FRAG = `#version 300 es
precision highp float;
in vec4 v_color;
flat in int v_discard;
out vec4 fragColor;

void main() {
  if (v_discard == 1) discard;
  // Round the square point sprite and soften its rim by one pixel.
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float edge = 1.0 - smoothstep(0.55, 1.0, r2);
  fragColor = vec4(v_color.rgb * (0.55 + 0.45 * edge), 1.0);
}`;

const PICK_VERT = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec3 a_position;
layout(location = 1) in uint a_packed;
layout(location = 2) in uint a_state;

uniform mat4 u_viewProj;
uniform float u_pointScale;
uniform float u_somaRadius;
uniform float u_minPointPx;
uniform float u_maxPointPx;
uniform int u_contextMode;

flat out uint v_id;

void main() {
  uint state = a_state;
  bool visible = (state & 1u) != 0u;
  bool emphasised = (state & (2u | 4u | 8u)) != 0u;

  if (!visible && !emphasised && u_contextMode == 1) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    v_id = 0u;
    return;
  }

  vec4 clip = u_viewProj * vec4(a_position, 1.0);
  gl_Position = clip;
  float dist = max(clip.w, 1e-4);
  float sizePx = (u_somaRadius * 2.0 * u_pointScale) / dist;
  // Pick targets are inflated slightly so single-pixel soma stay clickable.
  gl_PointSize = clamp(sizePx * 1.5, max(u_minPointPx, 3.0), u_maxPointPx);
  v_id = uint(gl_VertexID) + 1u;
}`;

const PICK_FRAG = `#version 300 es
precision highp float;
precision highp int;
flat in uint v_id;
out uvec4 fragColor;

void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  if (dot(c, c) > 1.0) discard;
  fragColor = uvec4(v_id, 0u, 0u, 0u);
}`;

const LINE_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color;
uniform mat4 u_viewProj;
out vec4 v_color;
void main() {
  gl_Position = u_viewProj * vec4(a_position, 1.0);
  v_color = a_color;
}`;

const LINE_FRAG = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 fragColor;
void main() { fragColor = v_color; }`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Failed to create WebGL shader.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('Failed to create WebGL program.');
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(program, v);
  gl.attachShader(program, f);
  gl.linkProgram(program);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link failed: ${log}`);
  }
  return program;
}

type UniformMap = Record<string, WebGLUniformLocation | null>;

function uniforms(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: readonly string[],
): UniformMap {
  const map: UniformMap = {};
  for (const n of names) map[n] = gl.getUniformLocation(program, n);
  return map;
}

export class WebGL2Backend implements RendererBackend {
  readonly api = 'webgl2' as const;
  readonly deviceDescription: string;

  private readonly gl: WebGL2RenderingContext;
  private readonly canvas: HTMLCanvasElement;

  private somaProgram: WebGLProgram;
  private pickProgram: WebGLProgram;
  private lineProgram: WebGLProgram;
  private somaUniforms: UniformMap;
  private pickUniforms: UniformMap;
  private lineUniforms: UniformMap;

  private somaVao: WebGLVertexArrayObject | null = null;
  private staticBuffer: WebGLBuffer | null = null;
  private stateBuffer: WebGLBuffer | null = null;
  private activityBuffer: WebGLBuffer | null = null;
  private somaCount = 0;

  private lineVao: WebGLVertexArrayObject | null = null;
  private linePositionBuffer: WebGLBuffer | null = null;
  private lineColorBuffer: WebGLBuffer | null = null;
  private lineSegments = 0;

  private pickFbo: WebGLFramebuffer | null = null;
  private pickTexture: WebGLTexture | null = null;
  private pickDepth: WebGLRenderbuffer | null = null;
  private pickSize: [number, number] = [0, 0];

  private widthPx = 1;
  private heightPx = 1;
  private bufferBytes = 0;
  private disposed = false;

  constructor(options: BackendInitOptions) {
    this.canvas = options.canvas;
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      desynchronized: true,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    this.deviceDescription = debugInfo
      ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));

    if (options.onDeviceLost) {
      this.canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        options.onDeviceLost?.('WebGL context lost.');
      });
    }

    this.somaProgram = link(gl, SOMA_VERT, SOMA_FRAG);
    this.pickProgram = link(gl, PICK_VERT, PICK_FRAG);
    this.lineProgram = link(gl, LINE_VERT, LINE_FRAG);

    this.somaUniforms = uniforms(gl, this.somaProgram, [
      'u_viewProj',
      'u_eye',
      'u_pointScale',
      'u_somaRadius',
      'u_minPointPx',
      'u_maxPointPx',
      'u_colorMode',
      'u_contextMode',
      'u_dimFactor',
      'u_globalDim',
      'u_activityEnabled',
      'u_background',
      'u_depthCue',
    ]);
    this.pickUniforms = uniforms(gl, this.pickProgram, [
      'u_viewProj',
      'u_pointScale',
      'u_somaRadius',
      'u_minPointPx',
      'u_maxPointPx',
      'u_contextMode',
    ]);
    this.lineUniforms = uniforms(gl, this.lineProgram, ['u_viewProj']);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
  }

  resize(widthPx: number, heightPx: number): void {
    this.widthPx = Math.max(1, Math.floor(widthPx));
    this.heightPx = Math.max(1, Math.floor(heightPx));
    this.canvas.width = this.widthPx;
    this.canvas.height = this.heightPx;
  }

  uploadSoma(buffers: SomaBufferSet): void {
    const gl = this.gl;
    this.destroySomaResources();

    this.somaCount = buffers.count;
    this.somaVao = gl.createVertexArray();
    gl.bindVertexArray(this.somaVao);

    this.staticBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.staticBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, buffers.staticData, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, SOMA_STRIDE_BYTES, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, SOMA_STRIDE_BYTES, 12);

    this.stateBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stateBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, buffers.state, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_BYTE, 0, 0);

    this.activityBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.activityBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, buffers.activity, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
    this.bufferBytes =
      buffers.staticData.byteLength + buffers.state.byteLength + buffers.activity.byteLength;
  }

  updateSomaState(state: Uint8Array): void {
    if (!this.stateBuffer) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stateBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, state);
  }

  updateActivity(activity: Float32Array): void {
    if (!this.activityBuffer) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.activityBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, activity);
  }

  uploadConnections(lines: ConnectionLineSet | null): void {
    const gl = this.gl;
    if (!lines || lines.segmentCount === 0) {
      this.lineSegments = 0;
      return;
    }
    if (!this.lineVao) {
      this.lineVao = gl.createVertexArray();
      this.linePositionBuffer = gl.createBuffer();
      this.lineColorBuffer = gl.createBuffer();
      gl.bindVertexArray(this.lineVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.linePositionBuffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineColorBuffer);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.linePositionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, lines.positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineColorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, lines.colors, gl.DYNAMIC_DRAW);
    this.lineSegments = lines.segmentCount;
  }

  render(params: FrameParams): FrameStats {
    const gl = this.gl;
    const stats: FrameStats = {
      drawCalls: 0,
      somaDrawn: 0,
      lineSegments: 0,
      gpuBufferBytes: this.bufferBytes,
      gpuTimeMs: null,
    };
    if (this.disposed) return stats;

    // Remember the exact transform so a later pick() reproduces this frame.
    this.captureFrameParams(params);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.widthPx, this.heightPx);
    gl.clearColor(BG[0], BG[1], BG[2], 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (this.somaCount > 0 && this.somaVao) {
      gl.useProgram(this.somaProgram);
      this.setSomaUniforms(params);
      gl.bindVertexArray(this.somaVao);
      gl.drawArrays(gl.POINTS, 0, this.somaCount);
      stats.drawCalls++;
      stats.somaDrawn = this.somaCount;
    }

    if (params.showConnections && this.lineSegments > 0 && this.lineVao) {
      gl.useProgram(this.lineProgram);
      gl.uniformMatrix4fv(this.lineUniforms.u_viewProj, false, params.viewProj);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.bindVertexArray(this.lineVao);
      gl.drawArrays(gl.LINES, 0, this.lineSegments * 2);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      stats.drawCalls++;
      stats.lineSegments = this.lineSegments;
    }

    gl.bindVertexArray(null);
    return stats;
  }

  private setSomaUniforms(params: FrameParams): void {
    const gl = this.gl;
    const u = this.somaUniforms;
    // Projected pixel size of a world-space unit at w = 1.
    const pointScale = (params.viewProj[5] * this.heightPx) / 2;
    gl.uniformMatrix4fv(u.u_viewProj, false, params.viewProj);
    gl.uniform3fv(u.u_eye, params.eye);
    gl.uniform1f(u.u_pointScale, pointScale);
    gl.uniform1f(u.u_somaRadius, params.somaRadius);
    gl.uniform1f(u.u_minPointPx, params.minPointPx * params.devicePixelRatio);
    gl.uniform1f(u.u_maxPointPx, params.maxPointPx * params.devicePixelRatio);
    gl.uniform1i(u.u_colorMode, COLOR_MODE_CODE[params.colorMode]);
    gl.uniform1i(u.u_contextMode, params.contextMode === 'hide' ? 1 : 0);
    gl.uniform1f(u.u_dimFactor, params.dimFactor);
    gl.uniform1f(u.u_globalDim, params.globalDim);
    gl.uniform1i(u.u_activityEnabled, params.activityEnabled ? 1 : 0);
    gl.uniform3fv(u.u_background, BG);
    gl.uniform1f(u.u_depthCue, 0.22);
  }

  async pick(xPx: number, yPx: number, radiusPx: number): Promise<number> {
    const gl = this.gl;
    if (this.disposed || this.somaCount === 0 || !this.somaVao) return -1;

    this.ensurePickTarget();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.viewport(0, 0, this.widthPx, this.heightPx);
    // Clear to 0 so "no neuron" is distinguishable from neuron index 0, which is
    // why indices are written as index + 1.
    gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]));
    gl.clearBufferfv(gl.DEPTH, 0, new Float32Array([1]));

    gl.useProgram(this.pickProgram);
    const u = this.pickUniforms;
    const pointScale = (this.lastViewProj[5] * this.heightPx) / 2;
    gl.uniformMatrix4fv(u.u_viewProj, false, this.lastViewProj);
    gl.uniform1f(u.u_pointScale, pointScale);
    gl.uniform1f(u.u_somaRadius, this.lastSomaRadius);
    gl.uniform1f(u.u_minPointPx, this.lastMinPointPx);
    gl.uniform1f(u.u_maxPointPx, this.lastMaxPointPx);
    gl.uniform1i(u.u_contextMode, this.lastContextMode);

    gl.bindVertexArray(this.somaVao);
    gl.drawArrays(gl.POINTS, 0, this.somaCount);
    gl.bindVertexArray(null);

    const r = Math.max(0, Math.floor(radiusPx));
    const size = r * 2 + 1;
    const x0 = Math.max(0, Math.min(this.widthPx - size, Math.floor(xPx) - r));
    // WebGL reads with the origin at the bottom-left.
    const y0 = Math.max(
      0,
      Math.min(this.heightPx - size, this.heightPx - Math.floor(yPx) - 1 - r),
    );

    const pixels = new Uint32Array(size * size);
    gl.readPixels(x0, y0, size, size, gl.RED_INTEGER, gl.UNSIGNED_INT, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Nearest hit to the cursor wins, so dense regions select predictably.
    let best = -1;
    let bestDist = Infinity;
    for (let iy = 0; iy < size; iy++) {
      for (let ix = 0; ix < size; ix++) {
        const v = pixels[iy * size + ix];
        if (v === 0) continue;
        const dx = ix - r;
        const dy = iy - r;
        const d = dx * dx + dy * dy;
        if (d < bestDist) {
          bestDist = d;
          best = v - 1;
        }
      }
    }
    return best;
  }

  /** Cached so `pick()` can reproduce the exact transform of the last frame. */
  private lastViewProj = new Float32Array(16);
  private lastSomaRadius = 0.004;
  private lastMinPointPx = 1;
  private lastMaxPointPx = 64;
  private lastContextMode = 0;

  private captureFrameParams(params: FrameParams): void {
    this.lastViewProj.set(params.viewProj);
    this.lastSomaRadius = params.somaRadius;
    this.lastMinPointPx = params.minPointPx * params.devicePixelRatio;
    this.lastMaxPointPx = params.maxPointPx * params.devicePixelRatio;
    this.lastContextMode = params.contextMode === 'hide' ? 1 : 0;
  }

  private ensurePickTarget(): void {
    const gl = this.gl;
    if (
      this.pickFbo &&
      this.pickSize[0] === this.widthPx &&
      this.pickSize[1] === this.heightPx
    ) {
      return;
    }
    if (this.pickTexture) gl.deleteTexture(this.pickTexture);
    if (this.pickDepth) gl.deleteRenderbuffer(this.pickDepth);
    if (this.pickFbo) gl.deleteFramebuffer(this.pickFbo);

    this.pickTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.pickTexture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32UI, this.widthPx, this.heightPx);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    this.pickDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, this.widthPx, this.heightPx);

    this.pickFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.pickTexture,
      0,
    );
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.RENDERBUFFER,
      this.pickDepth,
    );
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Picking framebuffer incomplete (0x${status.toString(16)}).`);
    }
    this.pickSize = [this.widthPx, this.heightPx];
  }

  private destroySomaResources(): void {
    const gl = this.gl;
    if (this.somaVao) gl.deleteVertexArray(this.somaVao);
    if (this.staticBuffer) gl.deleteBuffer(this.staticBuffer);
    if (this.stateBuffer) gl.deleteBuffer(this.stateBuffer);
    if (this.activityBuffer) gl.deleteBuffer(this.activityBuffer);
    this.somaVao = null;
    this.staticBuffer = null;
    this.stateBuffer = null;
    this.activityBuffer = null;
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    this.destroySomaResources();
    if (this.lineVao) gl.deleteVertexArray(this.lineVao);
    if (this.linePositionBuffer) gl.deleteBuffer(this.linePositionBuffer);
    if (this.lineColorBuffer) gl.deleteBuffer(this.lineColorBuffer);
    if (this.pickTexture) gl.deleteTexture(this.pickTexture);
    if (this.pickDepth) gl.deleteRenderbuffer(this.pickDepth);
    if (this.pickFbo) gl.deleteFramebuffer(this.pickFbo);
    gl.deleteProgram(this.somaProgram);
    gl.deleteProgram(this.pickProgram);
    gl.deleteProgram(this.lineProgram);
  }
}

/** Viewport background, shared with the CSS variable --viewport-bg. */
export const BG = new Float32Array([0.031, 0.035, 0.043]);
