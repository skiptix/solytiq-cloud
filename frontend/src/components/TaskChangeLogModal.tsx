import { createPortal } from 'react-dom';
import type { Task, TaskChangeLogEntry } from '../types';
import Icon from './Icon';

interface TaskChangeLogModalProps {
  task: Task;
  entries: TaskChangeLogEntry[];
  onClose: () => void;
}

const FIELD_META: Record<TaskChangeLogEntry['field'], { label: string; icon: string }> = {
  title:    { label: 'Title',    icon: 'edit' },
  note:     { label: 'Note',     icon: 'description' },
  deadline: { label: 'Deadline', icon: 'calendar_today' },
  priority: { label: 'Priority', icon: 'priority_high' },
  badge:    { label: 'Badge',    icon: 'label' },
  section:  { label: 'Section',  icon: 'view_column' },
};

function formatFieldValue(field: TaskChangeLogEntry['field'], value: string | null): string {
  if (!value) return field === 'deadline' ? 'No deadline' : 'None';
  if (field === 'deadline') {
    const [y, m, d] = value.slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return value;
}

function friendlyTime(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function exactTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  return `${hh}:${mi} - ${dd}.${mo}.${d.getFullYear()}`;
}

export default function TaskChangeLogModal({ task, entries, onClose }: TaskChangeLogModalProps) {
  const sorted = [...entries].sort((a, b) => new Date(b.changedAt).getTime() - new Date(a.changedAt).getTime());

  return createPortal(
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        style={{ background: 'var(--color-white)', borderRadius: 16, width: '100%', maxWidth: 520, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px', borderBottom: '1px solid var(--color-surface-tint-2)', flexShrink: 0 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="history" size={18} color="var(--color-primary)" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>Change history</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</div>
          </div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: 'var(--color-surface-tint)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="close" size={16} color="var(--color-text-tertiary)" />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 20px 20px' }}>
          {sorted.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '40px 20px', color: 'var(--color-text-quaternary)' }}>
              <Icon name="history" size={32} color="var(--color-purple-tint-3)" />
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-tertiary)', textAlign: 'center' }}>
                No tracked changes yet
              </div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', textAlign: 'center' }}>
                Edits to the title, note, deadline, priority, badge, or section will show up here.
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {sorted.map((entry, i) => {
                const meta = FIELD_META[entry.field];
                return (
                  <div key={entry.id} style={{ display: 'flex', gap: 12, padding: '12px 0', borderBottom: i < sorted.length - 1 ? '1px solid var(--color-surface-tint-2)' : 'none' }}>
                    <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Icon name={meta.icon} size={14} color="var(--color-primary)" />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)' }}>
                        {meta.label} changed
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, fontFamily: 'var(--font-body)', fontSize: 12.5, flexWrap: 'wrap' }}>
                        <span style={{ color: 'var(--color-text-tertiary)', textDecoration: 'line-through' }}>{formatFieldValue(entry.field, entry.oldValue)}</span>
                        <Icon name="arrow_forward" size={12} color="var(--color-text-quaternary)" />
                        <span style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{formatFieldValue(entry.field, entry.newValue)}</span>
                      </div>
                      <div style={{ marginTop: 4, fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)' }} title={exactTime(entry.changedAt)}>
                        {entry.actorType === 'automation' ? `Automation: ${entry.actorName ?? 'Unknown'}` : (entry.actorName ?? 'Someone')} · {friendlyTime(entry.changedAt)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
