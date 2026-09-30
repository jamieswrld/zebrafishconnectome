# The site agent

An agent that watches the organism, writes about it, and asks before it changes
anything. And a console that shows you all of it while it happens.

---

## 1. What it is

A small rule-driven observer. Every few seconds it takes a turn:

```
site.read      look at the running organism
site.draft     write a note about what it saw
site.publish   ask a person whether that note should go on the site
```

Plus `social.compose`, which drafts a post for an external platform and puts it
in the workspace.

**There is no language model in the loop.** That is deliberate, not a shortcut.
An LLM writing copy about a scientific simulation would produce fluent sentences
nobody could trace to a number — the one thing this project has spent three
phases refusing to do. Instead the agent assembles its notes from values the run
actually produced, and the console shows those values beside the text.

---

## 2. What it cannot do

No network access. No filesystem access. No shell. No credential of any kind,
anywhere in `src/agent/`.

In particular **it cannot post to any platform, because no code in this
application can.** There is no executor that sends anything anywhere, and no
capability that could acquire one. `social.compose` writes text into a local
workspace; a person copies it out and posts it from their own account.

That is not squeamishness about autonomy. Automated account creation and
unattended posting breach the terms of every major platform, they require
handing an agent real credentials, and they act on real people under the
operator's name. Composing-and-queueing does the same work and leaves the
accountable act with the accountable party.

A test asserts the absence rather than trusting the description:

```ts
expect(gateway.list().some((c) => /post|send/i.test(c.definition.id))).toBe(false);
```

---

## 3. Capabilities

| Capability | Effect | Approval | Ceiling |
|---|---|---|---|
| `site.read` | Reads the running simulation's own state | no | autonomous |
| `site.draft` | Writes a note into the agent's workspace | no | autonomous |
| `site.publish` | **Puts a note on the site** | **yes** | **approval** |
| `social.compose` | Drafts text for a platform, locally | no | autonomous |

Reading and drafting are ungated because they have no external effect. Gating
composition in particular would be security theatre with a real cost: you would
have to approve a draft before you were allowed to read it. The risk that would
justify a gate — actually sending — is not mitigated here, it is **absent**.

`site.publish` is capped at `approval` in its definition, so no configuration
change can promote it to unattended.

Every request passes `containsSecretLikeField`, so a credential-shaped payload
is refused in either direction even though the agent has no secret to leak.

---

## 4. The approval queue

`CapabilityGateway` could already say "this needs approval". The queue is what
makes that answer mean something.

```
request  ->  evaluate  ->  pending-approval  ->  [queue]  ->  approve / deny
```

- `pending()` — what is waiting, with the reason the agent gave
- `approve(id, now)` — the only path from queued to executed
- `deny(id, reason, now)` — records the refusal rather than discarding it

**The agent cannot approve its own request.** It holds no reference to
`approve`, and the queue is keyed by an id the gateway issued. A test asserts
that no such method is reachable from the agent.

---

## 5. The console

Opened from the organism view. Four sections:

**AGENT** — running state, start/stop, and a button to draft a post.

**WAITING FOR YOU** — the approval queue. Each entry shows the capability, its
risk, a preview of what would happen, and the reason the agent gave. APPROVE and
DENY.

**WHAT IT IS DOING** — every turn it has taken, newest first: the activity, the
capability it went through, and what the gateway said. An action nobody can see
is an action nobody can refuse, so this is the point of the whole subsystem.

**WHAT IT WROTE** — the drafts, with published ones marked. Social drafts carry
an explicit note that the application cannot post them.

**WHAT IT CAN DO** — the registered capabilities with their current modes, and a
plain statement of what is absent.

---

## 6. Where it runs

The agent ticks from the render loop but rate-limits itself to one turn every
six seconds — an agent that acted every frame would produce sixty observations a
second and an unreadable log. Its workspace is bounded at 60 drafts and its step
history at 80 entries, so a session left running overnight cannot grow memory.

Everything is in-memory and per-page. Nothing survives a reload, and nothing
leaves the browser.

---

## 7. Tests

`tests/agent.test.ts` (16) and `scripts/smoke-agent.mjs` (16 in a real browser).

The load-bearing ones are negative:

- it queues a publish instead of performing it
- it publishes **only** once a human approves
- it publishes nothing when a human denies
- it cannot approve its own request
- it refuses a capability it was never given
- it refuses any request carrying a credential-shaped field
- no registered capability reaches the network, filesystem or a shell
- it never presents simulated values as measured, or as something the animal
  experienced
