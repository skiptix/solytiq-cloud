import { useEffect, useState } from 'react';
import Icon from './Icon';
import useAgentStore from '../store/useAgentStore';
import type { AgentRun, AgentRunStep } from '../types';
import { motion, useReducedMotion } from './animate-ui/motion';

const STATUS_COLOR: Record<string, string> = {
  running: 'var(--color-primary)', success: 'var(--color-success)', failed: 'var(--color-error)',
  blocked: 'var(--color-warning-alt, #d97706)', cancelled: 'var(--color-text-quaternary)',
};
const STEP_STATUS_ICON: Record<AgentRunStep['status'], string> = {
  ok: 'check_circle', error: 'error', proposed: 'pending', denied: 'block',
};
const STEP_STATUS_COLOR: Record<AgentRunStep['status'], string> = {
  ok: 'var(--color-success)', error: 'var(--color-error)', proposed: 'var(--color-warning-alt, #d97706)', denied: 'var(--color-text-quaternary)',
};

/** Pending-approval inbox + recent run trace for one workspace's AI agent — embedded in the
 *  Dashboard's right column (and reusable anywhere else that's workspace-scoped). Renders
 *  nothing at all once loaded if the agent has never had any activity in this workspace. */
export default function AgentInbox({ workspaceId }: { workspaceId: string }) {
  const proposals = useAgentStore((s) => s.proposals);
  const runs = useAgentStore((s) => s.runs);
  const loaded = useAgentStore((s) => s.loaded);
  const load = useAgentStore((s) => s.load);
  const loadProposals = useAgentStore((s) => s.loadProposals);
  const acceptProposal = useAgentStore((s) => s.acceptProposal);
  const rejectProposal = useAgentStore((s) => s.rejectProposal);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  useEffect(() => {
    load(workspaceId);
    loadProposals(workspaceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  if (loaded && proposals.length === 0 && runs.length === 0) return null;

  const handleAccept = async (id: string) => {
    setBusyId(id);
    try { await acceptProposal(id); } finally { setBusyId(null); }
  };
  const handleReject = async (id: string) => {
    setBusyId(id);
    try { await rejectProposal(id); } finally { setBusyId(null); }
  };

  const recentRuns = runs.slice(0, 5);

  return (
    <div style={{
      background: 'var(--color-surface-gray, #f9fafb)', borderRadius: 16, border: '1px solid var(--color-border)',
      padding: 14, display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name="smart_toy" size={16} color="var(--color-primary)" />
        <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13 }}>Agent</span>
        {proposals.length > 0 && (
          <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-heading)', fontSize: 10.5, fontWeight: 700, color: 'var(--color-white)', background: 'var(--color-primary)', borderRadius: 9999, padding: '2px 7px' }}>
            {proposals.length} pending
          </span>
        )}
      </div>

      {proposals.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {proposals.map((p) => (
            <div key={p.id} style={{ background: 'var(--color-white)', borderRadius: 10, border: '1px solid var(--color-border)', padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-primary)' }}>
                Wants to run <code style={{ background: 'var(--color-surface-tint-2)', borderRadius: 4, padding: '1px 5px' }}>{p.toolName}</code>
              </div>
              {p.rationale && <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>{p.rationale}</div>}
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => handleAccept(p.id)}
                  disabled={busyId === p.id}
                  style={{ flex: 1, padding: '5px 0', borderRadius: 7, border: 'none', background: 'var(--color-success)', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 600, cursor: busyId === p.id ? 'default' : 'pointer', opacity: busyId === p.id ? 0.6 : 1 }}
                >
                  Accept
                </button>
                <button
                  onClick={() => handleReject(p.id)}
                  disabled={busyId === p.id}
                  style={{ flex: 1, padding: '5px 0', borderRadius: 7, border: '1px solid var(--color-border)', background: 'var(--color-white)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 600, cursor: busyId === p.id ? 'default' : 'pointer', opacity: busyId === p.id ? 0.6 : 1 }}
                >
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {recentRuns.length > 0 && (
        <div>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 10.5, fontWeight: 700, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
            Recent runs
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {recentRuns.map((r) => (
              <RunRow key={r.id} run={r} expanded={expandedRun === r.id} onToggle={() => setExpandedRun((id) => (id === r.id ? null : r.id))} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<AgentRun['status'], string> = {
  running: 'In progress', success: 'Completed', failed: 'Failed', blocked: 'Blocked', cancelled: 'Cancelled',
};

function formatRunTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function RunRow({ run, expanded, onToggle }: { run: AgentRun; expanded: boolean; onToggle: () => void }) {
  const steps = (run.steps ?? []) as AgentRunStep[];
  const running = run.status === 'running';
  const reduceMotion = useReducedMotion();
  return (
    <div style={{ background: 'var(--color-white)', borderRadius: 8, border: '1px solid var(--color-border)', overflow: 'hidden' }}>
      <button
        onClick={onToggle}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left' }}
      >
        <span style={{ position: 'relative', width: 7, height: 7, flexShrink: 0 }}>
          <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: STATUS_COLOR[run.status] ?? 'var(--color-text-quaternary)' }} />
          {running && (
            <motion.span
              animate={reduceMotion ? { opacity: 0.7 } : { opacity: [0.25, 0.9, 0.25], scale: [1, 1.5, 1] }}
              transition={{ duration: 1.2, ease: 'easeInOut', repeat: Infinity }}
              style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: STATUS_COLOR.running }} />
          )}
        </span>
        <span style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {run.goal}
        </span>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-text-quaternary)', flexShrink: 0 }}>{formatRunTime(run.startedAt)}</span>
        <Icon name={expanded ? 'expand_less' : 'expand_more'} size={16} color="var(--color-text-quaternary)" />
      </button>
      {expanded && (
        <div style={{ padding: '4px 9px 8px', display: 'flex', flexDirection: 'column', gap: 5, borderTop: '1px solid var(--color-divider)' }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: STATUS_COLOR[run.status] ?? 'var(--color-text-quaternary)' }}>
            {STATUS_LABEL[run.status] ?? run.status}
          </div>
          {steps.length === 0 && <div style={{ fontSize: 11.5, color: 'var(--color-text-quaternary)', padding: '4px 0' }}>No steps recorded.</div>}
          {steps.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 11.5 }}>
              {s.nodeType === 'tool'
                ? <Icon name={STEP_STATUS_ICON[s.status]} size={13} color={STEP_STATUS_COLOR[s.status]} />
                : <Icon name="flag" size={13} color="var(--color-text-quaternary)" />}
              <span style={{ color: 'var(--color-text-secondary)' }}>
                {s.nodeType === 'trigger' ? 'Started' : s.toolName}
                {s.error ? ` — ${s.error}` : ''}
              </span>
            </div>
          ))}
          {run.error && <div style={{ fontSize: 11.5, color: 'var(--color-error)', marginTop: 2 }}>{run.error}</div>}
        </div>
      )}
    </div>
  );
}
