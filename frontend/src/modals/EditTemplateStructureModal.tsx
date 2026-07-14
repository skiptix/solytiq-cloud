import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Template, TemplateListNode, TemplateTimelineNode, TemplateSectionNode, TemplateTaskNode, TemplateMilestoneNode } from '../types';
import { apiGetTemplateStructure, apiUpdateTemplateStructure } from '../api/client';
import useTemplatesStore from '../store/useTemplatesStore';
import Icon from '../components/Icon';
import TimePicker from '../components/TimePicker';

interface EditTemplateStructureModalProps {
  template: Template;
  onClose: () => void;
}

const PRIORITIES = ['High', 'Medium', 'Low'] as const;
const MILESTONE_STATUSES: { value: string; label: string }[] = [
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'in-progress', label: 'In Progress' },
  { value: 'done', label: 'Done' },
];

const iconBtnStyle: React.CSSProperties = {
  width: 24, height: 24, borderRadius: 6, border: 'none', background: 'transparent', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
};

const dashedBtnStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, color: '#5e4dbb',
  background: 'transparent', border: '1px dashed #d8d0eb', borderRadius: 8, padding: '8px 10px', cursor: 'pointer',
};

function DayOffsetField({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <input
        type="number"
        value={value ?? ''}
        placeholder="—"
        onChange={(e) => onChange(e.target.value === '' ? null : Math.round(Number(e.target.value)))}
        style={{ width: 52, fontFamily: 'Inter, sans-serif', fontSize: 12, border: '1.5px solid #E5E7EB', borderRadius: 7, padding: '4px 6px', outline: 'none', textAlign: 'center', color: '#1c1b22' }}
      />
      <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10.5, color: '#b0acbe' }}>days from today</span>
      {value !== null && (
        <button type="button" onClick={() => onChange(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 0 }}>
          <Icon name="close" size={11} color="#b0acbe" />
        </button>
      )}
    </div>
  );
}

function TimeField({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 8px', borderRadius: 7, border: `1px solid ${value ? '#c4b5fd' : '#E5E7EB'}`, background: value ? '#F5F3FF' : '#fff', cursor: 'pointer', fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: value ? '#5e4dbb' : '#b0acbe' }}>
        <Icon name="schedule" size={12} color={value ? '#5e4dbb' : '#b0acbe'} />
        {value || '--:--'}
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 1200 }}>
          <TimePicker value={value ?? undefined} onChange={(t) => { onChange(t); setOpen(false); }} onClear={() => { onChange(null); setOpen(false); }} />
        </div>
      )}
    </div>
  );
}

export default function EditTemplateStructureModal({ template, onClose }: EditTemplateStructureModalProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [listNode, setListNode] = useState<TemplateListNode | null>(null);
  const [timelineNode, setTimelineNode] = useState<TemplateTimelineNode | null>(null);

  const load = useTemplatesStore((s) => s.load);

  useEffect(() => {
    apiGetTemplateStructure(template.id)
      .then((r) => {
        if (r.type === 'list') setListNode(r.structure as TemplateListNode);
        else setTimelineNode(r.structure as TemplateTimelineNode);
      })
      .catch(() => setError('Failed to load this template’s structure.'))
      .finally(() => setLoading(false));
  }, [template.id]);

  // ── List mutators ──────────────────────────────────────────────
  const updateSection = (si: number, patch: Partial<TemplateSectionNode>) => {
    setListNode((n) => {
      if (!n) return n;
      const sections = n.sections.slice();
      sections[si] = { ...sections[si], ...patch };
      return { ...n, sections };
    });
  };
  const removeSection = (si: number) => setListNode((n) => (n ? { ...n, sections: n.sections.filter((_, i) => i !== si) } : n));
  const moveSection = (si: number, dir: -1 | 1) => {
    setListNode((n) => {
      if (!n) return n;
      const sections = n.sections.slice();
      const target = si + dir;
      if (target < 0 || target >= sections.length) return n;
      [sections[si], sections[target]] = [sections[target], sections[si]];
      return { ...n, sections };
    });
  };
  const addSection = () => {
    setListNode((n) => (n ? { ...n, sections: [...n.sections, { label: 'New Section', emoji: null, position: n.sections.length, tasks: [] }] } : n));
  };

  const updateTask = (si: number, ti: number, patch: Partial<TemplateTaskNode>) => {
    setListNode((n) => {
      if (!n) return n;
      const sections = n.sections.slice();
      const tasks = sections[si].tasks.slice();
      tasks[ti] = { ...tasks[ti], ...patch };
      sections[si] = { ...sections[si], tasks };
      return { ...n, sections };
    });
  };
  const removeTask = (si: number, ti: number) => {
    setListNode((n) => {
      if (!n) return n;
      const sections = n.sections.slice();
      sections[si] = { ...sections[si], tasks: sections[si].tasks.filter((_, i) => i !== ti) };
      return { ...n, sections };
    });
  };
  const moveTask = (si: number, ti: number, dir: -1 | 1) => {
    setListNode((n) => {
      if (!n) return n;
      const sections = n.sections.slice();
      const tasks = sections[si].tasks.slice();
      const target = ti + dir;
      if (target < 0 || target >= tasks.length) return n;
      [tasks[ti], tasks[target]] = [tasks[target], tasks[ti]];
      sections[si] = { ...sections[si], tasks };
      return { ...n, sections };
    });
  };
  const addTask = (si: number) => {
    setListNode((n) => {
      if (!n) return n;
      const sections = n.sections.slice();
      const tasks = sections[si].tasks.slice();
      tasks.push({ title: '', note: null, priority: null, badge: null, position: tasks.length, deadlineOffsetDays: null, timeVal: null, attachments: [] });
      sections[si] = { ...sections[si], tasks };
      return { ...n, sections };
    });
  };

  // ── Timeline mutators ──────────────────────────────────────────
  const updateMilestone = (mi: number, patch: Partial<TemplateMilestoneNode>) => {
    setTimelineNode((n) => {
      if (!n) return n;
      const milestones = n.milestones.slice();
      milestones[mi] = { ...milestones[mi], ...patch };
      return { ...n, milestones };
    });
  };
  const removeMilestone = (mi: number) => setTimelineNode((n) => (n ? { ...n, milestones: n.milestones.filter((_, i) => i !== mi) } : n));
  const moveMilestone = (mi: number, dir: -1 | 1) => {
    setTimelineNode((n) => {
      if (!n) return n;
      const milestones = n.milestones.slice();
      const target = mi + dir;
      if (target < 0 || target >= milestones.length) return n;
      [milestones[mi], milestones[target]] = [milestones[target], milestones[mi]];
      return { ...n, milestones };
    });
  };
  const addMilestone = () => {
    setTimelineNode((n) => (n ? { ...n, milestones: [...n.milestones, { title: '', description: null, status: 'upcoming', emoji: null, color: null, position: n.milestones.length, dateOffsetDays: null, timeVal: null, attachments: [] }] } : n));
  };

  const listValid = listNode ? listNode.sections.every((s) => s.label.trim() && s.tasks.every((t) => t.title.trim())) : false;
  const timelineValid = timelineNode ? timelineNode.milestones.every((m) => m.title.trim()) : false;
  const canSave = !loading && !saving && (template.type === 'list' ? listValid : timelineValid);

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError('');
    try {
      const structure = template.type === 'list' ? listNode! : timelineNode!;
      await apiUpdateTemplateStructure(template.id, structure);
      await load();
      onClose();
    } catch {
      setError('Failed to save changes. Please try again.');
      setSaving(false);
    }
  };

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)', backdropFilter: 'blur(5px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)', animation: 'backdropIn 180ms ease both' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 640, maxHeight: '86vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(0,0,0,0.18)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 24px', borderBottom: '1px solid #f1ecf6', flexShrink: 0 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: template.colorBg ?? '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 17 }}>
            {template.emoji ?? (template.type === 'list' ? '📋' : '🗓️')}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Edit Structure — {template.name}</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#787584', marginTop: 1 }}>
              Dates are relative offsets, resolved against "today" whenever this template is used.
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 2, flexShrink: 0 }}>
            <Icon name="close" size={18} color="#787584" />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
          {loading ? (
            <div style={{ padding: '40px 0', textAlign: 'center', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>Loading structure…</div>
          ) : !listNode && !timelineNode ? (
            <div style={{ padding: '40px 0', textAlign: 'center', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#ba1a1a' }}>{error || 'Could not load this template.'}</div>
          ) : listNode ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {listNode.sections.map((section, si) => (
                <div key={si} style={{ background: '#faf9ff', border: '1px solid #ece8f4', borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input value={section.label} onChange={(e) => updateSection(si, { label: e.target.value })} placeholder="Section name *"
                      style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', border: 'none', borderBottom: '1.5px solid #e8e4f0', padding: '4px 0', outline: 'none', background: 'transparent', color: '#1c1b22' }} />
                    <button onClick={() => moveSection(si, -1)} disabled={si === 0} style={iconBtnStyle}><Icon name="arrow_upward" size={14} color={si === 0 ? '#d8d2e8' : '#787584'} /></button>
                    <button onClick={() => moveSection(si, 1)} disabled={si === listNode.sections.length - 1} style={iconBtnStyle}><Icon name="arrow_downward" size={14} color={si === listNode.sections.length - 1 ? '#d8d2e8' : '#787584'} /></button>
                    <button onClick={() => removeSection(si)} style={iconBtnStyle}><Icon name="delete" size={14} color="#ba1a1a" /></button>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {section.tasks.map((task, ti) => (
                      <div key={ti} style={{ background: '#fff', border: '1px solid #e8e4f0', borderRadius: 9, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <input value={task.title} onChange={(e) => updateTask(si, ti, { title: e.target.value })} placeholder="Task title *"
                            style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 13, border: 'none', outline: 'none', background: 'transparent', color: '#1c1b22', minWidth: 0 }} />
                          {task.sublist && (
                            <span title="This task's nested sublist carries over unchanged" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#9d8dff', background: '#F5F3FF', borderRadius: 6, padding: '2px 6px', flexShrink: 0, whiteSpace: 'nowrap' }}>
                              <Icon name="subdirectory_arrow_right" size={11} color="#9d8dff" /> sublist
                            </span>
                          )}
                          {task.attachments.length > 0 && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#787584', flexShrink: 0 }}>
                              <Icon name="attach_file" size={11} color="#787584" /> {task.attachments.length}
                            </span>
                          )}
                          <button onClick={() => moveTask(si, ti, -1)} disabled={ti === 0} style={iconBtnStyle}><Icon name="arrow_upward" size={12} color={ti === 0 ? '#d8d2e8' : '#787584'} /></button>
                          <button onClick={() => moveTask(si, ti, 1)} disabled={ti === section.tasks.length - 1} style={iconBtnStyle}><Icon name="arrow_downward" size={12} color={ti === section.tasks.length - 1 ? '#d8d2e8' : '#787584'} /></button>
                          <button onClick={() => removeTask(si, ti)} style={iconBtnStyle}><Icon name="close" size={13} color="#ba1a1a" /></button>
                        </div>
                        <textarea value={task.note ?? ''} onChange={(e) => updateTask(si, ti, { note: e.target.value || null })} placeholder="Note (optional)" rows={1}
                          style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, border: '1px solid #f0ecf8', borderRadius: 7, padding: '5px 8px', outline: 'none', resize: 'vertical', color: '#484552', background: '#fafafa' }} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <select value={task.priority ?? ''} onChange={(e) => updateTask(si, ti, { priority: e.target.value || null })}
                            style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, border: '1.5px solid #E5E7EB', borderRadius: 7, padding: '4px 6px', background: '#fff', color: '#484552' }}>
                            <option value="">No priority</option>
                            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                          </select>
                          <DayOffsetField value={task.deadlineOffsetDays} onChange={(v) => updateTask(si, ti, { deadlineOffsetDays: v })} />
                          <TimeField value={task.timeVal} onChange={(v) => updateTask(si, ti, { timeVal: v })} />
                        </div>
                      </div>
                    ))}
                    <button onClick={() => addTask(si)} style={dashedBtnStyle}><Icon name="add" size={13} color="#5e4dbb" /> Add task</button>
                  </div>
                </div>
              ))}
              <button onClick={addSection} style={dashedBtnStyle}><Icon name="add" size={14} color="#5e4dbb" /> Add section</button>
            </div>
          ) : timelineNode ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {timelineNode.milestones.map((m, mi) => (
                <div key={mi} style={{ background: '#fff', border: '1px solid #e8e4f0', borderRadius: 11, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input value={m.title} onChange={(e) => updateMilestone(mi, { title: e.target.value })} placeholder="Milestone title *"
                      style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 600, border: 'none', outline: 'none', background: 'transparent', color: '#1c1b22', minWidth: 0 }} />
                    {m.attachments.length > 0 && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: 'Inter, sans-serif', fontSize: 10, color: '#787584', flexShrink: 0 }}>
                        <Icon name="attach_file" size={11} color="#787584" /> {m.attachments.length}
                      </span>
                    )}
                    <button onClick={() => moveMilestone(mi, -1)} disabled={mi === 0} style={iconBtnStyle}><Icon name="arrow_upward" size={13} color={mi === 0 ? '#d8d2e8' : '#787584'} /></button>
                    <button onClick={() => moveMilestone(mi, 1)} disabled={mi === timelineNode.milestones.length - 1} style={iconBtnStyle}><Icon name="arrow_downward" size={13} color={mi === timelineNode.milestones.length - 1 ? '#d8d2e8' : '#787584'} /></button>
                    <button onClick={() => removeMilestone(mi)} style={iconBtnStyle}><Icon name="delete" size={13} color="#ba1a1a" /></button>
                  </div>
                  <textarea value={m.description ?? ''} onChange={(e) => updateMilestone(mi, { description: e.target.value || null })} placeholder="Description (optional)" rows={1}
                    style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, border: '1px solid #f0ecf8', borderRadius: 7, padding: '5px 8px', outline: 'none', resize: 'vertical', color: '#484552', background: '#fafafa' }} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <select value={m.status} onChange={(e) => updateMilestone(mi, { status: e.target.value })}
                      style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, border: '1.5px solid #E5E7EB', borderRadius: 7, padding: '4px 6px', background: '#fff', color: '#484552' }}>
                      {MILESTONE_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                    <DayOffsetField value={m.dateOffsetDays} onChange={(v) => updateMilestone(mi, { dateOffsetDays: v })} />
                    <TimeField value={m.timeVal} onChange={(v) => updateMilestone(mi, { timeVal: v })} />
                  </div>
                </div>
              ))}
              <button onClick={addMilestone} style={dashedBtnStyle}><Icon name="add" size={14} color="#5e4dbb" /> Add milestone</button>
            </div>
          ) : null}
        </div>

        {error && (listNode || timelineNode) && (
          <div style={{ margin: '0 24px 8px', padding: '8px 12px', background: '#ffdad6', borderRadius: 8, fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a', flexShrink: 0 }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 10, padding: '14px 24px', borderTop: '1px solid #f1ecf6', justifyContent: 'flex-end', flexShrink: 0 }}>
          <button onClick={onClose} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: 'none', cursor: 'pointer', padding: '10px 16px' }}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={!canSave}
            style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: canSave ? '#5e4dbb' : '#c9c4d5', border: 'none', borderRadius: 8, padding: '10px 24px', cursor: canSave ? 'pointer' : 'not-allowed', transition: 'background 150ms' }}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
