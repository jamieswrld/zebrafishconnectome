import type { MaterialId } from '@/core/mesh';

/**
 * Surface materials.
 *
 * Restrained on purpose. The body exists to give the connectome a place to be,
 * not to be the spectacle: pale translucent tissue, dark eyes, and nothing that
 * glows. Neuron readability wins every conflict.
 */

export interface MaterialDefinition {
  /** Linear-ish base colour. */
  readonly baseColor: readonly [number, number, number];
  /** Multiplier on the display mode's opacity. */
  readonly opacityScale: number;
  /** Multiplier on the display mode's rim term. */
  readonly rimScale: number;
  readonly specular: number;
  /** Drawn with depth writes and no blending. */
  readonly opaque: boolean;
}

export const MATERIALS: Record<MaterialId, MaterialDefinition> = {
  /**
   * Larval tissue: faintly warm, milky, and desaturated. A 7 dpf larva is
   * near-transparent with only sparse melanophores, so the surface should read
   * as a boundary rather than a painted skin.
   */
  skin: {
    baseColor: [0.74, 0.77, 0.8],
    opacityScale: 1,
    rimScale: 1,
    specular: 0.35,
    opaque: false,
  },
  /**
   * Eyes stay dark and comparatively opaque at every display mode. In a real
   * larva the retinal pigment epithelium is the most visible structure in the
   * whole animal, and it is what makes the silhouette read as a fish.
   */
  eye: {
    baseColor: [0.06, 0.07, 0.09],
    opacityScale: 3.4,
    rimScale: 0.35,
    specular: 0.9,
    opaque: false,
  },
  'anatomical-surface': {
    baseColor: [0.42, 0.5, 0.58],
    opacityScale: 0.8,
    rimScale: 1.1,
    specular: 0.15,
    opaque: false,
  },
  debug: {
    baseColor: [0.9, 0.35, 0.3],
    opacityScale: 1,
    rimScale: 0.2,
    specular: 0,
    opaque: false,
  },
  environment: {
    baseColor: [0.1, 0.12, 0.14],
    opacityScale: 1,
    rimScale: 0.25,
    specular: 0.05,
    opaque: true,
  },
};

/** Key light direction in render world space. Soft, slightly above and front. */
export const LIGHT_DIRECTION: readonly [number, number, number] = [0.38, 0.82, 0.42];
