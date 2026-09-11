import { SeededRandom } from '@/core/random';
import {
  INITIAL_AGENT_STATE,
  type ActionProposal,
  type AgentState,
  type BehaviorController,
  type ControllerContext,
  type ControllerOutput,
  type Drive,
  type MotorCommand,
  type SensoryFrame,
  type SelectedAction,
} from './types';

/**
 * Baseline locomotion controller.
 *
 * PROVENANCE: SIMULATED. CONNECTOME COUPLING: OFF.
 *
 * This does NOT use Fish1 and makes no claim to. It exists to prove the
 * embodiment loop actually closes — sensors in, action out, body moves, world
 * changes, sensors see the difference — so that a `NeuralBehaviorController`
 * can later replace it at exactly this seam.
 *
 * It is deliberately simple and deliberately not psychological:
 *   - spontaneous bouts at a rate modulated by arousal
 *   - turn away from a wall that is close
 *   - turn away from a rapidly looming object
 *   - otherwise drift forward and glide
 *
 * Every decision is emitted as a scored proposal so the action log can show
 * what was considered and why the winner won.
 */

/** Mean interval between spontaneous bouts at rest, seconds. */
const BASE_BOUT_INTERVAL = 1.15;
/** Distance at which a wall starts to matter, millimetres. */
const WALL_ATTENTION_MM = 5.5;
/**
 * Loom rate above which the controller treats an object as threatening, rad/s.
 *
 * Set high deliberately. Swimming toward a stationary object also makes it
 * expand, so a low threshold makes the animal startle at its own approach and
 * then swim faster, which raises the loom rate further - a runaway loop. Real
 * escape systems respond to FAST approach, and they have a refractory period.
 */
const LOOM_THRESHOLD = 2.5;
/** An object must also subtend at least this angle before it can trigger escape. */
const LOOM_MIN_ANGULAR_SIZE = 0.3;
/** Minimum interval between escapes, seconds. */
const STARTLE_REFRACTORY = 3.0;

export class BaselineLocomotionController implements BehaviorController {
  readonly id = 'baseline-locomotion-v1';
  readonly label = 'Procedural larval locomotion';
  readonly provenance = 'simulated' as const;
  readonly connectomeCoupled = false;

  private random = new SeededRandom(1);
  private agent: AgentState = { ...INITIAL_AGENT_STATE };
  private nextBoutAt = 0;
  private elapsed = 0;
  private lastStartleAt = -Infinity;
  private proposalCounter = 0;

  reset(seed: number): void {
    this.random.reset(seed);
    this.agent = { ...INITIAL_AGENT_STATE };
    this.elapsed = 0;
    this.nextBoutAt = this.random.range(0.3, BASE_BOUT_INTERVAL);
    this.proposalCounter = 0;
    this.lastStartleAt = -Infinity;
  }

  step(dt: number, sensory: SensoryFrame, context: ControllerContext): ControllerOutput {
    this.elapsed += dt;

    const agent = this.updateAgentState(dt, sensory);
    const drives = this.computeDrives(sensory, agent);
    const proposals = this.propose(sensory, agent, drives);

    // Highest utility wins. Deterministic given identical inputs, which is what
    // makes controller behaviour reproducible from a seed.
    let winner: ActionProposal | null = null;
    for (const p of proposals) {
      if (!winner || p.utility > winner.utility) winner = p;
    }

    const selected: SelectedAction | null = winner
      ? {
          ...winner,
          selectedAt: sensory.time,
          alternatives: proposals.filter((p) => p.id !== winner.id),
        }
      : null;

    const motor = this.toMotorCommand(selected, sensory, agent);
    if (selected?.action === 'ESCAPE') this.lastStartleAt = sensory.time;

    // A bout was committed, so schedule the next spontaneous one.
    if (motor.forwardDrive > 0.12 || Math.abs(motor.turnDrive) > 0.22) {
      const interval = BASE_BOUT_INTERVAL * (1.35 - agent.arousal);
      this.nextBoutAt = this.elapsed + Math.max(this.random.gaussian() * 0.25 + interval, 0.18);
    }

    this.agent = agent;
    return { motor, agent, drives, selected, proposals };
  }

  /* ------------------------------------------------------------------ state */

  private updateAgentState(dt: number, sensory: SensoryFrame): AgentState {
    const a = this.agent;

    // Threat tracks the loom cue with fast attack and slow decay, which is how
    // an escape system has to behave to be useful at all. Gated on the object
    // being large enough to matter, so the animal does not react to distant
    // specks or to its own approach.
    const loom =
      sensory.visual.targetAngularSize >= LOOM_MIN_ANGULAR_SIZE
        ? Math.max(sensory.visual.targetLoomRate, 0)
        : 0;
    const threatTarget = Math.min(loom / LOOM_THRESHOLD, 1);
    const threat =
      threatTarget > a.threatEstimate
        ? threatTarget
        : a.threatEstimate + (threatTarget - a.threatEstimate) * Math.min(dt * 2.5, 1);

    // Swimming costs energy; gliding recovers it.
    const exertion = sensory.internal.speed * 0.02;
    const energy = Math.min(Math.max(a.energy - exertion * dt + 0.015 * dt, 0), 1);

    // Arousal rises with threat and falls toward a low baseline.
    const arousalTarget = Math.min(0.3 + threat * 0.65, 1);
    const arousal = a.arousal + (arousalTarget - a.arousal) * Math.min(dt * 1.2, 1);

    // Novelty decays while nothing changes; a moving target refreshes it.
    const novelty = Math.min(
      Math.max(a.novelty - 0.05 * dt + Math.abs(sensory.visual.targetLoomRate) * 0.1 * dt, 0),
      1,
    );

    const explorationDrive = Math.min(
      Math.max(energy * 0.6 + novelty * 0.4 - threat * 0.5, 0),
      1,
    );

    return { energy, novelty, arousal, threatEstimate: threat, explorationDrive };
  }

  private computeDrives(sensory: SensoryFrame, agent: AgentState): Drive[] {
    const wall = sensory.contact.nearestBoundaryDistance;
    const wallProximity = Math.min(Math.max(1 - wall / WALL_ATTENTION_MM, 0), 1);

    return [
      {
        id: 'explore',
        value: agent.explorationDrive,
        source: 'simulated',
        inputs: ['agent.energy', 'agent.novelty', 'agent.threatEstimate'],
      },
      {
        id: 'avoid-threat',
        value: agent.threatEstimate,
        source: 'simulated',
        inputs: ['visual.targetLoomRate'],
      },
      {
        id: 'avoid-boundary',
        value: wallProximity,
        source: 'simulated',
        inputs: ['contact.nearestBoundaryDistance'],
      },
      {
        id: 'rest',
        value: Math.min(Math.max(1 - agent.energy, 0), 1),
        source: 'simulated',
        inputs: ['agent.energy'],
      },
    ];
  }

  /* -------------------------------------------------------------- proposals */

  private propose(
    sensory: SensoryFrame,
    agent: AgentState,
    drives: readonly Drive[],
  ): ActionProposal[] {
    const time = sensory.time;
    const proposals: ActionProposal[] = [];
    const driveValue = (id: Drive['id']) => drives.find((d) => d.id === id)?.value ?? 0;

    const add = (
      action: ActionProposal['action'],
      utility: number,
      reason: string,
      source: string,
    ) => {
      proposals.push({
        id: `p${++this.proposalCounter}`,
        action,
        utility,
        reason,
        source,
        time,
      });
    };

    // Gliding is always on the table; it is what the animal does by default.
    add('GLIDE', 0.12, 'no competing demand', 'baseline');

    const wallDrive = driveValue('avoid-boundary');
    if (wallDrive > 0.05) {
      const bearing = sensory.contact.nearestBoundaryBearing;
      // Turn away from the wall: if it is to the left, turn right.
      const away = bearing > 0 ? 'TURN_RIGHT' : 'TURN_LEFT';
      add(
        away,
        0.35 + wallDrive * 0.6,
        `wall ${sensory.contact.nearestBoundaryDistance.toFixed(1)} mm away`,
        'boundary avoidance',
      );
    }

    const threat = driveValue('avoid-threat');
    const refractory = time - this.lastStartleAt < STARTLE_REFRACTORY;
    if (threat > 0.6 && !refractory) {
      const bearing = sensory.visual.targetBearing ?? 0;
      add(
        'ESCAPE',
        0.8 + threat * 0.5,
        `looming object, rate ${sensory.visual.targetLoomRate.toFixed(2)} rad/s`,
        'looming response',
      );
      add(
        bearing > 0 ? 'TURN_RIGHT' : 'TURN_LEFT',
        0.6 + threat * 0.3,
        'turning away from an approaching object',
        'looming response',
      );
    } else if (threat > 0.3) {
      const bearing = sensory.visual.targetBearing ?? 0;
      add(
        bearing > 0 ? 'TURN_RIGHT' : 'TURN_LEFT',
        0.45 + threat * 0.3,
        refractory ? 'avoiding object (escape refractory)' : 'avoiding an approaching object',
        'looming response',
      );
    }

    // Spontaneous bouts: the dominant behaviour of an undisturbed larva.
    if (this.elapsed >= this.nextBoutAt) {
      const turnBias = this.random.gaussian() * 0.5;
      if (Math.abs(turnBias) > 0.45) {
        add(
          turnBias > 0 ? 'TURN_RIGHT' : 'TURN_LEFT',
          0.4 + agent.explorationDrive * 0.3,
          'spontaneous turn bout',
          'spontaneous locomotion',
        );
      } else {
        add(
          'SWIM_FORWARD',
          0.4 + agent.explorationDrive * 0.35,
          'spontaneous forward bout',
          'spontaneous locomotion',
        );
      }
    }

    return proposals;
  }

  private toMotorCommand(
    selected: SelectedAction | null,
    sensory: SensoryFrame,
    agent: AgentState,
  ): MotorCommand {
    const base = {
      time: sensory.time,
      provenance: 'simulated' as const,
    };
    if (!selected) return { ...base, forwardDrive: 0, turnDrive: 0, startleDrive: 0 };

    const vigour = 0.45 + agent.arousal * 0.45;

    switch (selected.action) {
      case 'SWIM_FORWARD':
        return { ...base, forwardDrive: vigour, turnDrive: 0, startleDrive: 0 };
      case 'TURN_LEFT':
        return { ...base, forwardDrive: vigour * 0.7, turnDrive: -vigour, startleDrive: 0 };
      case 'TURN_RIGHT':
        return { ...base, forwardDrive: vigour * 0.7, turnDrive: vigour, startleDrive: 0 };
      case 'ESCAPE': {
        // Escape away from the stimulus.
        const bearing = sensory.visual.targetBearing ?? 0;
        return {
          ...base,
          forwardDrive: 1,
          turnDrive: bearing > 0 ? 1 : -1,
          startleDrive: 1,
        };
      }
      case 'STOP':
        return { ...base, forwardDrive: 0, turnDrive: 0, startleDrive: 0 };
      case 'GLIDE':
      default:
        return { ...base, forwardDrive: 0, turnDrive: 0, startleDrive: 0 };
    }
  }
}
