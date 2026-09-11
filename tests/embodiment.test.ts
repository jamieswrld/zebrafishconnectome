import { describe, expect, it } from 'vitest';
import { decodeNeuronIndex, encodeNeuronIndex } from '@/core/binary';
import {
  BODY_LENGTH_UM,
  composeChain,
  fish1PhysicalToBodyRest,
  fish1SourceToPhysical,
  bodyRestToWorld,
  applyChain,
  applyChainInverse,
} from '@/core/transforms';
import { computeBodyPlacement } from '@/body/placement';
import { buildLarvaModel, HEAD_END_U, SNOUT_X_UM } from '@/body/larva';
import {
  applyTailWave,
  computeBoneMatrices,
  createRestPose,
  MAX_BONES,
  skinPoint,
} from '@/body/rig';
import { SimulationClock, PHYSICS_DT, BEHAVIOR_DT } from '@/embodiment/clock';
import { WorldRuntime } from '@/embodiment/world';
import { FishBodyRuntime } from '@/embodiment/body';
import { BaselineLocomotionController } from '@/embodiment/controller';
import { SensorRuntime } from '@/embodiment/sensors';
import { AgentEventBus } from '@/embodiment/events';
import {
  CapabilityGateway,
  SANDBOX_ECHO_CAPABILITY,
  SANDBOX_ECHO_EXECUTOR,
  containsSecretLikeField,
  PLANNED_CAPABILITIES,
} from '@/embodiment/capabilities';
import { CELL_TYPE_CODE } from '@/core/types';
import type { Vec3f } from '@/renderer/math';

/* -------------------------------------------------------------------------- */
/* Spatial transforms                                                         */
/* -------------------------------------------------------------------------- */

describe('coordinate spaces', () => {
  const voxelSize: Vec3f = [8, 8, 30];
  const centroid: Vec3f = [1000, 500, 150];

  it('composes source voxels all the way to body rest space', () => {
    const chain = composeChain([
      fish1SourceToPhysical(voxelSize),
      fish1PhysicalToBodyRest(centroid),
    ]);
    expect(chain.steps).toHaveLength(2);
    expect(chain.matrix).toBeDefined();
  });

  it('is invertible: a body-space position returns to its exact source voxel', () => {
    const chain = composeChain([
      fish1SourceToPhysical(voxelSize),
      fish1PhysicalToBodyRest(centroid),
    ]);
    const source: Vec3f = [125000, 62500, 5000];
    const body = applyChain(chain, source);
    const back = applyChainInverse(chain, body);
    expect(back[0]).toBeCloseTo(source[0], 2);
    expect(back[1]).toBeCloseTo(source[1], 2);
    expect(back[2]).toBeCloseTo(source[2], 2);
  });

  it('reports the WEAKEST provenance across a chain', () => {
    const chain = composeChain([
      fish1SourceToPhysical(voxelSize),
      fish1PhysicalToBodyRest(centroid),
    ]);
    // Exact unit conversion + approximate alignment = approximate overall.
    expect(chain.approximate).toBe(true);
    expect(chain.errorEstimateUm).toBeNull();
  });

  it('keeps the registration rigid: distances are preserved', () => {
    const t = fish1PhysicalToBodyRest(centroid);
    const chain = composeChain([t]);
    const a: Vec3f = [1000, 500, 150];
    const b: Vec3f = [1100, 560, 200];
    const distBefore = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const ta = applyChain(chain, a);
    const tb = applyChain(chain, b);
    const distAfter = Math.hypot(tb[0] - ta[0], tb[1] - ta[1], tb[2] - ta[2]);
    // No scaling: a registration that stretched the brain would corrupt every
    // measured distance in the dataset.
    expect(distAfter).toBeCloseTo(distBefore, 4);
  });

  it('places the population centroid at the brain anchor inside the head', () => {
    const chain = composeChain([fish1PhysicalToBodyRest(centroid)]);
    const anchored = applyChain(chain, centroid);
    // Anterior of the head/trunk joint, so brain tissue is never deformed.
    expect(anchored[0]).toBeGreaterThan(SNOUT_X_UM - HEAD_END_U);
    expect(anchored[0]).toBeLessThan(SNOUT_X_UM);
  });

  it('rejects a discontinuous chain', () => {
    expect(() =>
      composeChain([fish1PhysicalToBodyRest(centroid), fish1SourceToPhysical(voxelSize)]),
    ).toThrow(/discontinuous/);
  });

  it('places the body in the world without scaling distortion', () => {
    const t = bodyRestToWorld([5, 0, -3], Math.PI / 3);
    const chain = composeChain([t]);
    const a = applyChain(chain, [0, 0, 0]);
    // Body units are micrometres, world units millimetres.
    expect(a[0]).toBeCloseTo(5, 5);
    expect(a[2]).toBeCloseTo(-3, 5);
  });
});

/* -------------------------------------------------------------------------- */
/* The rule that must never break                                             */
/* -------------------------------------------------------------------------- */

describe('measured coordinates are immutable', () => {
  function buildIndex() {
    const count = 64;
    const positionsVoxel = new Int32Array(count * 3);
    const loreIds = new Uint32Array(count);
    const cellTypes = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      positionsVoxel[i * 3] = 120000 + i * 7;
      positionsVoxel[i * 3 + 1] = 40000 + i * 11;
      positionsVoxel[i * 3 + 2] = 5000 + i;
      loreIds[i] = 1000 + i;
      cellTypes[i] = CELL_TYPE_CODE.excitatory;
    }
    return decodeNeuronIndex(
      encodeNeuronIndex({
        datasetId: 'test',
        origin: 'preprocessed-export',
        count,
        version: { materializationVersion: null, label: 'test' },
        voxelSpace: { voxelSizeNm: [8, 8, 30], axisOrder: 'xyz' },
        positionProvenance: 'measured',
        regions: [],
        positionsVoxel,
        loreIds,
        cellTypes,
      }),
    );
  }

  it('body placement does not touch neuron data', () => {
    const index = buildIndex();
    const before = Array.from(index.positionsVoxel);
    const beforeUm = Array.from(index.positionsUm);

    const model = buildLarvaModel({ stations: 24, ringSegments: 8, eyeSegments: 6 });
    computeBodyPlacement(index, {
      name: 'larva',
      vertexCount: model.vertexCount,
      indexCount: model.indices.length,
      positions: model.positions,
      normals: model.normals,
      indices: model.indices,
      subMeshes: model.subMeshes,
      bones: model.bones,
      boundsUm: { min: [-3750, -200, -200], max: [250, 200, 200] },
      space: 'body-rest',
      sourceAttribution: 'test',
      license: 'test',
    });

    expect(Array.from(index.positionsVoxel)).toEqual(before);
    expect(Array.from(index.positionsUm)).toEqual(beforeUm);
    expect(index.positionProvenance).toBe('measured');
  });
});

/* -------------------------------------------------------------------------- */
/* Rig                                                                        */
/* -------------------------------------------------------------------------- */

describe('body rig', () => {
  const model = buildLarvaModel({ stations: 40, ringSegments: 10, eyeSegments: 6 });

  it('produces a closed, well-formed mesh', () => {
    expect(model.vertexCount).toBeGreaterThan(300);
    expect(model.indices.length % 3).toBe(0);
    for (const index of model.indices) expect(index).toBeLessThan(model.vertexCount);
  });

  it('is deterministic', () => {
    const a = buildLarvaModel({ stations: 30, ringSegments: 8, eyeSegments: 6 });
    const b = buildLarvaModel({ stations: 30, ringSegments: 8, eyeSegments: 6 });
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
  });

  it('gives every vertex bone weights that sum to one', () => {
    for (let i = 0; i < model.vertexCount; i++) {
      const sum = model.boneWeights[i * 4] + model.boneWeights[i * 4 + 1];
      expect(sum).toBeGreaterThanOrEqual(253);
      expect(sum).toBeLessThanOrEqual(256);
    }
  });

  it('binds the head rigidly to bone 0', () => {
    for (let i = 0; i < model.vertexCount; i++) {
      const x = model.positions[i * 3];
      const u = SNOUT_X_UM - x;
      if (u < HEAD_END_U * 0.8) {
        expect(model.boneIndices[i * 4]).toBe(0);
        expect(model.boneWeights[i * 4]).toBe(255);
      }
    }
  });

  it('leaves the body straight in the rest pose', () => {
    const matrices = new Float32Array(MAX_BONES * 16);
    computeBoneMatrices(model.bones, createRestPose(model.bones.length), matrices);
    const p = skinPoint([-2000, 0, 0], matrices, [4, 4], [1, 0]);
    expect(p[0]).toBeCloseTo(-2000, 4);
    expect(p[2]).toBeCloseTo(0, 4);
  });

  it('bends the tail far more than the head', () => {
    const pose = applyTailWave(
      model.bones,
      { phase: Math.PI / 2, amplitude: 1, bias: 0 },
      createRestPose(model.bones.length),
    );
    // Bone 0 is the head and must never rotate.
    expect(pose.boneAngles[0]).toBe(0);
    const anterior = Math.abs(pose.boneAngles[1]);
    const posterior = Math.abs(pose.boneAngles[model.bones.length - 1]);
    expect(posterior).toBeGreaterThan(anterior);
  });

  it('moves the tail when posed, while the snout stays put', () => {
    const matrices = new Float32Array(MAX_BONES * 16);
    const pose = applyTailWave(
      model.bones,
      { phase: 0.4, amplitude: 1, bias: 0.8 },
      createRestPose(model.bones.length),
    );
    computeBoneMatrices(model.bones, pose, matrices);

    const snout = skinPoint([SNOUT_X_UM, 0, 0], matrices, [0, 0], [1, 0]);
    expect(snout[0]).toBeCloseTo(SNOUT_X_UM, 4);
    expect(snout[2]).toBeCloseTo(0, 4);

    const last = model.bones.length - 1;
    const tail = skinPoint([model.bones[last].tailUm[0], 0, 0], matrices, [last, last], [1, 0]);
    expect(Math.abs(tail[2])).toBeGreaterThan(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Clock                                                                      */
/* -------------------------------------------------------------------------- */

describe('simulation clock', () => {
  it('runs physics on a fixed timestep regardless of frame rate', () => {
    const a = new SimulationClock();
    let stepsA = 0;
    // 60 fps for one second.
    for (let i = 0; i < 60; i++) stepsA += a.advance(1 / 60).physicsSteps;

    const b = new SimulationClock();
    let stepsB = 0;
    // 20 fps for one second: same simulated time, same step count.
    for (let i = 0; i < 20; i++) stepsB += b.advance(1 / 20).physicsSteps;

    expect(stepsA).toBe(stepsB);
    expect(a.time()).toBeCloseTo(b.time(), 6);
  });

  it('advances simulation time in exact timestep multiples', () => {
    const clock = new SimulationClock();
    const tick = clock.advance(0.1);
    expect(clock.time()).toBeCloseTo(tick.physicsSteps * PHYSICS_DT, 9);
  });

  it('runs behaviour slower than physics', () => {
    const clock = new SimulationClock();
    // Stay under the stall clamp so this measures the rate ratio, not the clamp.
    const tick = clock.advance(0.2);
    expect(tick.behaviorSteps).toBeLessThan(tick.physicsSteps);
    expect(tick.behaviorSteps).toBeCloseTo(0.2 / BEHAVIOR_DT, 0);
    expect(tick.physicsSteps).toBeCloseTo(0.2 / PHYSICS_DT, 0);
  });

  it('does not simulate a long stall as a burst of steps', () => {
    const clock = new SimulationClock();
    // A backgrounded tab returning after 10 seconds.
    const tick = clock.advance(10);
    expect(tick.physicsSteps).toBeLessThanOrEqual(Math.ceil(0.25 / PHYSICS_DT) + 1);
  });

  it('stops advancing when paused or at zero time scale', () => {
    const clock = new SimulationClock();
    clock.setPaused(true);
    expect(clock.advance(1).physicsSteps).toBe(0);
    clock.setPaused(false);
    clock.setTimeScale(0);
    expect(clock.advance(1).physicsSteps).toBe(0);
    expect(clock.paused()).toBe(true);
  });

  it('scales simulated time without touching real time', () => {
    const clock = new SimulationClock();
    clock.setTimeScale(4);
    clock.advance(0.2);
    // 0.2 s of wall time at 4x is 0.8 s of simulation.
    expect(clock.time()).toBeGreaterThan(0.75);
    expect(clock.realElapsed()).toBeCloseTo(0.2, 4);
  });

  it('reports true wall-clock time even across a stall', () => {
    const clock = new SimulationClock();
    clock.advance(10);
    // The simulation is clamped, but real elapsed time must stay honest.
    expect(clock.realElapsed()).toBeCloseTo(10, 4);
    expect(clock.time()).toBeLessThan(0.3);
  });
});

/* -------------------------------------------------------------------------- */
/* World and body                                                             */
/* -------------------------------------------------------------------------- */

describe('world and body mechanics', () => {
  const model = buildLarvaModel({ stations: 24, ringSegments: 8, eyeSegments: 6 });

  it('keeps the organism inside the tank', () => {
    const world = new WorldRuntime({ seed: 3 });
    const body = new FishBodyRuntime({ bones: model.bones });
    body.reset([0, 0, 0], 0);

    // Drive hard in one direction for 20 simulated seconds.
    for (let i = 0; i < 20 / PHYSICS_DT; i++) {
      body.step(
        PHYSICS_DT,
        { time: 0, forwardDrive: 1, turnDrive: 0, startleDrive: 0, provenance: 'simulated' },
        world,
      );
    }
    const p = body.state().position;
    expect(Math.abs(p[0])).toBeLessThanOrEqual(world.bounds.halfWidth);
    expect(Math.abs(p[2])).toBeLessThanOrEqual(world.bounds.halfDepth);
  });

  it('swims in bouts separated by glides, not continuously', () => {
    const world = new WorldRuntime({ seed: 5 });
    const body = new FishBodyRuntime({ bones: model.bones });
    const states = new Set<string>();
    for (let i = 0; i < 2 / PHYSICS_DT; i++) {
      body.step(
        PHYSICS_DT,
        { time: 0, forwardDrive: 1, turnDrive: 0, startleDrive: 0, provenance: 'simulated' },
        world,
      );
      states.add(body.state().boutState);
    }
    expect(states.has('forward-bout')).toBe(true);
    expect(states.has('glide')).toBe(true);
  });

  it('reaches a larval swimming speed, not a submarine one', () => {
    const world = new WorldRuntime({ seed: 7 });
    const body = new FishBodyRuntime({ bones: model.bones });
    let peak = 0;
    for (let i = 0; i < 4 / PHYSICS_DT; i++) {
      body.step(
        PHYSICS_DT,
        { time: 0, forwardDrive: 1, turnDrive: 0, startleDrive: 0, provenance: 'simulated' },
        world,
      );
      peak = Math.max(peak, body.speedBodyLengths());
    }
    // A few body lengths per second during a bout.
    expect(peak).toBeGreaterThan(0.5);
    expect(peak).toBeLessThan(12);
  });

  it('decelerates during a glide, because drag dominates at this scale', () => {
    const world = new WorldRuntime({ seed: 9 });
    const body = new FishBodyRuntime({ bones: model.bones });
    for (let i = 0; i < 0.2 / PHYSICS_DT; i++) {
      body.step(
        PHYSICS_DT,
        { time: 0, forwardDrive: 1, turnDrive: 0, startleDrive: 0, provenance: 'simulated' },
        world,
      );
    }
    const moving = body.speedBodyLengths();
    for (let i = 0; i < 1.0 / PHYSICS_DT; i++) {
      body.step(
        PHYSICS_DT,
        { time: 0, forwardDrive: 0, turnDrive: 0, startleDrive: 0, provenance: 'simulated' },
        world,
      );
    }
    expect(body.speedBodyLengths()).toBeLessThan(moving * 0.2);
  });

  it('reports the boundary correctly', () => {
    const world = new WorldRuntime({ seed: 1 });
    expect(world.boundaryDistance([0, 0, 0])).toBeLessThan(0);
    const outside: Vec3f = [world.bounds.halfWidth + 5, 0, 0];
    expect(world.boundaryDistance(outside)).toBeGreaterThan(0);
    expect(world.constrain(outside)).toBe(true);
    expect(outside[0]).toBeLessThan(world.bounds.halfWidth);
  });
});

/* -------------------------------------------------------------------------- */
/* Controller determinism                                                     */
/* -------------------------------------------------------------------------- */

describe('baseline controller', () => {
  const model = buildLarvaModel({ stations: 24, ringSegments: 8, eyeSegments: 6 });

  function run(seed: number) {
    const world = new WorldRuntime({ seed });
    const sensors = new SensorRuntime();
    const body = new FishBodyRuntime({ bones: model.bones });
    const controller = new BaselineLocomotionController();
    controller.reset(seed);

    const actions: string[] = [];
    for (let i = 0; i < 200; i++) {
      const worldState = world.state();
      const sensory = sensors.sense(world, worldState, body.state(), BEHAVIOR_DT);
      const out = controller.step(BEHAVIOR_DT, sensory, {
        agent: {
          energy: 1,
          novelty: 0.5,
          arousal: 0.35,
          threatEstimate: 0,
          explorationDrive: 0.5,
        },
        world: worldState,
        body: body.state(),
      });
      actions.push(out.selected?.action ?? 'none');
      for (let p = 0; p < BEHAVIOR_DT / PHYSICS_DT; p++) {
        body.step(PHYSICS_DT, out.motor, world);
        world.step(PHYSICS_DT);
      }
    }
    return actions;
  }

  it('is reproducible from a seed', () => {
    expect(run(42)).toEqual(run(42));
  });

  it('differs between seeds', () => {
    expect(run(1)).not.toEqual(run(2));
  });

  it('declares that it is not driven by the connectome', () => {
    const controller = new BaselineLocomotionController();
    expect(controller.connectomeCoupled).toBe(false);
    expect(controller.provenance).toBe('simulated');
  });

  it('actually produces swim bouts rather than sitting still', () => {
    const actions = run(11);
    expect(
      actions.some((a) => a === 'SWIM_FORWARD' || a === 'TURN_LEFT' || a === 'TURN_RIGHT'),
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

describe('agent event log', () => {
  it('preserves order and assigns increasing ids', () => {
    const bus = new AgentEventBus(10);
    for (let i = 0; i < 5; i++) {
      bus.emit({ type: 'movement', summary: `m${i}`, timestamp: i });
    }
    const recent = bus.recent();
    expect(recent.map((e) => e.summary)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(recent[0].id).toBe('e1');
  });

  it('bounds memory by evicting the oldest events', () => {
    const bus = new AgentEventBus(4);
    for (let i = 0; i < 10; i++) bus.emit({ type: 'movement', summary: `m${i}`, timestamp: i });
    expect(bus.size()).toBe(4);
    expect(bus.recent()[0].summary).toBe('m6');
    expect(bus.total()).toBe(10);
    expect(bus.dropped()).toBeGreaterThan(0);
  });

  it('notifies subscribers and survives a throwing listener', () => {
    const bus = new AgentEventBus();
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error('bad listener');
    });
    bus.subscribe((e) => seen.push(e.summary));
    bus.emit({ type: 'movement', summary: 'ok', timestamp: 0 });
    expect(seen).toEqual(['ok']);
  });

  it('serialises to stable JSON', () => {
    const bus = new AgentEventBus();
    bus.emit({ type: 'action_selected', summary: 'TURN_LEFT', timestamp: 1.5 });
    const parsed = JSON.parse(bus.serialize());
    expect(parsed[0].type).toBe('action_selected');
    expect(parsed[0].timestamp).toBe(1.5);
    expect(parsed[0].provenance).toBe('simulated');
  });

  it('filters by type', () => {
    const bus = new AgentEventBus();
    bus.emit({ type: 'movement', summary: 'a', timestamp: 0 });
    bus.emit({ type: 'action_selected', summary: 'b', timestamp: 1 });
    expect(bus.byType('action_selected').map((e) => e.summary)).toEqual(['b']);
  });
});

/* -------------------------------------------------------------------------- */
/* Capability gateway                                                         */
/* -------------------------------------------------------------------------- */

describe('capability gateway', () => {
  function gateway() {
    const bus = new AgentEventBus();
    const gw = new CapabilityGateway(bus);
    gw.register(SANDBOX_ECHO_CAPABILITY, SANDBOX_ECHO_EXECUTOR, 'observe');
    return { gw, bus };
  }

  it('denies an unregistered capability', async () => {
    const { gw } = gateway();
    const result = await gw.request(
      { capabilityId: 'web.search', action: 'query', arguments: { q: 'x' }, reason: 'curious' },
      0,
    );
    expect(result.status).toBe('denied');
    expect(result.reason).toMatch(/Unknown capability/);
  });

  it('denies everything in OBSERVE mode, which is what this build ships', async () => {
    const { gw } = gateway();
    const result = await gw.request(
      { capabilityId: 'sandbox.echo', action: 'echo', arguments: { a: 1 }, reason: 'test' },
      0,
    );
    expect(result.status).toBe('denied');
    expect(result.reason).toMatch(/OBSERVE/);
  });

  it('does not execute an unapproved request', async () => {
    const { gw, bus } = gateway();
    await gw.request(
      { capabilityId: 'sandbox.echo', action: 'echo', arguments: {}, reason: 'test' },
      0,
    );
    expect(bus.byType('external_action_executed')).toHaveLength(0);
  });

  it('executes only once explicitly raised to sandbox', async () => {
    const { gw } = gateway();
    gw.setMode('sandbox.echo', 'sandbox');
    const result = await gw.request(
      { capabilityId: 'sandbox.echo', action: 'echo', arguments: { hello: 1 }, reason: 'test' },
      0,
    );
    expect(result.status).toBe('executed');
    expect(result.result).toEqual({ echoed: { hello: 1 } });
  });

  it('never lets a capability exceed its own ceiling', () => {
    const { gw } = gateway();
    gw.setMode('sandbox.echo', 'autonomous');
    // SANDBOX_ECHO_CAPABILITY declares maxMode 'sandbox'.
    expect(gw.list()[0].mode).toBe('sandbox');
  });

  it('refuses arguments containing credential-shaped fields', async () => {
    const { gw } = gateway();
    gw.setMode('sandbox.echo', 'sandbox');
    const result = await gw.request(
      {
        capabilityId: 'sandbox.echo',
        action: 'echo',
        arguments: { nested: { apiKey: 'abc123' } },
        reason: 'test',
      },
      0,
    );
    expect(result.status).toBe('denied');
    expect(result.reason).toMatch(/credential-shaped/);
  });

  it('detects secret-shaped fields at depth', () => {
    expect(containsSecretLikeField({ a: { b: { token: 'x' } } })).toBe(true);
    expect(containsSecretLikeField({ a: [{ password: 1 }] })).toBe(true);
    expect(containsSecretLikeField({ a: 1, b: 'plain' })).toBe(false);
  });

  it('enforces a per-capability rate limit', async () => {
    const { gw } = gateway();
    gw.setMode('sandbox.echo', 'sandbox');
    for (let i = 0; i < SANDBOX_ECHO_CAPABILITY.rateLimitPerMinute; i++) {
      await gw.request(
        { capabilityId: 'sandbox.echo', action: 'echo', arguments: {}, reason: 'test' },
        1,
      );
    }
    const result = await gw.request(
      { capabilityId: 'sandbox.echo', action: 'echo', arguments: {}, reason: 'test' },
      1,
    );
    expect(result.status).toBe('rate-limited');
  });

  it('audits every request, including denials', async () => {
    const { gw, bus } = gateway();
    await gw.request(
      { capabilityId: 'web.search', action: 'query', arguments: {}, reason: 'curious' },
      0,
    );
    expect(bus.byType('external_action_requested')).toHaveLength(1);
    expect(bus.byType('external_action_denied')).toHaveLength(1);
  });

  it('registers none of the planned high-reach capabilities', () => {
    const { gw } = gateway();
    const registered = gw.list().map((c) => c.definition.id);
    for (const planned of PLANNED_CAPABILITIES) {
      expect(registered).not.toContain(planned.id);
    }
    expect(registered).toEqual(['sandbox.echo']);
  });
});
