import { usePageTitle } from "../hooks/usePageTitle";
import { useState, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Milestone, MilestoneStatus, TimelineLayout, MilestoneAttachment, SharedFile } from '../types';
import useAppStore from '../store/useAppStore';
import useAuthStore from '../store/useAuthStore';
import useUserPrefsStore from '../store/useUserPrefsStore';
import { todayInTz, minutesSinceMidnightInTz } from '../utils/date';
import { milestoneCompletion, railFillIndex } from '../utils/timeline';
import {
  apiCreateMilestone, apiUpdateMilestone, apiDeleteMilestone,
  apiGetMilestoneAttachments, apiUploadMilestoneAttachment, apiLinkMilestoneAttachment,
  apiDeleteMilestoneAttachment, apiDownloadMilestoneAttachment,
} from '../api/client';
import { genId } from '../utils/id';
import Icon from '../components/Icon';
import EmojiSelector from '../components/EmojiSelector';
import CalendarPicker from '../components/CalendarPicker';
import CreatorBubble from '../components/CreatorBubble';
import { FilePicker, AttachBadge } from '../components/TaskDialog';
import { DeleteConfirmModal } from '../components/TaskItem';
import useMembersStore from '../store/useMembersStore';

function fmtAttSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

const STATUSES: Array<{ key: MilestoneStatus; label: string; color: string; icon: string }> = [
  { key: 'upcoming', label: 'Upcoming', color: '#9d8dff', icon: 'schedule' },
  { key: 'in-progress', label: 'In progress', color: '#ea580c', icon: 'pending' },
  { key: 'done', label: 'Done', color: '#10B981', icon: 'check_circle' },
];

const MILESTONE_COLORS = ['#5e4dbb', '#1D4ED8', '#10B981', '#ea580c', '#f59e0b', '#ba1a1a', '#db2777', '#0d9488'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function statusOf(key: MilestoneStatus) {
  return STATUSES.find(s => s.key === key) ?? STATUSES[0];
}

function fmtDate(date?: string | null) {
  if (!date) return null;
  const parts = date.split('-');
  if (parts.length !== 3) return date;
  const [y, m, d] = parts.map(Number);
  if (!m || !d) return date;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

// Chronological order; undated milestones fall to the bottom by position.
function sortMilestones(ms: Milestone[]): Milestone[] {
  return [...ms].sort((a, b) => {
    if (a.date && b.date) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    } else if (a.date) return -1;
    else if (b.date) return 1;
    return (a.position ?? 0) - (b.position ?? 0);
  });
}

// Properties-panel row — mirrors TaskDialog's PropRow so the milestone dialog
// reads like the item dialog.
function PropRow({ icon, label, children, last = false, first = false }: { icon: string; label: string; children: ReactNode; last?: boolean; first?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px', borderBottom: last ? 'none' : '1px solid rgba(229,231,235,0.5)', borderRadius: first ? '11px 11px 0 0' : last ? '0 0 11px 11px' : 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: 130, flexShrink: 0 }}>
        <Icon name={icon} size={14} color="#b9b3cb" />
        <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584' }}>{label}</span>
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
        {children}
      </div>
    </div>
  );
}

// ── Milestone editor (add / edit) ─────────────────────────────────────────────
interface MilestoneEditorProps {
  accent: string;
  initial?: Milestone;
  onSave: (data: Partial<Milestone>) => void;
  onDelete?: () => void;
  onClose: () => void;
  /** Set to the timeline owner's id when the timeline is public — shows an Owner row. */
  ownerId?: string;
}
function MilestoneEditor({ accent, initial, onSave, onDelete, onClose, ownerId }: MilestoneEditorProps) {
  const owner = useMembersStore(s => (ownerId ? s.members[ownerId] : undefined));
  const [title, setTitle] = useState(initial?.title ?? '');
  const [date, setDate] = useState(initial?.date ?? '');
  const [time, setTime] = useState(initial?.time ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [status, setStatus] = useState<MilestoneStatus>(initial?.status ?? 'upcoming');
  const [emoji, setEmoji] = useState(initial?.emoji ?? '📍');
  const [color, setColor] = useState<string | null>(initial?.color ?? null);
  const [dateError, setDateError] = useState(false);
  const [showCal, setShowCal] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const calRef = useRef<HTMLDivElement>(null);
  const effectiveAccent = color ?? statusOf(status).color;

  // Attachments (edit mode only — a milestone must exist before files attach to it)
  const milestoneId = initial?.id;
  const [attachments, setAttachments] = useState<MilestoneAttachment[]>([]);
  const [attachLoading, setAttachLoading] = useState(Boolean(milestoneId));
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [removingAttId, setRemovingAttId] = useState<string | null>(null);
  const [downloadingAttId, setDownloadingAttId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Close calendar on outside click
  useEffect(() => {
    if (!showCal) return;
    const handler = (e: MouseEvent) => {
      if (calRef.current && !calRef.current.contains(e.target as Node)) setShowCal(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showCal]);

  useEffect(() => {
    if (!milestoneId) return;
    let active = true;
    apiGetMilestoneAttachments(milestoneId)
      .then(r => { if (active) setAttachments(r.attachments); })
      .catch(() => { /* silent */ })
      .finally(() => { if (active) setAttachLoading(false); });
    return () => { active = false; };
  }, [milestoneId]);

  const handleFileUpload = async (file: File) => {
    if (!milestoneId) return;
    setUploadProgress(0);
    try {
      const att = await apiUploadMilestoneAttachment(milestoneId, file, pct => setUploadProgress(pct));
      setAttachments(prev => [...prev, att]);
    } catch { /* silent */ } finally { setUploadProgress(null); }
  };

  const handleLinkFile = async (sf: SharedFile) => {
    if (!milestoneId) return;
    try {
      const r = await apiLinkMilestoneAttachment(milestoneId, sf.id);
      setAttachments(prev => [...prev, r.attachment]);
    } catch { /* silent */ } finally { setShowFilePicker(false); }
  };

  const handleRemoveAttachment = async (att: MilestoneAttachment) => {
    if (!milestoneId) return;
    setRemovingAttId(att.id);
    try {
      await apiDeleteMilestoneAttachment(milestoneId, att.id);
      setAttachments(prev => prev.filter(a => a.id !== att.id));
    } catch { /* silent */ } finally { setRemovingAttId(null); }
  };

  const handleDownloadAttachment = async (att: MilestoneAttachment) => {
    if (!milestoneId) return;
    setDownloadingAttId(att.id);
    try {
      await apiDownloadMilestoneAttachment(milestoneId, att.id, att.name);
    } catch { /* silent */ } finally { setDownloadingAttId(null); }
  };

  const save = () => {
    if (!title.trim()) return;
    if (!date) { setDateError(true); return; }
    onSave({
      title: title.trim(),
      date: date,
      time: time || null,
      description: description.trim() || null,
      status,
      emoji: emoji || null,
      color: color ?? null,
    });
  };

  return (
    <>
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)', backdropFilter: 'blur(6px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 20px', animation: 'backdropIn 200ms ease both' }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 18, width: '100%', maxWidth: 800, maxHeight: '92vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 32px 80px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.08)', animation: 'modalIn 260ms cubic-bezier(0.34,1.56,0.64,1) both' }}>

        {/* Accent stripe */}
        <div style={{ height: 3, background: effectiveAccent, flexShrink: 0, transition: 'background 200ms' }} />

        {/* Scrollable body */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '28px 32px 32px' }}>

          {/* Title row */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 26 }}>
            <div style={{ marginTop: 2, flexShrink: 0 }}>
              <EmojiSelector value={emoji} onChange={setEmoji} direction="down" size={40} allowRemove={false} />
            </div>
            <input autoFocus value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} placeholder="Milestone title"
              style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 22, fontWeight: 700, color: '#1c1b22', background: 'transparent', border: 'none', outline: 'none', lineHeight: 1.3, padding: '6px 0', marginTop: 2 }} />
            <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginTop: 4 }}>
              {initial && onDelete && (
                <button onClick={() => setShowDelete(true)} title="Delete milestone"
                  style={{ width: 34, height: 34, borderRadius: 9, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 120ms' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#ffdad6')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <Icon name="delete" size={17} color="#ba1a1a" />
                </button>
              )}
              <button onClick={onClose} title="Close"
                style={{ width: 34, height: 34, borderRadius: 9, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 120ms' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#F5F3FF')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <Icon name="close" size={18} color="#787584" />
              </button>
            </div>
          </div>

          {/* Properties panel */}
          <div style={{ background: '#faf9ff', borderRadius: 12, marginBottom: 28, border: '1px solid #F0EEF8' }}>
            <PropRow icon="calendar_today" label="Date" first>
              <div style={{ position: 'relative' }} ref={calRef}>
                <button type="button" onClick={() => { setShowCal(v => !v); setDateError(false); }}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 10px', borderRadius: 8, border: `1px solid ${dateError ? '#ba1a1a' : showCal ? effectiveAccent : (date ? '#c4b5fd' : 'transparent')}`, background: dateError ? '#fff8f7' : (date ? '#F5F3FF' : 'transparent'), cursor: 'pointer', fontFamily: 'Inter, sans-serif', fontSize: 13, color: date ? '#5e4dbb' : '#c9c4d5', transition: 'all 120ms', textAlign: 'left' }}>
                  <Icon name="calendar_today" size={13} color={date ? effectiveAccent : '#c9c4d5'} />
                  {date ? fmtDate(date) : 'Pick a date…'}
                </button>
                {dateError && <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a', marginLeft: 10 }}>A date is required.</span>}
                {showCal && (
                  <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 50 }}>
                    <CalendarPicker
                      value={date || undefined}
                      onChange={d => { setDate(d); setShowCal(false); setDateError(false); }}
                      onClear={() => { setDate(''); setShowCal(false); }}
                    />
                  </div>
                )}
              </div>
            </PropRow>

            <PropRow icon="schedule" label="Time">
              <input type="time" value={time ?? ''} onChange={e => setTime(e.target.value)}
                style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, border: '1px solid #E5E7EB', borderRadius: 8, padding: '5px 10px', outline: 'none', background: '#fff', color: '#1c1b22' }} />
            </PropRow>

            <PropRow icon="flag" label="Status">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {STATUSES.map(s => {
                  const sel = status === s.key;
                  return (
                    <button key={s.key} onClick={() => setStatus(s.key)}
                      style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 12px', borderRadius: 8, border: `1px solid ${sel ? s.color : '#E5E7EB'}`, background: sel ? `${s.color}18` : 'transparent', cursor: 'pointer', fontFamily: 'Inter, sans-serif', fontSize: 12, fontWeight: 600, color: sel ? s.color : '#787584', transition: 'all 120ms' }}>
                      <Icon name={s.icon} size={13} color={sel ? s.color : '#9d8dff'} />{s.label}
                    </button>
                  );
                })}
              </div>
            </PropRow>

            <PropRow icon="palette" label="Accent" last={!ownerId}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center' }}>
                <button onClick={() => setColor(null)} title="Match status"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 24, padding: '0 10px', borderRadius: 9999, background: color === null ? '#f0edff' : '#fff', border: `1.5px solid ${color === null ? accent : '#e8e4f0'}`, cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: color === null ? accent : '#787584' }}>
                  Auto
                </button>
                {MILESTONE_COLORS.map(c => (
                  <button key={c} onClick={() => setColor(c)} title={c}
                    style={{ width: 24, height: 24, borderRadius: '50%', background: c, border: color === c ? '2.5px solid #1c1b22' : '2px solid transparent', cursor: 'pointer', padding: 0 }} />
                ))}
              </div>
            </PropRow>

            {ownerId && (
              <PropRow icon="account_circle" label="Owner" last>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <CreatorBubble creatorId={ownerId} taskHovered />
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#484552' }}>
                    {owner ? (owner.fullName || owner.username) : 'Unknown'}
                  </span>
                </div>
              </PropRow>
            )}
          </div>

          {/* Notes */}
          <div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 700, color: '#c9c4d5', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Notes</div>
            <textarea value={description ?? ''} onChange={e => setDescription(e.target.value)} placeholder="Add notes, context, or any details…" rows={4}
              style={{ width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#484552', background: 'transparent', border: 'none', outline: 'none', resize: 'vertical', lineHeight: 1.75, padding: 0, minHeight: 90 }} />
          </div>

          {/* Attachments — only once the milestone exists (edit mode) */}
          {milestoneId && (
            <>
              <div style={{ height: 1, background: '#F0EEF8', margin: '24px 0' }} />
              <div>
                <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 700, color: '#c9c4d5', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  Attachments{attachments.length > 0 && <span style={{ fontWeight: 400, color: '#c9c4d5', marginLeft: 6 }}>{attachments.length}</span>}
                </div>

                {attachLoading ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', opacity: 0.5 }}>
                    <div style={{ width: 13, height: 13, border: '2px solid #c9c4d5', borderTopColor: '#5e4dbb', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
                    <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>Loading…</span>
                  </div>
                ) : attachments.map(att => (
                  <div key={att.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 10, background: '#faf9ff', marginBottom: 6, border: '1px solid #F0EEF8' }}>
                    <AttachBadge mime={att.mimeType} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 500, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.name}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 1 }}>
                        <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe' }}>{fmtAttSize(att.size)}</span>
                        {att.attachmentType === 'linked' && (
                          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 10, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', borderRadius: 99, padding: '1px 6px' }}>from Files</span>
                        )}
                      </div>
                    </div>
                    <button onClick={() => handleDownloadAttachment(att)} disabled={downloadingAttId === att.id} title="Download"
                      style={{ width: 28, height: 28, borderRadius: 7, border: 'none', background: 'transparent', cursor: downloadingAttId === att.id ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                      onMouseEnter={e => { if (downloadingAttId !== att.id) e.currentTarget.style.background = '#F5F3FF'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                      {downloadingAttId === att.id
                        ? <div style={{ width: 12, height: 12, border: '2px solid #c4b5fd', borderTopColor: '#5e4dbb', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
                        : <Icon name="download" size={15} color="#5e4dbb" />}
                    </button>
                    <button onClick={() => handleRemoveAttachment(att)} disabled={removingAttId === att.id} title="Remove"
                      style={{ width: 28, height: 28, borderRadius: 7, border: 'none', background: 'transparent', cursor: removingAttId === att.id ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                      onMouseEnter={e => { if (removingAttId !== att.id) e.currentTarget.style.background = '#ffdad6'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                      {removingAttId === att.id
                        ? <div style={{ width: 12, height: 12, border: '2px solid #e87575', borderTopColor: '#ba1a1a', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
                        : <Icon name="close" size={14} color="#ba1a1a" />}
                    </button>
                  </div>
                ))}

                {uploadProgress !== null && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 10, background: '#faf9ff', marginBottom: 6, border: '1px solid #F0EEF8' }}>
                    <div style={{ width: 34, height: 34, borderRadius: 8, background: '#F5F3FF', border: '1px solid #E5E7EB', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <div style={{ width: 14, height: 14, border: '2px solid #c4b5fd', borderTopColor: '#5e4dbb', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#5e4dbb', marginBottom: 4 }}>Uploading… {uploadProgress}%</div>
                      <div style={{ background: '#E5E7EB', borderRadius: 99, height: 3, overflow: 'hidden' }}>
                        <div style={{ width: `${uploadProgress}%`, height: '100%', background: '#5e4dbb', borderRadius: 99, transition: 'width 150ms' }} />
                      </div>
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button onClick={() => fileInputRef.current?.click()} disabled={uploadProgress !== null}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: '1.5px dashed #d1d5db', borderRadius: 9, padding: '7px 14px', cursor: uploadProgress !== null ? 'not-allowed' : 'pointer', fontFamily: 'Inter, sans-serif', fontSize: 12, fontWeight: 600, color: '#787584', transition: 'all 120ms', opacity: uploadProgress !== null ? 0.5 : 1 }}
                    onMouseEnter={e => { if (uploadProgress === null) { e.currentTarget.style.borderColor = '#5e4dbb'; e.currentTarget.style.color = '#5e4dbb'; e.currentTarget.style.background = '#faf9ff'; } }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = '#d1d5db'; e.currentTarget.style.color = '#787584'; e.currentTarget.style.background = 'transparent'; }}>
                    <Icon name="upload" size={14} color="currentColor" />
                    Upload file
                  </button>
                  <button onClick={() => setShowFilePicker(true)}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: '1.5px dashed #d1d5db', borderRadius: 9, padding: '7px 14px', cursor: 'pointer', fontFamily: 'Inter, sans-serif', fontSize: 12, fontWeight: 600, color: '#787584', transition: 'all 120ms' }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = '#5e4dbb'; e.currentTarget.style.color = '#5e4dbb'; e.currentTarget.style.background = '#faf9ff'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = '#d1d5db'; e.currentTarget.style.color = '#787584'; e.currentTarget.style.background = 'transparent'; }}>
                    <Icon name="folder_open" size={14} color="currentColor" />
                    Attach from Files
                  </button>
                </div>

                <input ref={fileInputRef} type="file" style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); e.target.value = ''; }} />
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 32px', borderTop: '1px solid #f1ecf6', flexShrink: 0 }}>
          <button onClick={onClose} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: '1px solid #E5E7EB', borderRadius: 8, padding: '9px 18px', cursor: 'pointer' }}>Cancel</button>
          <button onClick={save} disabled={!title.trim()}
            style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: title.trim() ? effectiveAccent : '#c9c4d5', border: 'none', borderRadius: 8, padding: '9px 22px', cursor: title.trim() ? 'pointer' : 'default' }}>
            {initial ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </div>
    {showFilePicker && <FilePicker onSelect={handleLinkFile} onClose={() => setShowFilePicker(false)} />}
    {showDelete && onDelete && (
      <DeleteConfirmModal
        name={title.trim() || initial?.title || 'this milestone'}
        heading="Delete milestone?"
        description={<>"<span style={{ color: '#1c1b22', fontWeight: 500 }}>{title.trim() || initial?.title}</span>" will be moved to trash.</>}
        onConfirm={() => { setShowDelete(false); onDelete(); }}
        onCancel={() => setShowDelete(false)}
      />
    )}
    </>
  );
}

// ── Timeline screen ────────────────────────────────────────────────────────────
export default function TimelineScreen() {
  const { timelineId } = useParams<{ timelineId: string }>();
  const navigate = useNavigate();
  const { userId: currentUserId } = useAuthStore();
  const { timelines, listsLoading, setTimelines, loadFromApi } = useAppStore();
  const timezone = useUserPrefsStore(s => s.timezone);
  const today = todayInTz(timezone);
  const timeline = timelines.find(t => t.id === timelineId);

  const [editing, setEditing] = useState<Milestone | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Milestone | null>(null);

  // Re-render every minute so intra-day ("hourly") progress keeps advancing
  // without a page reload.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => forceTick(t => t + 1), 60_000);
    return () => clearInterval(interval);
  }, []);

  let pageTitle = 'Loading timeline...';
  if (!timeline && !listsLoading) {
    pageTitle = 'Timeline not found';
  } else if (timeline) {
    const prefix = timeline.emoji ? `${timeline.emoji} ` : '';
    pageTitle = `${prefix}${timeline.name}`;
  }
  usePageTitle(pageTitle);

  if (!timeline) {
    if (listsLoading) {
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 32, height: 32, border: '3px solid #e8e4f0', borderTopColor: '#5e4dbb', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
        </div>
      );
    }
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 18, fontWeight: 700, color: '#1c1b22', marginBottom: 8 }}>Timeline not found</div>
          <button onClick={() => navigate('/dashboard')} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer' }}>Go to Dashboard</button>
        </div>
      </div>
    );
  }

  const accent = timeline.color ?? '#5e4dbb';
  const bg = timeline.colorBg ?? '#F9FAFB';
  const layout: TimelineLayout = timeline.layout ?? 'vertical';
  const isOwner = timeline.userId === currentUserId;
  const milestones = sortMilestones(timeline.milestones);
  const total = milestones.length;

  // Hourly progress: a milestone dated today is not "reached" the instant the day
  // begins — it fills gradually across the day (toward its set time, or end of
  // day) and only counts as complete once that moment passes or it's marked done.
  const nowMinutes = minutesSinceMidnightInTz(timezone);
  const completions = milestones.map(m => milestoneCompletion(m, today, nowMinutes));
  const done = completions.filter(c => c >= 1).length;
  const totalCompletion = completions.reduce((a, c) => a + c, 0);
  const pct = total > 0 ? Math.round((totalCompletion / total) * 100) : 0;

  // Continuous fill position along the rail (fractional → stops mid-segment for
  // a milestone that's partway through today).
  const fillIndex = railFillIndex(completions);
  const fillPct = total > 1 ? Math.max(0, Math.min(1, fillIndex / (total - 1))) * 100 : 0;
  // Whether the leading edge is currently inside a partially-complete segment.
  const railActive = fillIndex > -1 && fillIndex < total - 1 && fillIndex % 1 !== 0;

  // Layout density knobs.
  const gap = layout === 'compact' ? 8 : layout === 'detailed' ? 26 : 16;
  const nodeSize = layout === 'detailed' ? 20 : layout === 'compact' ? 13 : 16;
  const cardPad = layout === 'compact' ? '8px 12px' : layout === 'detailed' ? '16px 18px' : '12px 14px';
  const titleSize = layout === 'detailed' ? 16 : layout === 'compact' ? 13.5 : 14.5;

  const updateStoreMilestones = (fn: (ms: Milestone[]) => Milestone[]) =>
    setTimelines(prev => prev.map(t => (t.id === timeline.id ? { ...t, milestones: fn(t.milestones) } : t)));

  const handleAdd = (data: Partial<Milestone>) => {
    const id = genId('milestone');
    const optimistic: Milestone = {
      id,
      timelineId: timeline.id,
      title: data.title ?? '',
      date: data.date ?? null,
      time: data.time ?? null,
      description: data.description ?? null,
      status: (data.status as MilestoneStatus) ?? 'upcoming',
      emoji: data.emoji ?? null,
      color: data.color ?? null,
      position: timeline.milestones.length,
    };
    updateStoreMilestones(ms => [...ms, optimistic]);
    setAdding(false);
    apiCreateMilestone(timeline.id, { id, title: optimistic.title, date: optimistic.date, time: optimistic.time, description: optimistic.description, status: optimistic.status, emoji: optimistic.emoji, color: optimistic.color })
      .catch(() => loadFromApi());
  };

  const handleSave = (milestoneId: string, data: Partial<Milestone>) => {
    updateStoreMilestones(ms => ms.map(m => (m.id === milestoneId ? { ...m, ...data } : m)));
    setEditing(null);
    apiUpdateMilestone(milestoneId, data).catch(() => loadFromApi());
  };

  const handleDelete = (milestoneId: string) => {
    updateStoreMilestones(ms => ms.filter(m => m.id !== milestoneId));
    apiDeleteMilestone(milestoneId).catch(() => loadFromApi());
  };

  const cycleStatus = (m: Milestone) => {
    if (!isOwner) return;
    const order: MilestoneStatus[] = ['upcoming', 'in-progress', 'done'];
    const next = order[(order.indexOf(m.status) + 1) % order.length];
    handleSave(m.id, { status: next });
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: '#fff' }}>
      {/* Hero */}
      <div style={{ background: bg, borderBottom: '1px solid #f0ecf8', padding: '32px 40px 26px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, maxWidth: 860, margin: '0 auto' }}>
          <div style={{ width: 56, height: 56, borderRadius: 16, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, boxShadow: '0 2px 10px rgba(0,0,0,0.06)', flexShrink: 0 }}>
            {timeline.emoji ?? <Icon name="timeline" size={28} color={accent} />}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h1 style={{ margin: 0, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 26, fontWeight: 800, color: '#1c1b22' }}>{timeline.name}</h1>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: accent, background: '#fff', padding: '3px 9px', borderRadius: 9999, border: `1px solid ${accent}33` }}>
                <Icon name="timeline" size={13} color={accent} /> Timeline
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#787584' }}>
                <Icon name={timeline.isPublic ? 'public' : 'lock'} size={13} color="#787584" />{timeline.isPublic ? 'Public' : 'Private'}
              </span>
            </div>
            {timeline.subtitle && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#787584', marginTop: 4 }}>{timeline.subtitle}</div>}
            {/* Progress */}
            <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1, maxWidth: 320, height: 8, borderRadius: 9999, background: 'rgba(0,0,0,0.07)', overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', borderRadius: 9999, background: accent, transition: 'width 400ms ease' }} />
              </div>
              <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, color: '#484552' }}>{done}/{total} done · {pct}%</span>
            </div>
          </div>
          {isOwner && (
            <button onClick={() => setAdding(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 10, border: 'none', background: accent, color: '#fff', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', flexShrink: 0, boxShadow: `0 4px 14px ${accent}40` }}>
              <Icon name="add" size={17} color="#fff" /> Milestone
            </button>
          )}
        </div>
      </div>

      {/* Timeline body */}
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '28px 40px 80px' }}>
        {total === 0 ? (
          <div style={{ textAlign: 'center', padding: '56px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 64, height: 64, borderRadius: 18, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="timeline" size={32} color={accent} />
            </div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 18, fontWeight: 700, color: '#1c1b22' }}>No milestones yet</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13.5, color: '#787584', maxWidth: 300, lineHeight: 1.6 }}>
              {isOwner ? 'Add your first milestone to start building this timeline.' : 'This timeline has no milestones yet.'}
            </div>
            {isOwner && (
              <button onClick={() => setAdding(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 20px', borderRadius: 10, border: 'none', background: accent, color: '#fff', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                <Icon name="add" size={17} color="#fff" /> Add Milestone
              </button>
            )}
          </div>
        ) : (
          <div style={{ position: 'relative', paddingLeft: 8 }}>
            {/* Vertical rail — grey background track */}
            <div style={{ position: 'absolute', left: 8 + nodeSize / 2 - 1, top: nodeSize / 2, bottom: nodeSize / 2, width: 2, background: '#e8e4f0', borderRadius: 2 }} />
            {/* Accent progress fill — grows toward the leading milestone, partially
                into the segment of the one that's still in progress today. */}
            {fillIndex > -1 && (
              <div className={railActive ? 'timeline-rail-flow' : undefined} style={{
                position: 'absolute',
                left: 8 + nodeSize / 2 - 1,
                top: nodeSize / 2,
                height: `${fillPct}%`,
                width: 2,
                borderRadius: 2,
                zIndex: 0,
                backgroundColor: accent,
                backgroundImage: railActive ? 'linear-gradient(180deg, transparent 0%, rgba(255,255,255,0.6) 50%, transparent 100%)' : undefined,
                backgroundSize: '100% 50%',
                backgroundRepeat: 'repeat-y',
                transition: 'height 600ms cubic-bezier(0.4,0,0.2,1)',
                animation: railActive ? 'railFlow 1.8s linear infinite' : undefined,
              }} />
            )}
            {/* Pulsing tip marking the live leading edge of an in-progress segment. */}
            {railActive && (
              <div className="timeline-rail-tip" style={{
                position: 'absolute',
                left: 8 + nodeSize / 2,
                top: `calc(${nodeSize / 2}px + ${fillPct}%)`,
                width: 7,
                height: 7,
                marginTop: -3.5,
                borderRadius: '50%',
                background: accent,
                zIndex: 0,
                transition: 'top 600ms cubic-bezier(0.4,0,0.2,1)',
                animation: 'railTipPulse 1.8s ease-in-out infinite',
              }} />
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap }}>
              {milestones.map((m, i) => {
                // Hourly completion: fully reached (1) shows as done; a milestone
                // partway through today (0 < c < 1) reads as in-progress.
                const completion = completions[i];
                const effectivelyDone = completion >= 1;
                const inProgress = completion > 0 && completion < 1;
                const effectiveStatus: MilestoneStatus = effectivelyDone ? 'done' : inProgress ? 'in-progress' : m.status;
                const st = statusOf(effectiveStatus);
                const dot = m.color ?? st.color;
                const dateLabel = fmtDate(m.date);
                const isPast = m.date ? m.date < today : false;
                const isToday = m.date === today;
                return (
                  <div key={m.id} style={{ position: 'relative', display: 'flex', gap: 18, alignItems: 'flex-start' }}>
                    {/* Node */}
                    <button
                      onClick={() => cycleStatus(m)}
                      title={isOwner ? `Status: ${st.label} — click to change` : st.label}
                      style={{ position: 'relative', zIndex: 1, width: nodeSize, height: nodeSize, borderRadius: '50%', flexShrink: 0, marginTop: 4, background: effectivelyDone ? dot : '#fff', border: `2.5px solid ${dot}`, cursor: isOwner ? 'pointer' : 'default', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 0 4px #fff', transition: 'all 300ms' }}>
                      {effectivelyDone && <Icon name="check" size={nodeSize - 7} color="#fff" />}
                      {!effectivelyDone && effectiveStatus === 'in-progress' && <div style={{ width: nodeSize / 3, height: nodeSize / 3, borderRadius: '50%', background: dot }} />}
                    </button>

                    {/* Card */}
                    <div style={{ flex: 1, minWidth: 0, background: effectivelyDone ? `${dot}08` : '#fff', border: `1px solid ${effectivelyDone ? dot + '30' : '#ece8f4'}`, borderLeft: `3px solid ${dot}`, borderRadius: 12, padding: cardPad, transition: 'box-shadow 150ms, background 300ms', boxShadow: '0 1px 3px rgba(0,0,0,0.03)' }}
                      onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.07)')}
                      onMouseLeave={e => (e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.03)')}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                        {m.emoji && <span style={{ fontSize: layout === 'detailed' ? 20 : 16, lineHeight: 1.2, flexShrink: 0 }}>{m.emoji}</span>}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: titleSize, fontWeight: 700, color: effectivelyDone ? '#787584' : '#1c1b22', textDecoration: effectivelyDone && m.status === 'done' ? 'line-through' : 'none', transition: 'color 300ms' }}>{m.title}</span>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10, fontWeight: 700, color: st.color, background: `${st.color}1a`, padding: '2px 8px', borderRadius: 9999, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                              <Icon name={st.icon} size={11} color={st.color} />{st.label}
                            </span>
                            {isToday && <span style={{ display: 'inline-flex', alignItems: 'center', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10, fontWeight: 700, color: '#ea580c', background: '#fff7ed', padding: '2px 8px', borderRadius: 9999, letterSpacing: '0.04em' }}>TODAY</span>}
                            {(m.attachmentCount ?? 0) > 0 && (
                              <span title={`${m.attachmentCount} attachment${m.attachmentCount === 1 ? '' : 's'}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 600, color: '#b0acbe' }}>
                                <Icon name="attach_file" size={12} color="#b0acbe" />{m.attachmentCount}
                              </span>
                            )}
                          </div>
                          {(dateLabel || m.time) && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontFamily: 'Inter, sans-serif', fontSize: 12, color: isPast && !isToday ? '#10B981' : '#787584' }}>
                              <Icon name="event" size={13} color={isPast && !isToday ? '#10B981' : '#9d8dff'} />
                              {dateLabel}{m.time ? `${dateLabel ? ' · ' : ''}${m.time}` : ''}
                            </div>
                          )}
                          {m.description && layout !== 'compact' && (
                            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#5a5664', marginTop: 6, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{m.description}</div>
                          )}
                        </div>
                        {isOwner && (
                          <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                            <button onClick={() => setEditing(m)} title="Edit milestone"
                              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer' }}
                              onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
                              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                              <Icon name="edit" size={15} color="#787584" />
                            </button>
                            <button onClick={() => setDeleting(m)} title="Delete milestone"
                              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer' }}
                              onMouseEnter={e => (e.currentTarget.style.background = '#fff0ef')}
                              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                              <Icon name="delete" size={15} color="#ba1a1a" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Add milestone footer (owner) */}
            {isOwner && (
              <button onClick={() => setAdding(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: gap, marginLeft: nodeSize + 18 + 8, padding: '10px 14px', borderRadius: 10, border: '1.5px dashed #d8d2e8', background: '#fcfbff', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: accent }}
                onMouseEnter={e => (e.currentTarget.style.background = bg)}
                onMouseLeave={e => (e.currentTarget.style.background = '#fcfbff')}>
                <Icon name="add" size={16} color={accent} /> Add milestone
              </button>
            )}
          </div>
        )}
      </div>

      {adding && <MilestoneEditor accent={accent} onSave={handleAdd} onClose={() => setAdding(false)} ownerId={timeline.isPublic ? timeline.userId : undefined} />}
      {editing && <MilestoneEditor accent={accent} initial={editing} onSave={data => handleSave(editing.id, data)} onDelete={() => { handleDelete(editing.id); setEditing(null); }} onClose={() => setEditing(null)} ownerId={timeline.isPublic ? timeline.userId : undefined} />}
      {deleting && (
        <DeleteConfirmModal
          name={deleting.title}
          heading="Delete milestone?"
          description={<>"<span style={{ color: '#1c1b22', fontWeight: 500 }}>{deleting.title}</span>" will be moved to trash.</>}
          onConfirm={() => { handleDelete(deleting.id); setDeleting(null); }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
