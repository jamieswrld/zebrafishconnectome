'use client';

import { create } from 'zustand';

import { voxelToWorld } from '@/core/coords';
import {
  loadMorphologyClass,
  loadMorphologyManifest,
  morphologyGeometry,
  type MorphologyClass,
  type MorphologyManifest,
} from '@/core/morphology';
import type { NeuronIndex } from '@/core/types';
import type { BrainRenderer } from '@/renderer/BrainRenderer';
import type { Mat4 } from '@/renderer/math';
import type { MeshDraw } from '@/renderer/types';

/**
 * Real traced neuron morphology, loaded on demand.
 *
 * Kept out of the initial load deliberately: the whole set is ~20 MB of
 * measured surface geometry, and the connectome viewer must stay fast for
 * someone who never turns it on. Classes load individually, so showing just the
 * spinal projection neurons costs 2 MB rather than 20.
 *
 * Positions come out of the artefact in SOURCE VOXELS and are mapped through
 * the same transform the soma use, taken from the loaded NeuronIndex rather
 * than recomputed. If the two ever disagreed, a neuron's shape would sit
 * somewhere its soma is not.
 */

/** Per-class tint. Measured E/I identity where the class is pure enough to say. */
export const MORPHOLOGY_CLASS_TINT: Record<string, [number, number, number]> = {
  I: [0.42, 0.78, 0.98],
  II: [0.98, 0.45, 0.62],
  I_or_II: [0.62, 0.62, 0.72],
  'L-2': [0.95, 0.55, 0.85],
  R: [0.85, 0.7, 0.45],
  P: [0.6, 0.72, 0.6],
  F: [0.5, 0.9, 0.7],
  SPN_turning: [1.0, 0.82, 0.3],
  SPN_forward: [0.95, 0.62, 0.25],
  SPN_other: [0.8, 0.7, 0.4],
  other: [0.55, 0.55, 0.6],
  unclassified: [0.45, 0.45, 0.5],
};

/** Classes shown by default: the measured pathway, not everything. */
export const DEFAULT_MORPHOLOGY_CLASSES = ['I', 'II', 'SPN_turning', 'SPN_forward'];

const MESH_PREFIX = 'hmi:morph:';

interface MorphologyStore {
  manifest: MorphologyManifest | null;
  loading: boolean;
  error: string | null;
  /** Classes whose geometry has been uploaded to the renderer. */
  loaded: Record<string, MorphologyClass>;
  /** Classes the user wants drawn. */
  visible: string[];
  /** 0..1; the surfaces are translucent so soma inside stay visible. */
  opacity: number;

  loadManifest: () => Promise<void>;
  setVisible: (classes: string[]) => void;
  toggleClass: (className: string) => void;
  setOpacity: (value: number) => void;
  /** Loads any visible class that is not yet resident on the GPU. */
  ensureLoaded: (renderer: BrainRenderer | null, index: NeuronIndex | null) => Promise<void>;
  /**
   * Draw commands for the visible classes.
   *
   * Returned rather than published, because the organism view also draws the
   * tank and the body: one owner of the draw list means the morphology can
   * never silently replace the world.
   *
   * @param modelMatrix Soma render space -> world. The neurons ride the body,
   *                    so their shapes must be placed by the same matrix.
   */
  draws: (modelMatrix: Mat4) => MeshDraw[];
  reset: () => void;
}

export const useMorphologyStore = create<MorphologyStore>((set, get) => ({
  manifest: null,
  loading: false,
  error: null,
  loaded: {},
  visible: [],
  opacity: 0.55,

  async loadManifest() {
    if (get().manifest || get().loading) return;
    set({ loading: true, error: null });
    try {
      const manifest = await loadMorphologyManifest();
      set({ manifest, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  setVisible(classes) {
    set({ visible: classes });
  },

  toggleClass(className) {
    const visible = get().visible;
    set({
      visible: visible.includes(className)
        ? visible.filter((c) => c !== className)
        : [...visible, className],
    });
  },

  setOpacity(value) {
    set({ opacity: Math.min(Math.max(value, 0), 1) });
  },

  async ensureLoaded(renderer, index) {
    if (!renderer || !index) return;
    const { manifest, visible } = get();
    if (!manifest) return;

    // Map source voxels into render space exactly as the soma are mapped.
    const toRender = (x: number, y: number, z: number, out: Float32Array, at: number): void => {
      const world = voxelToWorld([x, y, z], index.voxelSpace, index.renderTransform);
      out[at] = world[0];
      out[at + 1] = world[1];
      out[at + 2] = world[2];
    };

    for (const className of visible) {
      if (get().loaded[className]) continue;
      const entry = manifest.classes[className];
      if (!entry) continue;
      set({ loading: true });
      try {
        const morphology = await loadMorphologyClass(entry.file);
        renderer.uploadMesh(MESH_PREFIX + className, morphologyGeometry(morphology, toRender));
        set((state) => ({
          loaded: { ...state.loaded, [className]: morphology },
          loading: false,
        }));
      } catch (e) {
        set({ loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  },

  draws(modelMatrix) {
    const { loaded, visible, opacity } = get();
    const draws: MeshDraw[] = [];
    for (const className of visible) {
      if (!loaded[className]) continue;
      draws.push({
        meshId: MESH_PREFIX + className,
        modelMatrix,
        boneMatrices: null,
        material: 'anatomical-surface',
        opacity,
        rim: 0.45,
        tint: MORPHOLOGY_CLASS_TINT[className] ?? [0.7, 0.7, 0.75],
        occluding: false,
      });
    }
    return draws;
  },

  reset() {
    set({ loaded: {}, visible: [], error: null });
  },
}));

/** Cells resident across every loaded class. For the diagnostics panel. */
export function residentMorphology(loaded: Record<string, MorphologyClass>) {
  let cells = 0;
  let triangles = 0;
  for (const entry of Object.values(loaded)) {
    cells += entry.cellCount;
    triangles += entry.triangleCount;
  }
  return { cells, triangles };
}
