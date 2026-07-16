import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Milestone, Timeline } from '../types';
import Icon from '../components/Icon';
import useWorkspaceStore from '../store/useWorkspaceStore';
import { apiGetTimelines } from '../api/client';

interface MoveMilestoneModalProps {
  milestone: Milestone;
  currentTimelineId: string;
  onPick: (targetTimelineId: string) => void;
  onClose: () => void;
}

/** Picker for "Move to another timeline" — spans every workspace the user
 *  belongs to, grouped by workspace, mirroring MoveTaskModal's list picker. */
export default function MoveMilestoneModal({ milestone, currentTimelineId, onPick, onClose }: MoveMilestoneModalProps) {
  const { workspaces } = useWorkspaceStore();
  const [timelines, setTimelines] = useState<Timeline[] | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    apiGetTimelines().then(res => setTimelines(res.timelines)).catch(() => setTimelines([]));
  }, []);

  const workspaceName = useCallback((id?: string) => workspaces.find(w => w.id === id)?.name ?? 'Other', [workspaces]);

  const filtered = useMemo(() => {
    if (!timelines) return [];
    const q = query.trim().toLowerCase();
    return timelines
      .filter(t => t.id !== currentTimelineId)
      .filter(t => !q || t.name.toLowerCase().includes(q))
      .sort((a, b) => workspaceName(a.workspaceId).localeCompare(workspaceName(b.workspaceId)) || a.name.localeCompare(b.name));
  }, [timelines, query, currentTimelineId, workspaceName]);

  const grouped = useMemo(() => {
    const groups = new Map<string, Timeline[]>();
    for (const t of filtered) {
      const key = workspaceName(t.workspaceId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(t);
    }
    return Array.from(groups.entries());
  }, [filtered, workspaceName]);

  return createPortal(
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.24)', backdropFilter: 'blur(5px)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'backdropIn 220ms ease both' }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--color-white)', borderRadius: 18, maxWidth: 420, width: '100%', maxHeight: '78vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 40px rgba(var(--color-primary-rgb), 0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '20px 22px 4px' }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="drive_file_move" size={19} color="var(--color-primary)" />
          </div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>Move to another timeline</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{milestone.title}</div>
          </div>
        </div>

        <div style={{ padding: '14px 22px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 10, padding: '9px 12px' }}>
            <Icon name="search" size={15} color="var(--color-text-quaternary)" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search timelines…"
              style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)' }}
            />
          </div>
        </div>

        <div style={{ padding: '12px 22px 0', overflowY: 'auto', flex: 1 }}>
          {timelines === null && (
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)', padding: '12px 2px' }}>Loading timelines…</div>
          )}
          {timelines !== null && filtered.length === 0 && (
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)', padding: '12px 2px' }}>No matching timelines.</div>
          )}

          {grouped.map(([wsName, wsTimelines]) => (
            <div key={wsName} style={{ marginBottom: 14 }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-text-quaternary)', marginBottom: 6, paddingLeft: 2 }}>{wsName}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {wsTimelines.map(t => (
                  <button
                    key={t.id}
                    onClick={() => { onPick(t.id); onClose(); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 12px', borderRadius: 10, border: '1.5px solid var(--color-border)', background: 'var(--color-white)', cursor: 'pointer', textAlign: 'left' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-tint)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'var(--color-white)')}>
                    <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 15 }}>
                      {t.emoji ?? <Icon name="timeline" size={15} color={t.color ?? 'var(--color-primary)'} />}
                    </div>
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '14px 22px 20px' }}>
          <button
            onClick={onClose}
            style={{ padding: '9px 18px', borderRadius: 10, border: '1.5px solid var(--color-border)', background: 'var(--color-white)', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
