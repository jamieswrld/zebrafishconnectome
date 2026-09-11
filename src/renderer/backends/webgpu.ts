import type {
  ConnectionLineSet,
  FrameParams,
  FrameStats,
  RendererBackend,
  SomaBufferSet,
} from '../types';
import { COLOR_MODE_CODE, SOMA_STRIDE_BYTES } from '../types';
import { PALETTE_WGSL } from './palette';
import { BG } from './webgl2';

/**
 * WebGPU rendering backend (preferred path).
 *
 * Soma are drawn as one instanced draw of a two-triangle billboard: 6 vertices,
 * `count` instances. WebGPU point-list primitives are locked to a single pixel,
 * so billboards are the only way to get depth-scaled, anti-aliased soma.
 *
 * Picking renders instance indices into an `r32uint` attachment on demand and
 * copies a small region back, so selection cost is independent of population
 * size.
 */

const UNIFORM_BYTES = 176;

const SHARED_WGSL = `
struct Uniforms {
  viewProj: mat4x4f,
  eye: vec4f,
  background: vec4f,
  // somaRadius, minPointPx, maxPointPx, pointScale
  params0: vec4f,
  // dimFactor, globalDim, depthCue, unused
  params1: vec4f,
  // colorMode, contextMode, activityEnabled, unused
  flags: vec4i,
  viewport: vec4f,
};

@group(0) @binding(0) var<uniform> U: Uniforms;
`;

const SOMA_WGSL = `
${SHARED_WGSL}
${PALETTE_WGSL}

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
  @location(1) corner: vec2f,
};

@vertex
fn vs(
  @location(0) corner: vec2f,
  @location(1) instancePos: vec3f,
  @location(2) packed: u32,
  @location(3) state: u32,
  @location(4) activity: f32,
  @builtin(instance_index) instance: u32,
) -> VSOut {
  var out: VSOut;
  out.corner = corner;

  let cellType = packed & 0xFFu;
  let regionId = (packed >> 16u) & 0xFFFFu;

  let visible    = (state & 1u) != 0u;
  let selected   = (state & 2u) != 0u;
  let hovered    = (state & 4u) != 0u;
  let inCircuit  = (state & 8u) != 0u;
  let circuitIn  = (state & 16u) != 0u;
  let circuitOut = (state & 32u) != 0u;
  let emphasised = selected || hovered || inCircuit;

  if (!visible && !emphasised && U.flags.y == 1) {
    // 'hide' context mode: push the instance outside the clip volume.
    out.position = vec4f(0.0, 0.0, -10.0, 1.0);
    out.color = vec3f(0.0);
    return out;
  }

  var clip = U.viewProj * vec4f(instancePos, 1.0);
  let dist = max(clip.w, 1e-4);
  var sizePx = (U.params0.x * 2.0 * U.params0.w) / dist;

  var color = somaBaseColor(cellType, regionId, U.flags.x, activity, U.flags.z);
  if (U.flags.x == 3) {
    let t = clamp(dist * 0.35, 0.0, 1.0);
    color = mix(vec3f(0.82, 0.88, 0.95), vec3f(0.20, 0.26, 0.34), t);
  }

  var brightness = 1.0;
  if (!visible && !emphasised) {
    brightness = brightness * U.params1.x;
  } else {
    brightness = brightness * U.params1.y;
  }

  if (inCircuit) {
    if (circuitIn) { color = COLOR_CIRCUIT_IN; }
    else if (circuitOut) { color = COLOR_CIRCUIT_OUT; }
    brightness = 1.0;
    sizePx = sizePx * 1.7;
  }
  if (hovered) {
    color = COLOR_HOVER;
    brightness = 1.0;
    sizePx = sizePx * 2.0;
  }
  if (selected) {
    color = COLOR_SELECTED;
    brightness = 1.0;
    sizePx = sizePx * 2.6;
  }

  let haze = 1.0 - clamp((dist - 0.4) * U.params1.z, 0.0, 0.72);
  if (!selected && !hovered) { brightness = brightness * haze; }

  out.color = mix(U.background.xyz, color, clamp(brightness, 0.0, 1.0));

  let px = clamp(sizePx, U.params0.y, U.params0.z);
  // Expand the billboard in clip space: multiplying by w cancels the
  // perspective divide, so the quad lands at an exact pixel size.
  let offset = corner * px / U.viewport.xy * clip.w;
  clip = vec4f(clip.x + offset.x, clip.y + offset.y, clip.z, clip.w);
  out.position = clip;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let r2 = dot(in.corner, in.corner);
  if (r2 > 1.0) { discard; }
  let edge = 1.0 - smoothstep(0.55, 1.0, r2);
  return vec4f(in.color * (0.55 + 0.45 * edge), 1.0);
}
`;

const PICK_WGSL = `
${SHARED_WGSL}

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) corner: vec2f,
  @location(1) @interpolate(flat) id: u32,
};

@vertex
fn vs(
  @location(0) corner: vec2f,
  @location(1) instancePos: vec3f,
  @location(2) packed: u32,
  @location(3) state: u32,
  @builtin(instance_index) instance: u32,
) -> VSOut {
  var out: VSOut;
  out.corner = corner;
  out.id = instance + 1u;

  let visible = (state & 1u) != 0u;
  let emphasised = (state & (2u | 4u | 8u)) != 0u;
  if (!visible && !emphasised && U.flags.y == 1) {
    out.position = vec4f(0.0, 0.0, -10.0, 1.0);
    return out;
  }

  var clip = U.viewProj * vec4f(instancePos, 1.0);
  let dist = max(clip.w, 1e-4);
  let sizePx = (U.params0.x * 2.0 * U.params0.w) / dist;
  // Inflated so single-pixel soma stay clickable.
  let px = clamp(sizePx * 1.5, max(U.params0.y, 3.0), U.params0.z);
  let offset = corner * px / U.viewport.xy * clip.w;
  out.position = vec4f(clip.x + offset.x, clip.y + offset.y, clip.z, clip.w);
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) u32 {
  if (dot(in.corner, in.corner) > 1.0) { discard; }
  return in.id;
}
`;

const LINE_WGSL = `
${SHARED_WGSL}

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};

@vertex
fn vs(@location(0) pos: vec3f, @location(1) color: vec4f) -> VSOut {
  var out: VSOut;
  out.position = U.viewProj * vec4f(pos, 1.0);
  out.color = color;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  return in.color;
}
`;

/**
 * TypeScript models TypedArray buffers as `ArrayBufferLike`, while the WebGPU
 * types demand a non-shared `ArrayBuffer`. Every array we pass is locally
 * allocated and never shared, so this narrowing is safe.
 */
function gpuSource(view: ArrayBufferView): GPUAllowSharedBufferSource {
  return view as unknown as GPUAllowSharedBufferSource;
}

const QUAD_CORNERS = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);

export class WebGPUBackend implements RendererBackend {
  readonly api = 'webgpu' as const;
  readonly deviceDescription: string;

  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly format: GPUTextureFormat;
  private readonly canvas: HTMLCanvasElement;

  private uniformBuffer: GPUBuffer;
  private uniformData = new ArrayBuffer(UNIFORM_BYTES);
  private uniformF32 = new Float32Array(this.uniformData);
  private uniformI32 = new Int32Array(this.uniformData);
  private bindGroup: GPUBindGroup;

  private somaPipeline: GPURenderPipeline;
  private pickPipeline: GPURenderPipeline;
  private linePipeline: GPURenderPipeline;

  private quadBuffer: GPUBuffer;
  private staticBuffer: GPUBuffer | null = null;
  private stateBuffer: GPUBuffer | null = null;
  private activityBuffer: GPUBuffer | null = null;
  private somaCount = 0;
  /** Uint8 state expanded to u32, because WGSL vertex inputs have no u8 scalar. */
  private stateScratch: Uint32Array = new Uint32Array(0);

  private linePositionBuffer: GPUBuffer | null = null;
  private lineColorBuffer: GPUBuffer | null = null;
  private lineSegments = 0;

  private depthTexture: GPUTexture | null = null;
  private pickTexture: GPUTexture | null = null;
  private pickDepth: GPUTexture | null = null;
  private pickReadBuffer: GPUBuffer | null = null;

  private widthPx = 1;
  private heightPx = 1;
  private bufferBytes = 0;
  private disposed = false;
  private pickInFlight = false;

  private constructor(
    device: GPUDevice,
    canvas: HTMLCanvasElement,
    adapterInfo: string,
    onDeviceLost?: (reason: string) => void,
  ) {
    this.device = device;
    this.canvas = canvas;
    this.deviceDescription = adapterInfo;

    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Failed to acquire a WebGPU canvas context.');
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: this.format, alphaMode: 'opaque' });

    device.lost.then((info) => {
      if (this.disposed) return;
      onDeviceLost?.(`WebGPU device lost: ${info.message || info.reason}`);
    });

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });
    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });

    this.quadBuffer = device.createBuffer({
      size: QUAD_CORNERS.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.quadBuffer, 0, gpuSource(QUAD_CORNERS));

    const somaVertexLayouts: GPUVertexBufferLayout[] = [
      {
        arrayStride: 8,
        stepMode: 'vertex',
        attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
      },
      {
        arrayStride: SOMA_STRIDE_BYTES,
        stepMode: 'instance',
        attributes: [
          { shaderLocation: 1, offset: 0, format: 'float32x3' },
          { shaderLocation: 2, offset: 12, format: 'uint32' },
        ],
      },
      {
        arrayStride: 4,
        stepMode: 'instance',
        attributes: [{ shaderLocation: 3, offset: 0, format: 'uint32' }],
      },
      {
        arrayStride: 4,
        stepMode: 'instance',
        attributes: [{ shaderLocation: 4, offset: 0, format: 'float32' }],
      },
    ];

    const somaModule = device.createShaderModule({ code: SOMA_WGSL });
    this.somaPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: somaModule, entryPoint: 'vs', buffers: somaVertexLayouts },
      fragment: {
        module: somaModule,
        entryPoint: 'fs',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less-equal',
      },
    });

    const pickModule = device.createShaderModule({ code: PICK_WGSL });
    this.pickPipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: pickModule,
        entryPoint: 'vs',
        buffers: somaVertexLayouts.slice(0, 3),
      },
      fragment: {
        module: pickModule,
        entryPoint: 'fs',
        targets: [{ format: 'r32uint' }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less-equal',
      },
    });

    const lineModule = device.createShaderModule({ code: LINE_WGSL });
    this.linePipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: lineModule,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 12,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
          },
          {
            arrayStride: 16,
            attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x4' }],
          },
        ],
      },
      fragment: {
        module: lineModule,
        entryPoint: 'fs',
        targets: [
          {
            format: this.format,
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'line-list' },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: false,
        depthCompare: 'less-equal',
      },
    });
  }

  static async create(
    canvas: HTMLCanvasElement,
    onDeviceLost?: (reason: string) => void,
  ): Promise<WebGPUBackend> {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
      throw new Error('WebGPU is not exposed by this browser.');
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter is available on this device.');
    const device = await adapter.requestDevice();
    const info = adapter.info;
    const description = info
      ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') ||
        'WebGPU device'
      : 'WebGPU device';
    return new WebGPUBackend(device, canvas, description, onDeviceLost);
  }

  resize(widthPx: number, heightPx: number): void {
    this.widthPx = Math.max(1, Math.floor(widthPx));
    this.heightPx = Math.max(1, Math.floor(heightPx));
    this.canvas.width = this.widthPx;
    this.canvas.height = this.heightPx;

    this.depthTexture?.destroy();
    this.depthTexture = this.device.createTexture({
      size: [this.widthPx, this.heightPx],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });

    // Pick targets are rebuilt lazily on the next pick.
    this.pickTexture?.destroy();
    this.pickTexture = null;
    this.pickDepth?.destroy();
    this.pickDepth = null;
  }

  uploadSoma(buffers: SomaBufferSet): void {
    const device = this.device;
    this.staticBuffer?.destroy();
    this.stateBuffer?.destroy();
    this.activityBuffer?.destroy();

    this.somaCount = buffers.count;
    const staticBytes = Math.max(buffers.staticData.byteLength, 16);
    this.staticBuffer = device.createBuffer({
      size: staticBytes,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.staticBuffer, 0, buffers.staticData);

    this.stateScratch = new Uint32Array(Math.max(buffers.count, 1));
    this.stateBuffer = device.createBuffer({
      size: this.stateScratch.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.updateSomaState(buffers.state);

    this.activityBuffer = device.createBuffer({
      size: Math.max(buffers.activity.byteLength, 4),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.activityBuffer, 0, gpuSource(buffers.activity));

    this.bufferBytes = staticBytes + this.stateScratch.byteLength + buffers.activity.byteLength;
  }

  updateSomaState(state: Uint8Array): void {
    if (!this.stateBuffer) return;
    const n = Math.min(state.length, this.stateScratch.length);
    for (let i = 0; i < n; i++) this.stateScratch[i] = state[i];
    this.device.queue.writeBuffer(this.stateBuffer, 0, gpuSource(this.stateScratch));
  }

  updateActivity(activity: Float32Array): void {
    if (!this.activityBuffer) return;
    this.device.queue.writeBuffer(this.activityBuffer, 0, gpuSource(activity));
  }

  uploadConnections(lines: ConnectionLineSet | null): void {
    if (!lines || lines.segmentCount === 0) {
      this.lineSegments = 0;
      return;
    }
    const device = this.device;
    const posBytes = lines.positions.byteLength;
    const colBytes = lines.colors.byteLength;
    if (!this.linePositionBuffer || this.linePositionBuffer.size < posBytes) {
      this.linePositionBuffer?.destroy();
      this.linePositionBuffer = device.createBuffer({
        size: Math.max(posBytes, 256),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.lineColorBuffer?.destroy();
      this.lineColorBuffer = device.createBuffer({
        size: Math.max(colBytes, 256),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    device.queue.writeBuffer(this.linePositionBuffer, 0, gpuSource(lines.positions));
    device.queue.writeBuffer(this.lineColorBuffer!, 0, gpuSource(lines.colors));
    this.lineSegments = lines.segmentCount;
  }

  private writeUniforms(params: FrameParams): void {
    const f = this.uniformF32;
    const i = this.uniformI32;
    f.set(params.viewProj, 0);
    f[16] = params.eye[0];
    f[17] = params.eye[1];
    f[18] = params.eye[2];
    f[19] = 0;
    f[20] = BG[0];
    f[21] = BG[1];
    f[22] = BG[2];
    f[23] = 1;
    const pointScale = (params.viewProj[5] * this.heightPx) / 2;
    f[24] = params.somaRadius;
    f[25] = params.minPointPx * params.devicePixelRatio;
    f[26] = params.maxPointPx * params.devicePixelRatio;
    f[27] = pointScale;
    f[28] = params.dimFactor;
    f[29] = params.globalDim;
    f[30] = 0.22;
    f[31] = 0;
    i[32] = COLOR_MODE_CODE[params.colorMode];
    i[33] = params.contextMode === 'hide' ? 1 : 0;
    i[34] = params.activityEnabled ? 1 : 0;
    i[35] = 0;
    f[36] = this.widthPx;
    f[37] = this.heightPx;
    f[38] = 0;
    f[39] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
    this.lastParams = params;
  }

  private lastParams: FrameParams | null = null;

  render(params: FrameParams): FrameStats {
    const stats: FrameStats = {
      drawCalls: 0,
      somaDrawn: 0,
      lineSegments: 0,
      gpuBufferBytes: this.bufferBytes,
      gpuTimeMs: null,
    };
    if (this.disposed || !this.depthTexture) return stats;

    this.writeUniforms(params);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: BG[0], g: BG[1], b: BG[2], a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    if (this.somaCount > 0 && this.staticBuffer && this.stateBuffer && this.activityBuffer) {
      pass.setPipeline(this.somaPipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.setVertexBuffer(0, this.quadBuffer);
      pass.setVertexBuffer(1, this.staticBuffer);
      pass.setVertexBuffer(2, this.stateBuffer);
      pass.setVertexBuffer(3, this.activityBuffer);
      pass.draw(6, this.somaCount);
      stats.drawCalls++;
      stats.somaDrawn = this.somaCount;
    }

    if (params.showConnections && this.lineSegments > 0 && this.linePositionBuffer) {
      pass.setPipeline(this.linePipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.setVertexBuffer(0, this.linePositionBuffer);
      pass.setVertexBuffer(1, this.lineColorBuffer!);
      pass.draw(this.lineSegments * 2);
      stats.drawCalls++;
      stats.lineSegments = this.lineSegments;
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
    return stats;
  }

  async pick(xPx: number, yPx: number, radiusPx: number): Promise<number> {
    if (this.disposed || this.somaCount === 0 || !this.staticBuffer || !this.lastParams) {
      return -1;
    }
    // Buffer mapping is asynchronous; overlapping picks would race on it.
    if (this.pickInFlight) return -1;
    this.pickInFlight = true;
    try {
      this.ensurePickTargets();
      const device = this.device;
      const r = Math.max(0, Math.floor(radiusPx));
      const size = r * 2 + 1;
      const x0 = Math.max(0, Math.min(this.widthPx - size, Math.floor(xPx) - r));
      const y0 = Math.max(0, Math.min(this.heightPx - size, Math.floor(yPx) - r));

      // copyTextureToBuffer requires bytesPerRow to be a multiple of 256.
      const bytesPerRow = Math.ceil((size * 4) / 256) * 256;
      const needed = bytesPerRow * size;
      if (!this.pickReadBuffer || this.pickReadBuffer.size < needed) {
        this.pickReadBuffer?.destroy();
        this.pickReadBuffer = device.createBuffer({
          size: needed,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
      }

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.pickTexture!.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: {
          view: this.pickDepth!.createView(),
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      pass.setPipeline(this.pickPipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.setVertexBuffer(0, this.quadBuffer);
      pass.setVertexBuffer(1, this.staticBuffer);
      pass.setVertexBuffer(2, this.stateBuffer!);
      pass.draw(6, this.somaCount);
      pass.end();

      encoder.copyTextureToBuffer(
        { texture: this.pickTexture!, origin: { x: x0, y: y0 } },
        { buffer: this.pickReadBuffer, bytesPerRow, rowsPerImage: size },
        { width: size, height: size },
      );
      device.queue.submit([encoder.finish()]);

      await this.pickReadBuffer.mapAsync(GPUMapMode.READ, 0, needed);
      const copy = this.pickReadBuffer.getMappedRange(0, needed).slice(0);
      this.pickReadBuffer.unmap();

      const rows = new Uint32Array(copy);
      const stride = bytesPerRow / 4;
      let best = -1;
      let bestDist = Infinity;
      for (let iy = 0; iy < size; iy++) {
        for (let ix = 0; ix < size; ix++) {
          const v = rows[iy * stride + ix];
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
    } finally {
      this.pickInFlight = false;
    }
  }

  private ensurePickTargets(): void {
    if (this.pickTexture && this.pickDepth) return;
    this.pickTexture = this.device.createTexture({
      size: [this.widthPx, this.heightPx],
      format: 'r32uint',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.pickDepth = this.device.createTexture({
      size: [this.widthPx, this.heightPx],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.staticBuffer?.destroy();
    this.stateBuffer?.destroy();
    this.activityBuffer?.destroy();
    this.linePositionBuffer?.destroy();
    this.lineColorBuffer?.destroy();
    this.quadBuffer.destroy();
    this.uniformBuffer.destroy();
    this.depthTexture?.destroy();
    this.pickTexture?.destroy();
    this.pickDepth?.destroy();
    this.pickReadBuffer?.destroy();
    this.device.destroy();
  }
}
