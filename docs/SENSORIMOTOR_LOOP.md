# The sensorimotor loop

How a moving pattern in a simulated tank becomes a turn of a simulated body, and
back again.

```
WORLD          moving coherent-dot pattern
  |
  v
ENCODER        finite-dot sampling -> VisualMotionEvidence        SIMULATED SENSOR
  |
  v
INTERFACE      evidence -> NeuralSensoryInput (left/right drive)  MODELED INTERFACE
  |
  v
NETWORK        traced input layer -> Class I recurrent integration MEASURED CONNECTIVITY
  |                                                                SIMULATED ACTIVITY
  v
READOUT        mean rate of measured SPN_turning, left vs right
  |
  v
INTENT         threshold crossing -> NeuralMotorIntent
  |
  v
BRIDGE         intent -> MotorCommand                              THE ONLY CROSSING
  |
  v
BODY           existing Phase 2 rig and physics                    PROCEDURAL
  |
  v
WORLD          heading changes -> retinal motion changes
```

Each arrow is a separate, testable stage. `tests/sensorimotor.test.ts` pins
every one of them, and several tests would fail if any stage were bypassed.

---

## 1. World → sensor

`src/embodiment/visual-motion.ts`

A coherent-motion stimulus: `dots` dots, a fraction `coherence` of which move
together while the rest move randomly.

**This is not a retina.** There are no photoreceptors, no receptive fields and
no direction-selective cells, and nothing in the application describes it as
retinal processing.

### Where the randomness lives

In a motion-coherence task, trial-to-trial variability comes from the *stimulus*
— a finite dot population, sampled. So the encoder resamples its finite dot set
on every update and counts the net direction, rather than handing the network a
clean number and adding fake noise afterwards. That is why the psychometric
function is graded rather than a step, and it is the scientifically correct place
for the noise to originate.

Output:

```ts
interface VisualMotionEvidence {
  time, leftwardEvidence, rightwardEvidence,
  coherence, angularVelocity,
  provenance: 'simulated'
}
```

### Open versus closed loop

| Mode | Retinal motion |
|---|---|
| **OPEN** | the stimulus alone; the animal cannot affect what it sees |
| **CLOSED** | `stimulus - own yaw rate` |

Closed loop is the negative feedback that makes the loop a loop: turning toward
the pattern reduces the evidence driving the turn. Without it the fish would
spin indefinitely. A test asserts that yawing at exactly the pattern speed
cancels the retinal motion in closed loop and does nothing in open loop.

---

## 2. Sensor → neural model

`evidenceToNeuralInput()` is a named function rather than inline plumbing
because it makes a scientific claim: **which side of the brain receives which
evidence.**

The released reconstruction contains **no identified pretectal or tectal visual
input neurons**, so there is no measured retina-to-hindbrain mapping available
and inventing one is exactly the fabrication this project refuses.

What the release *does* contain is a traced input layer: cells whose
`network_level` includes an `input_one` label, found by tracing presynaptic
partners of the seed cells. Those 76 cells make **100 measured contacts onto
Class I**. Driving them is therefore an injection into a structurally identified
input layer — but the claim stops there.

**Stated convention:** rightward visual motion drives the right-hemisphere input
layer. Combined with the measured ipsilateral organisation (Class I → same-side
spinal projection neurons), that produces a turn toward the motion, which is the
optomotor response. The actual pretectal→hindbrain wiring is not in this
reconstruction, so **the side assignment is a convention, not a measurement**,
and the UI says so under "Sensory interface is modeled".

---

## 3. Model → motor intent

See [NEURAL_RUNTIME.md](./NEURAL_RUNTIME.md). The decision variable is the
difference between the mean simulated rate of the measured `SPN_turning`
population on each side. Crossing threshold emits:

```ts
interface NeuralMotorIntent {
  time, source: 'connectome', action: 'turn_left' | 'turn_right' | 'none',
  confidence, evidence, circuit: 'Fish1 HMI'
}
```

**This is motor INTENT, not motor execution.** The word is chosen deliberately.

---

## 4. Motor intent → body

`src/embodiment/neural-controller.ts`, in `toMotorCommand()`. This is the only
place a neural quantity becomes a body command. The neural runtime never touches
the rig, the physics, or a vertex.

| Channel | Source |
|---|---|
| `turnDrive` | the intent's direction, scaled by confidence, held for 0.25 s |
| `forwardDrive` | **the simulated rate of the measured `SPN_forward` population** |
| `startleDrive` | always 0 |

Both motor channels come out of the circuit. Forward drive is read from the
measured forward spinal projection population rather than being a constant,
which is why the fish stops swimming when the stimulus stops.

`startleDrive` stays zero because the Mauthner/escape system is a different
circuit and is not reconstructed here. Repurposing it would be dishonest.

### Why the body is still procedural

Spinal projection neurons are where the reconstruction ends. The spinal pattern
generator and the musculature are not in this dataset, so the Phase 2 physical
model executes the bout. The UI states **MOTOR PLANT: PROCEDURAL** for exactly
this reason.

This is also why the architecture keeps the bridge as a distinct stage: when a
reconstructed spinal circuit becomes available, it replaces the bridge and
nothing above it changes.

---

## 5. Body → world

The Phase 2 body runtime is unchanged. A turn bout starts when `|turnDrive|`
exceeds 0.22, the rig bends, the physics integrates, and the heading changes.
That new heading feeds straight back into the encoder's closed-loop term.

---

## 6. Timing

| Stage | Rate |
|---|---|
| Physics | 120 Hz fixed |
| Behaviour (encoder, controller, bridge) | 15 Hz fixed |
| **Neural model** | **200 Hz fixed** |
| Trace recording | 50 Hz, or the frame rate if lower |
| GPU activity upload | at most once per rendered frame |
| React UI | throttled to 15 Hz |
| Render | rAF |

Every simulation rate is fixed and independent of the frame rate, so a slow
frame changes nothing about the result.

---

## 7. What would break if a stage were faked

This is the property the tests exist to protect. The following all hold, and
none of them could if a hidden path ran from stimulus direction to turn
direction:

- Ablating the **measured** Class I recurrence produces **zero** turn commands,
  at full coherence, in a fully closed loop.
- Silencing the measured `SPN_turning` readout produces **zero** turn commands.
- A 50/50 stimulus produces **zero** turn commands over 4 seconds.
- Silencing one hemisphere abolishes decisions **in one direction only**.
- Switching to the baseline controller sets `connectomeCoupled` to false, read
  from runtime state rather than from a UI flag.

---

## 8. Provenance summary

| Quantity | Class |
|---|---|
| Neuron position | MEASURED |
| Connectivity | MEASURED |
| E/I identity | MEASURED where labelled, otherwise unknown |
| Functional class | PREDICTED from morphology |
| Hemisphere | DERIVED from the fitted midline |
| Opposite hemisphere cells | DERIVED (mirrored) |
| Crossed inhibition | INFERRED (population-level, ablatable) |
| Sensory interface | INFERRED (stated convention) |
| Neural activity | **SIMULATED** |
| Visual input | **SIMULATED** |
| Body movement | **SIMULATED** |
