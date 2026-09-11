import { SeededRandom } from '@/core/random';
import type { Vec3f } from '@/renderer/math';
import type { TankBounds, VisualTarget, WorldState } from './types';

/**
 * The world: a dark research tank, not a game aquarium.
 *
 * Deliberately minimal. Its job in Phase 2 is to be a real, queryable
 * environment that closes the loop — bounds the fish can run into, a light
 * level, and a movable visual target that a future looming experiment can drive.
 * Nothing here is decorative.
 */

export const DEFAULT_TANK: TankBounds = {
  // A 35 x 35 mm dish, 12 mm of water: the scale of a real larval behaviour rig.
  halfWidth: 17.5,
  halfDepth: 17.5,
  height: 12,
};

export interface WorldOptions {
  readonly bounds?: TankBounds;
  readonly seed?: number;
  readonly ambientLight?: number;
}

export class WorldRuntime {
  readonly bounds: TankBounds;
  private targets: VisualTarget[] = [];
  private ambient: number;
  private lightDir: Vec3f = [0.3, -0.9, 0.2];
  private time = 0;
  private random: SeededRandom;

  constructor(options: WorldOptions = {}) {
    this.bounds = options.bounds ?? DEFAULT_TANK;
    this.ambient = options.ambientLight ?? 0.45;
    this.random = new SeededRandom(options.seed ?? 1);
    this.reset(options.seed ?? 1);
  }

  reset(seed: number): void {
    this.random.reset(seed);
    this.time = 0;
    // One stationary dark disc: enough to make orientation behaviour
    // observable, and the seed for the looming experiment later.
    this.targets = [
      {
        id: 'target-a',
        position: [this.random.range(-8, 8), 0, this.random.range(-8, 8)],
        radius: 1.6,
        brightness: 0.05,
      },
    ];
  }

  step(dt: number): void {
    this.time += dt;
  }

  setAmbientLight(value: number): void {
    this.ambient = Math.min(Math.max(value, 0), 1);
  }

  ambientLight(): number {
    return this.ambient;
  }

  moveTarget(id: string, position: Vec3f): void {
    this.targets = this.targets.map((t) => (t.id === id ? { ...t, position } : t));
  }

  setTargetRadius(id: string, radius: number): void {
    this.targets = this.targets.map((t) => (t.id === id ? { ...t, radius } : t));
  }

  state(): WorldState {
    return {
      time: this.time,
      bounds: this.bounds,
      targets: this.targets,
      ambientLight: this.ambient,
      lightDirection: this.lightDir,
      provenance: 'simulated',
    };
  }

  /**
   * Signed distance to the tank wall in the horizontal plane.
   * Negative inside, positive outside.
   */
  boundaryDistance(position: Vec3f): number {
    const dx = this.bounds.halfWidth - Math.abs(position[0]);
    const dz = this.bounds.halfDepth - Math.abs(position[2]);
    return -Math.min(dx, dz);
  }

  /** Inward normal of the nearest wall, for collision response and sensing. */
  boundaryNormal(position: Vec3f): Vec3f {
    const dx = this.bounds.halfWidth - Math.abs(position[0]);
    const dz = this.bounds.halfDepth - Math.abs(position[2]);
    if (dx < dz) return [position[0] > 0 ? -1 : 1, 0, 0];
    return [0, 0, position[2] > 0 ? -1 : 1];
  }

  /** Clamps a position back inside the tank. Returns true if it was outside. */
  constrain(position: Vec3f): boolean {
    let hit = false;
    const margin = 0.6;
    if (position[0] > this.bounds.halfWidth - margin) {
      position[0] = this.bounds.halfWidth - margin;
      hit = true;
    }
    if (position[0] < -this.bounds.halfWidth + margin) {
      position[0] = -this.bounds.halfWidth + margin;
      hit = true;
    }
    if (position[2] > this.bounds.halfDepth - margin) {
      position[2] = this.bounds.halfDepth - margin;
      hit = true;
    }
    if (position[2] < -this.bounds.halfDepth + margin) {
      position[2] = -this.bounds.halfDepth + margin;
      hit = true;
    }
    // Larvae swim in a shallow column; keep them off the floor and surface.
    const top = this.bounds.height * 0.5 - 1;
    const bottom = -this.bounds.height * 0.5 + 1;
    if (position[1] > top) {
      position[1] = top;
      hit = true;
    }
    if (position[1] < bottom) {
      position[1] = bottom;
      hit = true;
    }
    return hit;
  }
}
