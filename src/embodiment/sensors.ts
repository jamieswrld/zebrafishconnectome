import type { Vec3f } from '@/renderer/math';
import type { BodyState, SensoryFrame, WorldState } from './types';
import type { WorldRuntime } from './world';

/**
 * Sensing: turns world state into what the organism can know about it.
 *
 * SIMULATED SENSOR INPUT. This is explicitly a proxy, not a retina: it reports
 * bearings, angular sizes and luminance rather than pixels. That is an honest
 * first abstraction, and the interface is shaped so a real visual encoder can
 * replace it without the controller noticing.
 *
 * The one genuinely important quantity here is the LOOM RATE — the rate of
 * change of a target's angular size. It is the cue that drives escape responses
 * in real larvae, and having it computed properly now is what makes the planned
 * looming-threat experiment a plug-in rather than a rewrite.
 */

/** Body length in millimetres, used to normalise flow into body lengths/s. */
const BODY_LENGTH_MM = 4;

export class SensorRuntime {
  private previousAngularSize = new Map<string, number>();
  private lastBoutTime = 0;

  reset(): void {
    this.previousAngularSize.clear();
    this.lastBoutTime = 0;
  }

  noteBout(time: number): void {
    this.lastBoutTime = time;
  }

  /**
   * @param dt Seconds since the previous sensory frame. Used for loom rate, so
   *           it must be the behaviour timestep, not a render delta.
   */
  sense(
    world: WorldRuntime,
    worldState: WorldState,
    body: BodyState,
    dt: number,
  ): SensoryFrame {
    const heading = body.heading;
    const forward: Vec3f = [Math.cos(heading), 0, Math.sin(heading)];

    /* ------------------------------------------------------------- vision */
    let targetBearing: number | null = null;
    let targetAngularSize = 0;
    let targetLoomRate = 0;
    let nearestDistance = Infinity;

    for (const target of worldState.targets) {
      const dx = target.position[0] - body.position[0];
      const dz = target.position[2] - body.position[2];
      const distance = Math.max(Math.hypot(dx, dz), 1e-4);

      // Angular size of a sphere of radius r at distance d.
      const angular = 2 * Math.atan(target.radius / distance);
      const previous = this.previousAngularSize.get(target.id) ?? angular;
      this.previousAngularSize.set(target.id, angular);

      if (distance < nearestDistance) {
        nearestDistance = distance;
        // Bearing relative to heading, wrapped to [-pi, pi].
        let bearing = Math.atan2(dz, dx) - heading;
        while (bearing > Math.PI) bearing -= Math.PI * 2;
        while (bearing < -Math.PI) bearing += Math.PI * 2;
        targetBearing = bearing;
        targetAngularSize = angular;
        targetLoomRate = dt > 0 ? (angular - previous) / dt : 0;
      }
    }

    /* --------------------------------------------------------- luminance */
    // Dark targets reduce local luminance; this is a scene summary, not an image.
    const occlusion = Math.min(targetAngularSize / Math.PI, 1);
    const luminance = Math.max(worldState.ambientLight * (1 - occlusion * 0.8), 0);

    // Left/right split, so a lateralised light source is detectable at all.
    let gradient = 0;
    if (targetBearing !== null) {
      gradient = -Math.sin(targetBearing) * occlusion;
    }

    /* -------------------------------------------------------------- flow */
    const speed = Math.hypot(body.velocity[0], body.velocity[2]);
    const forwardComponent = body.velocity[0] * forward[0] + body.velocity[2] * forward[2];

    /* ----------------------------------------------------------- contact */
    const boundarySigned = world.boundaryDistance(body.position);
    const normal = world.boundaryNormal(body.position);
    let boundaryBearing = Math.atan2(-normal[2], -normal[0]) - heading;
    while (boundaryBearing > Math.PI) boundaryBearing -= Math.PI * 2;
    while (boundaryBearing < -Math.PI) boundaryBearing += Math.PI * 2;

    return {
      time: worldState.time,
      visual: {
        targetBearing,
        targetAngularSize,
        targetLoomRate,
        luminance,
        luminanceGradient: gradient,
      },
      flow: {
        forwardFlow: forwardComponent / BODY_LENGTH_MM,
        rotationalFlow: body.angularVelocity,
      },
      contact: {
        // boundaryDistance is negative inside the tank; report distance TO the wall.
        nearestBoundaryDistance: Math.max(-boundarySigned, 0),
        nearestBoundaryBearing: boundaryBearing,
        touching: boundarySigned > -0.8,
      },
      internal: {
        speed,
        turnRate: body.angularVelocity,
        timeSinceBout: Math.max(worldState.time - this.lastBoutTime, 0),
      },
      provenance: 'simulated',
    };
  }
}
