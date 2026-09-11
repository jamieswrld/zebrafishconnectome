import type { MeshGeometry } from '@/core/mesh';
import { computeBoneMatrices, createRestPose, MAX_BONES, type FishPose } from '@/body/rig';
import { identity, mat4, multiply, type Mat4 } from '../math';
import {
  BODY_DISPLAY_MODES,
  type BodyDisplayMode,
  type MeshDraw,
  type MeshUpload,
} from '../types';

/**
 * The organism's surface: skin, eyes, and the rig that deforms them.
 *
 * Owns no GPU resources itself — it produces {@link MeshDraw} descriptions that
 * the backend consumes, exactly as SomaLayer produces buffers. That keeps the
 * body a peer of the existing layers rather than a second rendering system.
 *
 * Nothing here touches neuron data. The body is drawn around measured
 * coordinates; it never moves them.
 */

export const BODY_MESH_ID = 'body:larva';

export class BodyLayer {
  private geometry: MeshGeometry | null = null;
  private pose: FishPose = createRestPose(MAX_BONES);
  private boneMatrices = new Float32Array(MAX_BONES * 16);

  /** Body rest space -> render world space. */
  private readonly modelMatrix: Mat4 = mat4();
  /** Extra transform applied after the rest->render mapping (world placement). */
  private readonly placement: Mat4 = mat4();
  private readonly composed: Mat4 = mat4();

  displayMode: BodyDisplayMode = 'off';
  /** Drawn only when a body mesh is actually loaded. */
  private loaded = false;

  constructor() {
    identity(this.modelMatrix);
    identity(this.placement);
    identity(this.composed);
    this.refreshBoneMatrices();
  }

  setGeometry(geometry: MeshGeometry): MeshUpload {
    this.geometry = geometry;
    this.loaded = true;
    this.pose = createRestPose(Math.max(geometry.bones.length, 1));
    this.refreshBoneMatrices();
    return { id: BODY_MESH_ID, geometry };
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  bones() {
    return this.geometry?.bones ?? [];
  }

  /** Rest-space -> render-space mapping, matching how soma were transformed. */
  setModelMatrix(m: Mat4): void {
    this.modelMatrix.set(m);
  }

  /** World placement (position/heading) applied on top, for the swimming fish. */
  setPlacement(m: Mat4): void {
    this.placement.set(m);
  }

  setPose(pose: FishPose): void {
    this.pose = pose;
    this.refreshBoneMatrices();
  }

  currentPose(): FishPose {
    return this.pose;
  }

  /** Skinning matrices, also used to place spinal neurons in the posed body. */
  currentBoneMatrices(): Float32Array {
    return this.boneMatrices;
  }

  private refreshBoneMatrices(): void {
    const bones = this.geometry?.bones;
    if (!bones || bones.length === 0) {
      for (let i = 0; i < MAX_BONES; i++) {
        const m = mat4();
        this.boneMatrices.set(m, i * 16);
      }
      return;
    }
    computeBoneMatrices(bones, this.pose, this.boneMatrices);
  }

  triangleCount(): number {
    return this.geometry ? this.geometry.indexCount / 3 : 0;
  }

  /**
   * Builds this frame's draw list.
   *
   * Skin and eyes are separate draws because they are separate materials with
   * very different opacity: at 7 dpf the retinal pigment is the most visible
   * structure in the animal, and keeping the eyes dark is what makes the
   * silhouette read as a fish even in ghost mode.
   */
  buildDraws(): MeshDraw[] {
    if (!this.loaded || this.displayMode === 'off') return [];
    const mode = BODY_DISPLAY_MODES[this.displayMode];

    multiply(this.composed, this.placement, this.modelMatrix);

    const base = {
      meshId: BODY_MESH_ID,
      modelMatrix: this.composed,
      boneMatrices: this.boneMatrices,
      occluding: mode.occludesNeurons,
    };

    return [
      {
        ...base,
        material: 'skin' as const,
        opacity: mode.skinOpacity,
        rim: mode.rim,
        tint: [1, 1, 1] as [number, number, number],
      },
      {
        ...base,
        material: 'eye' as const,
        opacity: mode.skinOpacity,
        rim: mode.rim * 0.6,
        tint: [1, 1, 1] as [number, number, number],
      },
    ];
  }
}
