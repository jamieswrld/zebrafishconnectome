# Agent architecture

How the organism decides what to do, how that is recorded, and the boundary
through which it could one day act outside its tank.

---

## 1. Four separate layers

Conflating these would turn the project into a scientific mess, so they are kept
apart by construction:

| Layer | What it is | Provenance | Status |
|---|---|---|---|
| **Biological data** | Fish1 soma, synapses, molecular identity | `measured` | Real, shipping |
| **Neural model** | Prediction/simulation derived from that data | `predicted` / `simulated` | Types only |
| **Behaviour policy** | Sensory + neural state → physical actions | `simulated` | Baseline controller |
| **Digital-agent policy** | Higher-level state → external capability requests | `simulated` | Gateway only, nothing registered |

A sentence produced by a future language model is **agent policy**, never
"neural activity", and never a decoded Fish1 thought.

---

## 2. Agent state — simulation variables

```ts
interface AgentState {
  energy; novelty; arousal; threatEstimate; explorationDrive;  // all 0..1
}
```

**These are not measurements and not emotions.** `threatEstimate: 0.8` means a
scalar in this control system is 0.8. It describes the program, not an animal.
The UI shows them under `AGENT STATE — SIMULATED`, and a test asserts the
inferred-state vocabulary contains no emotion words.

---

## 3. Drives

```ts
interface Drive { id; value; source; inputs: string[] }
```

Each drive records **which sensory or state fields produced it**, so a reader can
trace a number back to its cause rather than trusting a bar chart. Current
drives: `explore`, `avoid-threat`, `avoid-boundary`, `rest`.

Labelled `DRIVES` in the UI — never "what the fish is thinking".

---

## 4. Action selection

Every behaviour step produces scored **proposals**, and the highest utility
wins:

```ts
interface ActionProposal { id; action; utility; reason; source; time }
interface SelectedAction extends ActionProposal { selectedAt; alternatives }
```

`alternatives` retains the losing proposals, so a decision can be audited after
the fact: what was considered, what scored what, and why the winner won.
Selection is deterministic given identical inputs, which is what makes
controller behaviour reproducible from a seed.

Actions are physical: `SWIM_FORWARD`, `TURN_LEFT`, `TURN_RIGHT`, `GLIDE`,
`STOP`, `ORIENT_TO_TARGET`, `AVOID_TARGET`, `ESCAPE`.

---

## 5. Event log — the black-box recorder

An append-only `AgentEventBus` records `sensory_input`, `state_changed`,
`action_proposed`, `action_selected`, `motor_command`, `movement`,
`boundary_contact`, and every stage of an external capability request.

- Fixed-capacity ring buffer: an hours-long run must not grow without bound.
- A throwing subscriber cannot break the simulation loop.
- `serialize()` emits stable field order so a recorded run can be diffed
  between builds.
- Repeated identical decisions are not re-logged, or the feed becomes thousands
  of identical `GLIDE` lines and stops being readable.

Transparency here is a **product feature**, not a debugging aid. It is what will
make eventual autonomy inspectable rather than mysterious.

---

## 6. Capability gateway — external agency

### Nothing in this build grants external access.

There is no network client, no shell, no filesystem access, and no credentials
anywhere in this subsystem. What exists is the architecture that would make
external agency governable *if* it were ever enabled:

```
POLICY → CapabilityRequest → GATEWAY (permission, rate limit, audit)
       → server-side executor → CapabilityResult
```

### Three rules enforced structurally

1. **Allowlist only.** The policy can request only explicitly registered
   capabilities. An unknown id is denied. There is no global "allow everything"
   switch.
2. **Per-capability permissions.** Raising one capability says nothing about any
   other, and no capability can exceed its own declared `maxMode` ceiling —
   asking for `autonomous` on a `sandbox`-ceilinged capability silently clamps.
3. **Secrets never cross the boundary.** `containsSecretLikeField()` recursively
   rejects payloads containing `token`, `secret`, `password`, `api_key`,
   `authorization`, `cookie` or `credential`. The fish never holds an API key;
   credentials stay server-side.

### Permission modes

| Mode | Meaning |
|---|---|
| `OBSERVE` | No external actions. Requests are logged and denied. **This build.** |
| `SANDBOX` | Only against isolated simulated services. |
| `APPROVAL` | The organism proposes; a human approves each action. |
| `AUTONOMOUS` | Allowlisted low-risk capabilities run unattended. |

### What is registered

Exactly one capability: `sandbox.echo`. It returns its own arguments and
performs **no I/O of any kind**. It exists so the gateway, permission model,
audit trail and tests operate on something real while the application ships with
genuinely zero external reach. It is in `OBSERVE` mode by default, so even that
is denied.

### What is designed for but deliberately NOT registered

`web.search`, `feed.post`, `experiment.run` — listed in `PLANNED_CAPABILITIES`
so the UI can show what the architecture anticipates while being unambiguous
that none of it is reachable. A test asserts none of them are registered.

---

## 7. Memory — interfaces only

`AgentMemory` (`episodic` / `spatial` / `associative` / `preference`) carries
`salience`, `source` provenance and a creation time. Nothing writes or reads
memories yet.

Deliberately unimplemented: a vector database is a large commitment, and there
is nothing worth retrieving until the organism has experiences worth recalling.
The interfaces exist so persistence and learning have a defined seam rather than
being retrofitted onto an ad-hoc blob.

`OrganismIdentity` is architected for persistence across sessions (age, actions
taken, distance travelled). **It is not populated with invented numbers.**
Counters must only ever reflect simulation that actually ran.

---

## 8. Future: a deliberative model

If a language model is ever used for high-level policy:

```
biological state + simulated drives + observations + episodic memory
        ↓
   high-level policy        ← labelled AGENT POLICY
        ↓
   action proposal          ← goes through the same selection and audit path
```

Its outputs are `AGENT POLICY`. They are not neural activity, not a decoded
connectome state, and not evidence of anything the animal experiences. It would
propose actions through the same `ActionProposal` interface and be subject to
the same capability gateway as everything else.

---

## 9. The line that does not move

The project's credibility rests on never writing fiction into the UI. Permitted
language: `SIMULATED DRIVE`, `INFERRED RESPONSE`, `AGENT POLICY`,
`ACTION SELECTED`, `MODEL OUTPUT`.

Never: "the fish is scared", "Fish1 is conscious", "we decoded its thoughts",
"the connectome wants X".
