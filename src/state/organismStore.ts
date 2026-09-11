'use client';

import { create } from 'zustand';
import { DataError, toDataError } from '@/core/errors';
import type { TransformChain } from '@/core/spaces';
import {
  computeBodyPlacement,
  loadReferenceBody,
  neuronBoundsRender,
  type BodyManifest,
} from '@/body/placement';
import type { BodyDisplayMode, ClipPlane } from '@/renderer/types';
import type { MeshGeometry } from '@/core/mesh';
import type { Mat4 } from '@/renderer/math';
import type { Vec3f } from '@/renderer/math';
import { rendererRef } from './rendererRef';
import { useBrainStore } from './brainStore';

/**
 * Organism-view state: the body, its registration, and how it is sectioned.
 *
 * Kept separate from the brain store so the connectome viewer has no dependency
 * on embodiment. Loading /brain must not pull in the body, the rig, or the
 * simulation.
 */

export type ClipAxis = 'none' | 'sagittal' | 'coronal' | 'transverse';

export interface ClipState {
  readonly axis: ClipAxis;
  /** Plane offset along its axis, in render units. */
  readonly offset: number;
  /** Flip which half is removed. */
  readonly flipped: boolean;
  /** Whether the section also cuts the neuron cloud. */
  readonly affectsSoma: boolean;
}

/**
 * Section planes, in render space.
 *
 * Body rest space is +X anterior, +Y dorsal, +Z left, and the body model matrix
 * maps that into render space. Because the registration is a rigid axis
 * permutation, each anatomical plane is still an axis-aligned plane in render
 * space, so a single axis normal is sufficient.
 */
const CLIP_AXIS_NORMAL: Record<Exclude<ClipAxis, 'none'>, Vec3f> = {
  // Divides left from right.
  sagittal: [0, 0, 1],
  // Divides anterior from posterior.
  coronal: [1, 0, 0],
  // Divides dorsal from ventral.
  transverse: [0, 1, 0],
};

export const CLIP_AXIS_LABEL: Record<ClipAxis, string> = {
  none: 'NONE',
  sagittal: 'SAGITTAL',
  coronal: 'CORONAL',
  transverse: 'TRANSVERSE',
};

interface OrganismStore {
  loading: boolean;
  loaded: boolean;
  error: DataError | null;
  manifest: BodyManifest | null;
  bytes: number;
  triangleCount: number;
  registration: TransformChain | null;
  displayMode: BodyDisplayMode;
  clip: ClipState;
  /** Render-space bounds of the whole animal and of the neurons alone. */
  bodyBounds: { min: Vec3f; max: Vec3f } | null;
  neuronBounds: { min: Vec3f; max: Vec3f } | null;
  /**
   * Kept so the geometry can be re-pushed to a renderer created AFTER the body
   * finished loading. Held as an opaque reference; nothing subscribes to it.
   */
  geometry: MeshGeometry | null;
  modelMatrix: Mat4 | null;

  loadBody: () => Promise<void>;
  setDisplayMode: (mode: BodyDisplayMode) => void;
  setClip: (update: Partial<ClipState>) => void;
  frameWholeFish: () => void;
  frameBrain: () => void;
}

const DEFAULT_CLIP: ClipState = {
  axis: 'none',
  offset: 0,
  flipped: false,
  affectsSoma: false,
};

function buildClipPlanes(clip: ClipState): ClipPlane[] {
  if (clip.axis === 'none') return [];
  const base = CLIP_AXIS_NORMAL[clip.axis];
  const sign = clip.flipped ? -1 : 1;
  const normal: Vec3f = [base[0] * sign, base[1] * sign, base[2] * sign];
  // Discard where dot(p, n) + d > 0, so d = -offset along the (signed) normal.
  return [{ normal, distance: -clip.offset * sign }];
}

export const useOrganismStore = create<OrganismStore>((set, get) => ({
  loading: false,
  loaded: false,
  error: null,
  manifest: null,
  bytes: 0,
  triangleCount: 0,
  registration: null,
  displayMode: 'off',
  clip: DEFAULT_CLIP,
  bodyBounds: null,
  neuronBounds: null,
  geometry: null,
  modelMatrix: null,

  async loadBody() {
    if (get().loading || get().loaded) return;
    set({ loading: true, error: null });

    try {
      const { geometry, manifest, bytes } = await loadReferenceBody();
      const index = useBrainStore.getState().index;
      if (!index) {
        // The population drives the registration, so wait for it. Not an error:
        // the caller retries once the dataset is ready.
        set({ loading: false });
        return;
      }

      const placement = computeBodyPlacement(index, geometry);
      const renderer = rendererRef.current;
      if (renderer) {
        renderer.setBodyGeometry(geometry);
        renderer.setBodyModelMatrix(placement.modelMatrix);
      }

      set({
        loading: false,
        loaded: true,
        geometry,
        modelMatrix: placement.modelMatrix,
        manifest,
        bytes,
        triangleCount: geometry.indexCount / 3,
        registration: placement.registration,
        bodyBounds: placement.boundsRender,
        neuronBounds: neuronBoundsRender(index),
      });
    } catch (e) {
      set({ loading: false, error: toDataError(e) });
    }
  },

  setDisplayMode(mode) {
    set({ displayMode: mode });
    rendererRef.current?.setBodyDisplayMode(mode);
  },

  setClip(update) {
    const clip = { ...get().clip, ...update };
    set({ clip });
    rendererRef.current?.setClipPlanes(buildClipPlanes(clip), clip.affectsSoma);
  },

  frameWholeFish() {
    const bounds = get().bodyBounds;
    if (bounds) rendererRef.current?.frameBounds(bounds.min, bounds.max);
  },

  frameBrain() {
    const bounds = get().neuronBounds;
    if (bounds) rendererRef.current?.frameBounds(bounds.min, bounds.max);
    else rendererRef.current?.resetCamera();
  },
}));

/** Re-applies organism state to a renderer that was created after it. */
export function syncOrganismWithRenderer(): void {
  const renderer = rendererRef.current;
  if (!renderer) return;
  const state = useOrganismStore.getState();

  // The body may have finished loading while the GPU device was still being
  // requested, in which case setBodyGeometry had nothing to call. Re-push it.
  if (state.geometry && state.modelMatrix) {
    renderer.setBodyGeometry(state.geometry);
    renderer.setBodyModelMatrix(state.modelMatrix);
  }

  renderer.setBodyDisplayMode(state.displayMode);
  renderer.setClipPlanes(buildClipPlanes(state.clip), state.clip.affectsSoma);

  // setNeuronIndex re-frames the camera on the neurons, so a renderer created
  // after the body loaded would silently undo the whole-fish framing. Re-apply
  // it here, where we know both are present.
  if (state.displayMode !== 'off' && state.bodyBounds) {
    renderer.frameBounds(state.bodyBounds.min, state.bodyBounds.max);
  }
}
