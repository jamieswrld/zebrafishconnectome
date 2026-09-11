import type { CellPolarity } from '@/core/types';

/**
 * The single source of truth for biological colour.
 *
 * Defined once here as linear-ish RGB triples and emitted into both the GLSL
 * and WGSL shaders, so the legend in the DOM can never drift from what the GPU
 * actually draws.
 *
 * Colour is used sparingly and semantically: cell identity, selection, and
 * circuit role. Everything else in the interface stays neutral.
 */

export type Rgb = readonly [number, number, number];

export const CELL_COLORS: Record<CellPolarity, Rgb> = {
  excitatory: [0.925, 0.639, 0.243],
  inhibitory: [0.325, 0.702, 0.796],
  modulatory: [0.639, 0.471, 0.82],
  'non-neuronal': [0.357, 0.42, 0.318],
  unknown: [0.463, 0.51, 0.565],
};

export const COLOR_SELECTED: Rgb = [1.0, 0.973, 0.929];
export const COLOR_HOVER: Rgb = [0.706, 0.855, 1.0];
/** A partner that sends input to the selected cell. */
export const COLOR_CIRCUIT_IN: Rgb = [0.427, 0.784, 0.545];
/** A partner that receives output from the selected cell. */
export const COLOR_CIRCUIT_OUT: Rgb = [0.941, 0.435, 0.396];

export function rgbToCss(c: Rgb): string {
  const to255 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${to255(c[0])} ${to255(c[1])} ${to255(c[2])})`;
}

function glslVec3(c: Rgb): string {
  return `vec3(${c[0].toFixed(4)}, ${c[1].toFixed(4)}, ${c[2].toFixed(4)})`;
}

function wgslVec3(c: Rgb): string {
  return `vec3f(${c[0].toFixed(4)}, ${c[1].toFixed(4)}, ${c[2].toFixed(4)})`;
}

/**
 * Activity ramp: dark blue through amber to white. Only used when a functional
 * dataset is driving the activity lane; the badge in the HUD states which
 * runtime mode produced it.
 */
const ACTIVITY_RAMP: readonly Rgb[] = [
  [0.06, 0.09, 0.16],
  [0.12, 0.33, 0.55],
  [0.45, 0.66, 0.6],
  [0.93, 0.73, 0.3],
  [1.0, 0.98, 0.92],
];

export const PALETTE_GLSL = `
const vec3 COLOR_EXC = ${glslVec3(CELL_COLORS.excitatory)};
const vec3 COLOR_INH = ${glslVec3(CELL_COLORS.inhibitory)};
const vec3 COLOR_MOD = ${glslVec3(CELL_COLORS.modulatory)};
const vec3 COLOR_NONNEURONAL = ${glslVec3(CELL_COLORS['non-neuronal'])};
const vec3 COLOR_UNKNOWN = ${glslVec3(CELL_COLORS.unknown)};
const vec3 COLOR_SELECTED = ${glslVec3(COLOR_SELECTED)};
const vec3 COLOR_HOVER = ${glslVec3(COLOR_HOVER)};
const vec3 COLOR_CIRCUIT_IN = ${glslVec3(COLOR_CIRCUIT_IN)};
const vec3 COLOR_CIRCUIT_OUT = ${glslVec3(COLOR_CIRCUIT_OUT)};

vec3 cellTypeColor(uint cellType) {
  if (cellType == 1u) return COLOR_EXC;
  if (cellType == 2u) return COLOR_INH;
  if (cellType == 3u) return COLOR_MOD;
  if (cellType == 4u) return COLOR_NONNEURONAL;
  return COLOR_UNKNOWN;
}

vec3 activityColor(float t) {
  t = clamp(t, 0.0, 1.0);
  float s = t * 4.0;
  int i = int(floor(s));
  float f = fract(s);
  vec3 ramp[5];
  ramp[0] = ${glslVec3(ACTIVITY_RAMP[0])};
  ramp[1] = ${glslVec3(ACTIVITY_RAMP[1])};
  ramp[2] = ${glslVec3(ACTIVITY_RAMP[2])};
  ramp[3] = ${glslVec3(ACTIVITY_RAMP[3])};
  ramp[4] = ${glslVec3(ACTIVITY_RAMP[4])};
  if (i >= 4) return ramp[4];
  return mix(ramp[i], ramp[i + 1], f);
}

// Region colours are arbitrary display hues derived from the region index.
// They carry no anatomical meaning beyond "these cells share a region label".
vec3 regionColor(uint regionId) {
  if (regionId == 0xFFFFu) return COLOR_UNKNOWN;
  float h = fract(float(regionId) * 0.6180339887);
  vec3 k = vec3(3.0, 2.0, 1.0);
  vec3 p = abs(fract(vec3(h) + k / 3.0) * 6.0 - 3.0);
  return mix(vec3(0.35), clamp(p - 1.0, 0.0, 1.0), 0.65);
}

vec3 somaBaseColor(uint cellType, uint regionId, int colorMode, float activity, int activityEnabled) {
  if (colorMode == 1) return regionColor(regionId);
  if (colorMode == 2 && activityEnabled == 1) return activityColor(activity);
  if (colorMode == 4) return COLOR_UNKNOWN;
  return cellTypeColor(cellType);
}
`;

export const PALETTE_WGSL = `
const COLOR_EXC = ${wgslVec3(CELL_COLORS.excitatory)};
const COLOR_INH = ${wgslVec3(CELL_COLORS.inhibitory)};
const COLOR_MOD = ${wgslVec3(CELL_COLORS.modulatory)};
const COLOR_NONNEURONAL = ${wgslVec3(CELL_COLORS['non-neuronal'])};
const COLOR_UNKNOWN = ${wgslVec3(CELL_COLORS.unknown)};
const COLOR_SELECTED = ${wgslVec3(COLOR_SELECTED)};
const COLOR_HOVER = ${wgslVec3(COLOR_HOVER)};
const COLOR_CIRCUIT_IN = ${wgslVec3(COLOR_CIRCUIT_IN)};
const COLOR_CIRCUIT_OUT = ${wgslVec3(COLOR_CIRCUIT_OUT)};

fn cellTypeColor(cellType: u32) -> vec3f {
  if (cellType == 1u) { return COLOR_EXC; }
  if (cellType == 2u) { return COLOR_INH; }
  if (cellType == 3u) { return COLOR_MOD; }
  if (cellType == 4u) { return COLOR_NONNEURONAL; }
  return COLOR_UNKNOWN;
}

fn activityColor(tIn: f32) -> vec3f {
  let t = clamp(tIn, 0.0, 1.0);
  let s = t * 4.0;
  let i = i32(floor(s));
  let f = fract(s);
  var ramp = array<vec3f, 5>(
    ${wgslVec3(ACTIVITY_RAMP[0])},
    ${wgslVec3(ACTIVITY_RAMP[1])},
    ${wgslVec3(ACTIVITY_RAMP[2])},
    ${wgslVec3(ACTIVITY_RAMP[3])},
    ${wgslVec3(ACTIVITY_RAMP[4])}
  );
  if (i >= 4) { return ramp[4]; }
  return mix(ramp[i], ramp[i + 1], f);
}

// Region colours are arbitrary display hues derived from the region index.
// They carry no anatomical meaning beyond "these cells share a region label".
fn regionColor(regionId: u32) -> vec3f {
  if (regionId == 0xFFFFu) { return COLOR_UNKNOWN; }
  let h = fract(f32(regionId) * 0.6180339887);
  let k = vec3f(3.0, 2.0, 1.0);
  let p = abs(fract(vec3f(h) + k / 3.0) * 6.0 - 3.0);
  return mix(vec3f(0.35), clamp(p - 1.0, vec3f(0.0), vec3f(1.0)), 0.65);
}

fn somaBaseColor(cellType: u32, regionId: u32, colorMode: i32, activity: f32, activityEnabled: i32) -> vec3f {
  if (colorMode == 1) { return regionColor(regionId); }
  if (colorMode == 2 && activityEnabled == 1) { return activityColor(activity); }
  if (colorMode == 4) { return COLOR_UNKNOWN; }
  return cellTypeColor(cellType);
}
`;
