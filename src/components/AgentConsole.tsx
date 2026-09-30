'use client';

import type { Draft } from '@/agent/capabilities';
import type { AgentActivity, AgentStep } from '@/agent/agent';
import type { PendingApproval } from '@/embodiment/capabilities';
import { PERMISSION_MODES } from '@/embodiment/capabilities';
import { InfoNotice } from './Badges';

/**
 * What the agent is doing, while it does it.
 *
 * The console is the whole point of giving an agent any capability at all: an
 * action nobody can see is an action nobody can refuse. Every turn it takes
 * appears here, with the capability it went through and what the gateway said.
 */

const ACTIVITY_LABEL: Record<AgentActivity, string> = {
  idle: 'IDLE',
  observing: 'OBSERVING',
  writing: 'WRITING',
  'awaiting-approval': 'AWAITING APPROVAL',
  stopped: 'STOPPED',
};

function StatusBadge({ status }: { status?: string }) {
  if (!status) return null;
  const tone =
    status === 'executed'
      ? 'badge--real'
      : status === 'denied' || status === 'failed' || status === 'rate-limited'
        ? 'badge--warn'
        : '';
  return <span className={`badge ${tone}`}>{status.toUpperCase()}</span>;
}

export function AgentConsole({
  running,
  activity,
  steps,
  pending,
  drafts,
  capabilities,
  onStart,
  onStop,
  onApprove,
  onDeny,
  onCompose,
}: {
  running: boolean;
  activity: AgentActivity;
  steps: readonly AgentStep[];
  pending: readonly PendingApproval[];
  drafts: readonly Draft[];
  capabilities: readonly { id: string; name: string; mode: string; risk: string }[];
  onStart: () => void;
  onStop: () => void;
  onApprove: (requestId: string) => void;
  onDeny: (requestId: string) => void;
  onCompose: (platform: string) => void;
}) {
  const published = drafts.filter((d) => d.published);

  return (
    <aside className="panel panel--right agent-console" aria-label="Agent console">
      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Agent</span>
          <span className={`badge ${running ? 'badge--real' : ''}`}>
            {ACTIVITY_LABEL[activity]}
          </span>
        </div>
        <div className="btn-row">
          <button className="btn" onClick={running ? onStop : onStart}>
            {running ? 'STOP AGENT' : 'START AGENT'}
          </button>
          <button className="btn" onClick={() => onCompose('instagram')} disabled={!running}>
            DRAFT A POST
          </button>
        </div>
        <p className="faint" style={{ fontSize: 10.5, margin: '6px 0 0' }}>
          The agent watches the organism run and writes about what it sees. It takes a turn
          every few seconds; everything it does passes through the capability gateway and
          appears below.
        </p>
      </section>

      {/* ------------------------------------------------------- approvals */}
      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">Waiting for you</span>
          <span className={`badge ${pending.length ? 'badge--warn' : ''}`}>
            {pending.length}
          </span>
        </div>
        {pending.length === 0 ? (
          <p className="faint" style={{ fontSize: 11 }}>
            Nothing is waiting. Anything the agent wants to publish appears here first.
          </p>
        ) : (
          pending.map((entry) => (
            <div key={entry.request.id} className="projection">
              <div className="projection__head">
                <span>{entry.definition.name}</span>
                <span className="badge badge--warn">{entry.definition.risk.toUpperCase()}</span>
              </div>
              <p className="faint" style={{ fontSize: 10.5, margin: '4px 0' }}>
                {entry.preview}
              </p>
              <p className="faint" style={{ fontSize: 10, margin: '2px 0 6px' }}>
                Reason given: {entry.request.reason}
              </p>
              <div className="btn-row">
                <button className="btn" onClick={() => onApprove(entry.request.id)}>
                  APPROVE
                </button>
                <button className="btn" onClick={() => onDeny(entry.request.id)}>
                  DENY
                </button>
              </div>
            </div>
          ))
        )}
      </section>

      {/* ------------------------------------------------------- activity */}
      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">What it is doing</span>
          <span className="faint num">{steps.length}</span>
        </div>
        <ol className="agent-log">
          {steps.slice(0, 24).map((step) => (
            <li key={step.id}>
              <div className="agent-log__head">
                <span className="agent-log__activity">{ACTIVITY_LABEL[step.activity]}</span>
                <StatusBadge status={step.status} />
              </div>
              <div className="agent-log__summary">{step.summary}</div>
              {step.capabilityId ? (
                <div className="agent-log__meta">
                  via <span className="mono">{step.capabilityId}</span>
                  {step.detail ? ` — ${step.detail}` : ''}
                </div>
              ) : null}
            </li>
          ))}
          {steps.length === 0 ? (
            <li>
              <div className="agent-log__summary faint">
                The agent has not taken a turn yet.
              </div>
            </li>
          ) : null}
        </ol>
      </section>

      {/* --------------------------------------------------------- output */}
      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">What it wrote</span>
          <span className="faint num">
            {published.length} / {drafts.length}
          </span>
        </div>
        {drafts.length === 0 ? (
          <p className="faint" style={{ fontSize: 11 }}>
            No drafts yet.
          </p>
        ) : (
          drafts.slice(0, 6).map((draft) => (
            <div key={draft.id} className="projection">
              <div className="projection__head">
                <span>{draft.title}</span>
                <span className={`badge ${draft.published ? 'badge--real' : ''}`}>
                  {draft.published ? 'PUBLISHED' : draft.kind.toUpperCase()}
                </span>
              </div>
              <pre className="agent-draft">{draft.body}</pre>
              {draft.platform ? (
                <p className="faint" style={{ fontSize: 10, margin: '4px 0 0' }}>
                  Written for {draft.platform}. This application cannot post it; copy it out and
                  post it yourself if you want it published there.
                </p>
              ) : null}
            </div>
          ))
        )}
      </section>

      {/* --------------------------------------------------- capabilities */}
      <section className="panel-section">
        <div className="panel-section__head">
          <span className="label">What it can do</span>
          <span className="badge">{capabilities.length} REGISTERED</span>
        </div>
        <dl className="kv" style={{ gridTemplateColumns: '120px 1fr' }}>
          {capabilities.map((capability) => (
            <ProvenanceRow key={capability.id} capability={capability} />
          ))}
        </dl>
        <InfoNotice title="What it cannot do">
          There is no network access, no filesystem access, no shell and no credential anywhere
          in this agent. It cannot post to any platform: no code in this application can. It
          composes text and queues it, and a person publishes it from their own account.
          Automated posting would breach platform terms, require handing over real credentials,
          and act on real people under your name — queueing gets the same work done and leaves
          the accountable act with you.
        </InfoNotice>
        <p className="faint" style={{ fontSize: 10.5, margin: '6px 0 0' }}>
          Permission modes:{' '}
          {Object.values(PERMISSION_MODES)
            .map((m) => m.label)
            .join(' · ')}
          . Anything that changes what the site says is capped at APPROVAL and cannot be
          promoted.
        </p>
      </section>
    </aside>
  );
}

function ProvenanceRow({
  capability,
}: {
  capability: { id: string; name: string; mode: string; risk: string };
}) {
  return (
    <>
      <dt className="mono">{capability.id}</dt>
      <dd>
        {capability.name}{' '}
        <span className="faint">
          · {capability.mode.toUpperCase()} · risk {capability.risk}
        </span>
      </dd>
    </>
  );
}
