import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Task, List } from '../types';
import Icon from '../components/Icon';
import useAppStore from '../store/useAppStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import { apiGetLists } from '../api/client';
import ModalIn from '../components/animate-ui/ModalIn';

interface MoveTaskModalProps {
  task: Task;
  onClose: () => void;
}

/** Picker for "Move to another board" — spans every workspace the user belongs
 *  to (a task can move across workspaces), grouped by workspace so a large
 *  board directory stays navigable. */
export default function MoveTaskModal({ task, onClose }: MoveTaskModalProps) {
  const { moveTaskToList, moveTaskToDashboard } = useAppStore();
  const { workspaces } = useWorkspaceStore();
  const [lists, setLists] = useState<List[] | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    apiGetLists().then(res => setLists(res.lists)).catch(() => setLists([]));
  }, []);

  const workspaceName = useCallback((id?: string) => workspaces.find(w => w.id === id)?.name ?? 'Other', [workspaces]);

  const filtered = useMemo(() => {
    if (!lists) return [];
    const q = query.trim().toLowerCase();
    return lists
      .filter(l => l.id !== task._listId && l.parentTaskId !== task.id)
      .filter(l => !q || l.name.toLowerCase().includes(q))
      .sort((a, b) => workspaceName(a.workspaceId).localeCompare(workspaceName(b.workspaceId)) || a.name.localeCompare(b.name));
  }, [lists, query, task._listId, task.id, workspaceName]);

  const grouped = useMemo(() => {
    const groups = new Map<string, List[]>();
    for (const l of filtered) {
      const key = workspaceName(l.workspaceId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(l);
    }
    return Array.from(groups.entries());
  }, [filtered, workspaceName]);

  const pick = (listId: string) => {
    moveTaskToList(task.id, listId);
    onClose();
  };

  return createPortal(
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.24)', backdropFilter: 'blur(5px)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'backdropIn 220ms ease both' }}>
      <ModalIn
        duration={280}
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--color-white)', borderRadius: 18, maxWidth: 420, width: '100%', maxHeight: '78vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 40px rgba(var(--color-primary-rgb), 0.18)', overflow: 'hidden' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '20px 22px 4px' }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="drive_file_move" size={19} color="var(--color-primary)" />
          </div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>Move to another board</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</div>
          </div>
        </div>

        <div style={{ padding: '14px 22px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 10, padding: '9px 12px' }}>
            <Icon name="search" size={15} color="var(--color-text-quaternary)" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search boards…"
              style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)' }}
            />
          </div>
        </div>

        <div style={{ padding: '12px 22px 0', overflowY: 'auto', flex: 1 }}>
          {task._source === 'list' && (
            <button
              onClick={() => { moveTaskToDashboard(task.id); onClose(); }}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 12px', borderRadius: 10, border: '1.5px solid var(--color-border)', background: 'var(--color-white)', cursor: 'pointer', textAlign: 'left', marginBottom: 10 }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Icon name="today" size={15} color="var(--color-primary)" />
              </div>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>Move to Dashboard</div>
            </button>
          )}

          {lists === null && (
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)', padding: '12px 2px' }}>Loading boards…</div>
          )}
          {lists !== null && filtered.length === 0 && (
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)', padding: '12px 2px' }}>No matching boards.</div>
          )}

          {grouped.map(([wsName, wsLists]) => (
            <div key={wsName} style={{ marginBottom: 14 }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-text-quaternary)', marginBottom: 6, paddingLeft: 2 }}>{wsName}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {wsLists.map(l => (
                  <button
                    key={l.id}
                    onClick={() => pick(l.id)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 12px', borderRadius: 10, border: '1.5px solid var(--color-border)', background: 'var(--color-white)', cursor: 'pointer', textAlign: 'left' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-tint)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'var(--color-white)')}>
                    <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 15 }}>
                      {l.emoji ?? <Icon name="format_list_bulleted" size={15} color={l.color ?? 'var(--color-primary)'} />}
                    </div>
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</div>
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
      </ModalIn>
    </div>,
    document.body
  );
}
