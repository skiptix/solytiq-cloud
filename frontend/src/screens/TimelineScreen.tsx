import { usePageTitle } from "../hooks/usePageTitle";
import { useMobile } from '../hooks/useBreakpoint';
import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Milestone, MilestoneStatus, TimelineLayout, MilestoneAttachment, SharedFile, WorkspaceMember } from '../types';
import type { MentionMember } from '../utils/mention';
import useAppStore from '../store/useAppStore';
import useSharedItemsStore from '../store/useSharedItemsStore';
import useAuthStore from '../store/useAuthStore';
import useUserPrefsStore from '../store/useUserPrefsStore';
import { todayInTz, minutesSinceMidnightInTz } from '../utils/date';
import { milestoneCompletion, railFillIndex } from '../utils/timeline';
import {
  apiCreateMilestone, apiUpdateMilestone, apiDeleteMilestone,
  apiGetMilestoneAttachments, apiUploadMilestoneAttachment, apiLinkMilestoneAttachment,
  apiDeleteMilestoneAttachment, apiDownloadMilestoneAttachment, apiMilestoneAttachmentBlob,
  apiGetWorkspaceMembers, apiGetItemMembers,
} from '../api/client';
import { genId } from '../utils/id';
import Icon from '../components/Icon';
import SaveStatusDot from '../components/SaveStatusDot';
import EmojiSelector from '../components/EmojiSelector';
import CalendarPicker from '../components/CalendarPicker';
import TimePicker from '../components/TimePicker';
import CreatorBubble from '../components/CreatorBubble';
import NotesEditor from '../components/NotesEditor';
import RelationsPanel from '../components/graph/RelationsPanel';
import MarkdownView from '../components/MarkdownView';
import AutomationsButton from '../components/AutomationsButton';
import { FilePicker, AttachBadge, useAttachmentDrop, AttachDropOverlay } from '../components/TaskDialog';
import AttachmentPreviewModal from '../components/AttachmentPreview';
import { isPreviewable } from '../utils/attachmentPreview';
import { DeleteConfirmModal } from '../components/TaskItem';
import ContextMenu, { type ContextMenuEntry } from '../components/ContextMenu';
import RenameDialog from '../components/RenameDialog';
import MoveMilestoneModal from '../modals/MoveMilestoneModal';
import useMembersStore from '../store/useMembersStore';

function fmtAttSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

const STATUSES: Array<{ key: MilestoneStatus; label: string; color: string; icon: string }> = [
  { key: 'upcoming', label: 'Upcoming', color: 'var(--color-accent-purple-light)', icon: 'schedule' },
  { key: 'in-progress', label: 'In progress', color: 'var(--color-orange)', icon: 'pending' },
  { key: 'done', label: 'Done', color: 'var(--color-success)', icon: 'check_circle' },
];

const MILESTONE_COLORS = ['var(--color-primary)', 'var(--color-blue-mid-7)', 'var(--color-success)', 'var(--color-orange)', 'var(--color-warning-alt)', 'var(--color-error)', 'var(--color-pink-mid-3)', 'var(--color-teal-deep-2)'];

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
function PropRow({ icon, label, children, last = false, first = false, isMobile = false }: { icon: string; label: string; children: ReactNode; last?: boolean; first?: boolean; isMobile?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'flex-start' : 'center', padding: '11px 16px', borderBottom: last ? 'none' : '1px solid rgba(var(--color-border-alt-rgb), 0.5)', borderRadius: first ? '11px 11px 0 0' : last ? '0 0 11px 11px' : 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: isMobile ? undefined : 130, flexShrink: 0, marginBottom: isMobile ? 6 : 0 }}>
        <Icon name={icon} size={14} color="var(--color-purple-tint-11)" />
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)' }}>{label}</span>
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
  /** Workspace members that can be @-mentioned in the milestone note. */
  mentionMembers?: MentionMember[];
  workspaceId?: string;
}
function MilestoneEditor({ accent, initial, onSave, onDelete, onClose, ownerId, mentionMembers, workspaceId }: MilestoneEditorProps) {
  const isMobile = useMobile();
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
  const [showTime, setShowTime] = useState(false);
  const calRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLDivElement>(null);
  const effectiveAccent = color ?? statusOf(status).color;

  // Attachments (edit mode only — a milestone must exist before files attach to it)
  const milestoneId = initial?.id;
  const [attachments, setAttachments] = useState<MilestoneAttachment[]>([]);
  const [attachLoading, setAttachLoading] = useState(Boolean(milestoneId));
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [removingAttId, setRemovingAttId] = useState<string | null>(null);
  const [downloadingAttId, setDownloadingAttId] = useState<string | null>(null);
  const [previewAtt, setPreviewAtt] = useState<MilestoneAttachment | null>(null);
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

  // Close time picker on outside click
  useEffect(() => {
    if (!showTime) return;
    const handler = (e: MouseEvent) => {
      if (timeRef.current && !timeRef.current.contains(e.target as Node)) setShowTime(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showTime]);

  // "Delete open item / milestone" shortcut — only applies in edit mode (a new,
  // unsaved milestone has nothing to delete yet).
  useEffect(() => {
    if (!initial || !onDelete) return;
    const onDeleteShortcut = () => setShowDelete(true);
    window.addEventListener('shortcut:delete-current', onDeleteShortcut);
    return () => window.removeEventListener('shortcut:delete-current', onDeleteShortcut);
  }, [initial, onDelete]);

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

  const handleFilesUpload = async (files: File[]) => {
    for (const f of files) await handleFileUpload(f);
  };

  // Drag & drop only works in edit mode — a new, unsaved milestone has nothing
  // to attach files to yet.
  const { dragging, dropHandlers } = useAttachmentDrop(handleFilesUpload, Boolean(milestoneId) && uploadProgress === null);

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
      descriptionMarkdown: true,
      status,
      emoji: emoji || null,
      color: color ?? null,
    });
  };

  // Portaled to <body>: opened from deep inside the routed timeline screen,
  // whose ancestors establish their own stacking context — without this, the
  // dialog could never render above the sidebar/topbar regardless of z-index.
  return createPortal(
    <>
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.28)', backdropFilter: 'blur(6px)', zIndex: 1000, display: 'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center', padding: isMobile ? 0 : '24px 20px', animation: 'backdropIn 200ms ease both' }}>
      <div onClick={e => e.stopPropagation()}
        {...dropHandlers}
        style={{ background: 'var(--color-white)', borderRadius: isMobile ? '16px 16px 0 0' : 18, width: '100%', maxWidth: 800, maxHeight: isMobile ? '94vh' : '92vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative', boxShadow: '0 32px 80px rgba(var(--color-black-rgb), 0.22), 0 2px 8px rgba(var(--color-black-rgb), 0.08)', animation: isMobile ? 'slideUp 280ms cubic-bezier(0.22,1,0.36,1) both' : 'modalIn 260ms cubic-bezier(0.34,1.56,0.64,1) both' }}>

        <AttachDropOverlay visible={dragging} subtitle="Files will be uploaded and attached to this milestone" />

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
              style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)', background: 'transparent', border: 'none', outline: 'none', lineHeight: 1.3, padding: '6px 0', marginTop: 2 }} />
            <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginTop: 4 }}>
              {initial && onDelete && (
                <button onClick={() => setShowDelete(true)} title="Delete milestone"
                  style={{ width: 34, height: 34, borderRadius: 9, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 120ms' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-error-bg)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <Icon name="delete" size={17} color="var(--color-error)" />
                </button>
              )}
              <button onClick={onClose} title="Close"
                style={{ width: 34, height: 34, borderRadius: 9, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 120ms' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-tint)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <Icon name="close" size={18} color="var(--color-text-tertiary)" />
              </button>
            </div>
          </div>

          {/* Properties panel */}
          <div style={{ background: 'var(--color-surface-tint-3)', borderRadius: 12, marginBottom: 28, border: '1px solid var(--color-purple-pale-23)' }}>
            <PropRow icon="calendar_today" label="Date" first isMobile={isMobile}>
              <div style={{ position: 'relative' }} ref={calRef}>
                <button type="button" onClick={() => { setShowCal(v => !v); setDateError(false); }}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 10px', borderRadius: 8, border: `1px solid ${dateError ? 'var(--color-error)' : showCal ? effectiveAccent : (date ? 'var(--color-accent-purple-soft-alt)' : 'transparent')}`, background: dateError ? 'var(--color-red-pale-2)' : (date ? 'var(--color-surface-tint)' : 'transparent'), cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 13, color: date ? 'var(--color-primary)' : 'var(--color-border-strong)', transition: 'all 120ms', textAlign: 'left' }}>
                  <Icon name="calendar_today" size={13} color={date ? effectiveAccent : 'var(--color-border-strong)'} />
                  {date ? fmtDate(date) : 'Pick a date…'}
                </button>
                {dateError && <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)', marginLeft: 10 }}>A date is required.</span>}
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

            <PropRow icon="schedule" label="Time" isMobile={isMobile}>
              <div style={{ position: 'relative' }} ref={timeRef}>
                <button type="button" onClick={() => setShowTime(v => !v)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 10px', borderRadius: 8, border: `1px solid ${showTime ? effectiveAccent : (time ? 'var(--color-accent-purple-soft-alt)' : 'transparent')}`, background: time ? 'var(--color-surface-tint)' : 'transparent', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 13, color: time ? 'var(--color-primary)' : 'var(--color-border-strong)', transition: 'all 120ms', textAlign: 'left' }}>
                  <Icon name="schedule" size={13} color={time ? effectiveAccent : 'var(--color-border-strong)'} />
                  {time || 'Set a time…'}
                </button>
                {showTime && (
                  <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 50 }}>
                    <TimePicker
                      value={time || undefined}
                      onChange={t => setTime(t)}
                      onClear={() => { setTime(''); setShowTime(false); }}
                    />
                  </div>
                )}
              </div>
            </PropRow>

            <PropRow icon="flag" label="Status" isMobile={isMobile}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {STATUSES.map(s => {
                  const sel = status === s.key;
                  return (
                    <button key={s.key} onClick={() => setStatus(s.key)}
                      style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 12px', borderRadius: 8, border: `1px solid ${sel ? s.color : 'var(--color-border-alt)'}`, background: sel ? `${s.color}18` : 'transparent', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600, color: sel ? s.color : 'var(--color-text-tertiary)', transition: 'all 120ms' }}>
                      <Icon name={s.icon} size={13} color={sel ? s.color : 'var(--color-accent-purple-light)'} />{s.label}
                    </button>
                  );
                })}
              </div>
            </PropRow>

            <PropRow icon="palette" label="Accent" last={!ownerId} isMobile={isMobile}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center' }}>
                <button onClick={() => setColor(null)} title="Match status"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 24, padding: '0 10px', borderRadius: 9999, background: color === null ? 'var(--color-surface-tint-alt)' : 'var(--color-white)', border: `1.5px solid ${color === null ? accent : 'var(--color-border)'}`, cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: color === null ? accent : 'var(--color-text-tertiary)' }}>
                  Auto
                </button>
                {MILESTONE_COLORS.map(c => (
                  <button key={c} onClick={() => setColor(c)} title={c}
                    style={{ width: 24, height: 24, borderRadius: '50%', background: c, border: color === c ? '2.5px solid var(--color-text-primary)' : '2px solid transparent', cursor: 'pointer', padding: 0 }} />
                ))}
              </div>
            </PropRow>

            {ownerId && (
              <PropRow icon="account_circle" label="Owner" isMobile={isMobile}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <CreatorBubble creatorId={ownerId} taskHovered />
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-secondary)' }}>
                    {owner ? (owner.fullName || owner.username) : 'Unknown'}
                  </span>
                </div>
              </PropRow>
            )}

            {milestoneId && (
              <PropRow icon="hub" label="Relations" last isMobile={isMobile}>
                <RelationsPanel entityType="milestone" entityId={milestoneId} workspaceId={workspaceId} compact />
              </PropRow>
            )}
          </div>

          {/* Notes */}
          <div>
            <NotesEditor
              value={description ?? ''}
              onChange={setDescription}
              minHeight={90}
              mentionMembers={mentionMembers}
              aiContext={{
                kind: 'milestone',
                title,
                fields: {
                  Date: date || undefined,
                  Time: time || undefined,
                  Status: statusOf(status).label,
                },
              }}
            />
          </div>

          {/* Attachments — only once the milestone exists (edit mode) */}
          {milestoneId && (
            <>
              <div style={{ height: 1, background: 'var(--color-purple-pale-23)', margin: '24px 0' }} />
              <div>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, color: 'var(--color-border-strong)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  Attachments{attachments.length > 0 && <span style={{ fontWeight: 400, color: 'var(--color-border-strong)', marginLeft: 6 }}>{attachments.length}</span>}
                </div>

                {attachLoading ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', opacity: 0.5 }}>
                    <div style={{ width: 13, height: 13, border: '2px solid var(--color-border-strong)', borderTopColor: 'var(--color-primary)', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
                    <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>Loading…</span>
                  </div>
                ) : attachments.map(att => {
                  const canPreview = isPreviewable(att.mimeType, att.name);
                  return (
                  <div key={att.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 10, background: 'var(--color-surface-tint-3)', marginBottom: 6, border: '1px solid var(--color-purple-pale-23)' }}>
                    <div
                      onClick={() => canPreview ? setPreviewAtt(att) : handleDownloadAttachment(att)}
                      title={canPreview ? 'Click to preview' : 'Download'}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, cursor: 'pointer', borderRadius: 8 }}>
                      <AttachBadge mime={att.mimeType} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.name}</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 1 }}>
                          <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)' }}>{fmtAttSize(att.size)}</span>
                          {canPreview && (
                            <span style={{ display: 'flex', alignItems: 'center', gap: 2, fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600, color: 'var(--color-primary)' }}>
                              <Icon name="visibility" size={11} color="var(--color-primary)" /> Preview
                            </span>
                          )}
                          {att.attachmentType === 'linked' && (
                            <span style={{ fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', borderRadius: 99, padding: '1px 6px' }}>from Files</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <button onClick={() => handleDownloadAttachment(att)} disabled={downloadingAttId === att.id} title="Download"
                      style={{ width: 28, height: 28, borderRadius: 7, border: 'none', background: 'transparent', cursor: downloadingAttId === att.id ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                      onMouseEnter={e => { if (downloadingAttId !== att.id) e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                      {downloadingAttId === att.id
                        ? <div style={{ width: 12, height: 12, border: '2px solid var(--color-accent-purple-soft-alt)', borderTopColor: 'var(--color-primary)', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
                        : <Icon name="download" size={15} color="var(--color-primary)" />}
                    </button>
                    <button onClick={() => handleRemoveAttachment(att)} disabled={removingAttId === att.id} title="Remove"
                      style={{ width: 28, height: 28, borderRadius: 7, border: 'none', background: 'transparent', cursor: removingAttId === att.id ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                      onMouseEnter={e => { if (removingAttId !== att.id) e.currentTarget.style.background = 'var(--color-error-bg)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                      {removingAttId === att.id
                        ? <div style={{ width: 12, height: 12, border: '2px solid var(--color-red-mid-1)', borderTopColor: 'var(--color-error)', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
                        : <Icon name="close" size={14} color="var(--color-error)" />}
                    </button>
                  </div>
                  );
                })}

                {uploadProgress !== null && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 10, background: 'var(--color-surface-tint-3)', marginBottom: 6, border: '1px solid var(--color-purple-pale-23)' }}>
                    <div style={{ width: 34, height: 34, borderRadius: 8, background: 'var(--color-surface-tint)', border: '1px solid var(--color-border-alt)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <div style={{ width: 14, height: 14, border: '2px solid var(--color-accent-purple-soft-alt)', borderTopColor: 'var(--color-primary)', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-primary)', marginBottom: 4 }}>Uploading… {uploadProgress}%</div>
                      <div style={{ background: 'var(--color-border-alt)', borderRadius: 99, height: 3, overflow: 'hidden' }}>
                        <div style={{ width: `${uploadProgress}%`, height: '100%', background: 'var(--color-primary)', borderRadius: 99, transition: 'width 150ms' }} />
                      </div>
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button onClick={() => fileInputRef.current?.click()} disabled={uploadProgress !== null}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: '1.5px dashed var(--color-blue-tint-3)', borderRadius: 9, padding: '7px 14px', cursor: uploadProgress !== null ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)', transition: 'all 120ms', opacity: uploadProgress !== null ? 0.5 : 1 }}
                    onMouseEnter={e => { if (uploadProgress === null) { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.color = 'var(--color-primary)'; e.currentTarget.style.background = 'var(--color-surface-tint-3)'; } }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-blue-tint-3)'; e.currentTarget.style.color = 'var(--color-text-tertiary)'; e.currentTarget.style.background = 'transparent'; }}>
                    <Icon name="upload" size={14} color="currentColor" />
                    Upload file
                  </button>
                  <button onClick={() => setShowFilePicker(true)}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: '1.5px dashed var(--color-blue-tint-3)', borderRadius: 9, padding: '7px 14px', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)', transition: 'all 120ms' }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.color = 'var(--color-primary)'; e.currentTarget.style.background = 'var(--color-surface-tint-3)'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-blue-tint-3)'; e.currentTarget.style.color = 'var(--color-text-tertiary)'; e.currentTarget.style.background = 'transparent'; }}>
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
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 32px', borderTop: '1px solid var(--color-surface-tint-2)', flexShrink: 0 }}>
          <button onClick={onClose} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '9px 18px', cursor: 'pointer' }}>Cancel</button>
          <button onClick={save} disabled={!title.trim()}
            style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: title.trim() ? effectiveAccent : 'var(--color-border-strong)', border: 'none', borderRadius: 8, padding: '9px 22px', cursor: title.trim() ? 'pointer' : 'default' }}>
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
        description={<>"<span style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>{title.trim() || initial?.title}</span>" will be moved to trash.</>}
        onConfirm={() => { setShowDelete(false); onDelete(); }}
        onCancel={() => setShowDelete(false)}
      />
    )}
    {previewAtt && milestoneId && (
      <AttachmentPreviewModal
        name={previewAtt.name}
        mimeType={previewAtt.mimeType}
        fetchBlob={() => apiMilestoneAttachmentBlob(milestoneId, previewAtt.id, previewAtt.mimeType)}
        onDownload={() => handleDownloadAttachment(previewAtt)}
        onClose={() => setPreviewAtt(null)}
      />
    )}
    </>,
    document.body
  );
}

// ── Timeline screen ────────────────────────────────────────────────────────────
export default function TimelineScreen() {
  const isMobile = useMobile();
  const { timelineId } = useParams<{ timelineId: string }>();
  const navigate = useNavigate();
  const { userId: currentUserId } = useAuthStore();
  const { timelines, listsLoading, setTimelines, loadFromApi } = useAppStore();
  const timezone = useUserPrefsStore(s => s.timezone);
  const today = todayInTz(timezone);
  const sharedTimelines = useSharedItemsStore(s => s.timelines);
  const timeline = timelines.find(t => t.id === timelineId) ?? sharedTimelines.find(t => t.id === timelineId);

  const [editing, setEditing] = useState<Milestone | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Milestone | null>(null);
  const [renaming, setRenaming] = useState<Milestone | null>(null);
  const [moving, setMoving] = useState<Milestone | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; milestone: Milestone } | null>(null);

  // Workspace members for the milestone note's @-mention typeahead.
  const [wsMembers, setWsMembers] = useState<WorkspaceMember[]>([]);
  const [timelineInvitees, setTimelineInvitees] = useState<MentionMember[]>([]);
  const timelineWorkspaceId = timeline?.workspaceId ?? null;
  useEffect(() => {
    if (!timelineWorkspaceId) { setWsMembers([]); return; }
    let alive = true;
    apiGetWorkspaceMembers(timelineWorkspaceId).then(r => { if (alive) setWsMembers(r.members); }).catch(() => {});
    return () => { alive = false; };
  }, [timelineWorkspaceId]);
  useEffect(() => {
    if (!timelineId) { setTimelineInvitees([]); return; }
    let alive = true;
    apiGetItemMembers('timeline', timelineId)
      .then(r => { if (alive) setTimelineInvitees(r.members.map(m => ({ id: m.userId, username: m.username, fullName: m.fullName }))); })
      .catch(() => {});
    return () => { alive = false; };
  }, [timelineId]);
  const mentionMembers: MentionMember[] = (() => {
    const byId = new Map<string, MentionMember>();
    for (const m of wsMembers) if (m.userId !== currentUserId) byId.set(m.userId, { id: m.userId, username: m.username, fullName: m.fullName ?? null });
    for (const m of timelineInvitees) if (m.id !== currentUserId) byId.set(m.id, m);
    return [...byId.values()];
  })();

  // "New milestone" shortcut — same as the "Add Milestone" buttons (owner only,
  // and only when no milestone editor is already open).
  useEffect(() => {
    const onCreateMilestone = () => {
      if (timeline?.userId === currentUserId && !adding && !editing) setAdding(true);
    };
    window.addEventListener('shortcut:create-milestone', onCreateMilestone);
    return () => window.removeEventListener('shortcut:create-milestone', onCreateMilestone);
  }, [timeline, currentUserId, adding, editing]);

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
          <div style={{ width: 32, height: 32, border: '3px solid var(--color-border)', borderTopColor: 'var(--color-primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
        </div>
      );
    }
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}>Timeline not found</div>
          <button onClick={() => navigate('/dashboard')} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer' }}>Go to Dashboard</button>
        </div>
      </div>
    );
  }

  const accent = timeline.color ?? 'var(--color-primary)';
  const bg = timeline.colorBg ?? 'var(--color-surface-gray)';
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
      descriptionMarkdown: data.descriptionMarkdown ?? false,
      status: (data.status as MilestoneStatus) ?? 'upcoming',
      emoji: data.emoji ?? null,
      color: data.color ?? null,
      position: timeline.milestones.length,
    };
    updateStoreMilestones(ms => [...ms, optimistic]);
    setAdding(false);
    apiCreateMilestone(timeline.id, { id, title: optimistic.title, date: optimistic.date, time: optimistic.time, description: optimistic.description, descriptionMarkdown: optimistic.descriptionMarkdown, status: optimistic.status, emoji: optimistic.emoji, color: optimistic.color })
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

  const handleMove = (milestoneId: string, targetTimelineId: string) => {
    updateStoreMilestones(ms => ms.filter(m => m.id !== milestoneId));
    apiUpdateMilestone(milestoneId, { timelineId: targetTimelineId }).catch(() => loadFromApi());
  };

  const cycleStatus = (m: Milestone) => {
    if (!isOwner) return;
    const order: MilestoneStatus[] = ['upcoming', 'in-progress', 'done'];
    const next = order[(order.indexOf(m.status) + 1) % order.length];
    handleSave(m.id, { status: next });
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--color-white)' }}>
      {/* Hero */}
      <div style={{ background: bg, borderBottom: '1px solid var(--color-divider)', padding: isMobile ? '20px 16px 16px' : '32px 40px 26px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, maxWidth: 860, margin: '0 auto' }}>
          <div style={{ width: 56, height: 56, borderRadius: 16, background: 'var(--color-white)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, boxShadow: '0 2px 10px rgba(var(--color-black-rgb), 0.06)', flexShrink: 0 }}>
            {timeline.emoji ?? <Icon name="timeline" size={28} color={accent} />}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h1 style={{ margin: 0, fontFamily: 'var(--font-heading)', fontSize: 26, fontWeight: 800, color: 'var(--color-text-primary)' }}>{timeline.name}</h1>
              <SaveStatusDot />
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: accent, background: 'var(--color-white)', padding: '3px 9px', borderRadius: 9999, border: `1px solid ${accent}33` }}>
                <Icon name="timeline" size={13} color={accent} /> Timeline
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
                <Icon name={timeline.isPublic ? 'public' : 'lock'} size={13} color="var(--color-text-tertiary)" />{timeline.isPublic ? 'Public' : 'Private'}
              </span>
            </div>
            {timeline.subtitle && <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-tertiary)', marginTop: 4 }}>{timeline.subtitle}</div>}
            {/* Progress */}
            <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1, maxWidth: 320, height: 8, borderRadius: 9999, background: 'rgba(var(--color-black-rgb), 0.07)', overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', borderRadius: 9999, background: accent, transition: 'width 400ms ease' }} />
              </div>
              <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-secondary)' }}>{done}/{total} done · {pct}%</span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <AutomationsButton ownerType="timeline" ownerId={timeline.id} isMobile={isMobile} />
            {isOwner && (
              <button onClick={() => setAdding(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', borderRadius: 10, border: 'none', background: accent, color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', flexShrink: 0, boxShadow: `0 4px 14px ${accent}40` }}>
                <Icon name="add" size={17} color="var(--color-white)" /> Milestone
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Timeline body */}
      <div style={{ maxWidth: 860, margin: '0 auto', padding: isMobile ? '16px 16px 80px' : '28px 40px 80px' }}>
        {total === 0 ? (
          <div style={{ textAlign: 'center', padding: '56px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 64, height: 64, borderRadius: 18, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="timeline" size={32} color={accent} />
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)' }}>No milestones yet</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-tertiary)', maxWidth: 300, lineHeight: 1.6 }}>
              {isOwner ? 'Add your first milestone to start building this timeline.' : 'This timeline has no milestones yet.'}
            </div>
            {isOwner && (
              <button onClick={() => setAdding(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 20px', borderRadius: 10, border: 'none', background: accent, color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                <Icon name="add" size={17} color="var(--color-white)" /> Add Milestone
              </button>
            )}
          </div>
        ) : (
          <div style={{ position: 'relative', paddingLeft: 8 }}>
            {/* Vertical rail — grey background track */}
            <div style={{ position: 'absolute', left: 8 + nodeSize / 2 - 1, top: nodeSize / 2, bottom: nodeSize / 2, width: 2, background: 'var(--color-border)', borderRadius: 2 }} />
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
                backgroundImage: railActive ? 'linear-gradient(180deg, transparent 0%, rgba(var(--color-white-rgb), 0.6) 50%, transparent 100%)' : undefined,
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
                      style={{ position: 'relative', zIndex: 1, width: nodeSize, height: nodeSize, borderRadius: '50%', flexShrink: 0, marginTop: 4, background: effectivelyDone ? dot : 'var(--color-white)', border: `2.5px solid ${dot}`, cursor: isOwner ? 'pointer' : 'default', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 0 4px var(--color-white)', transition: 'all 300ms' }}>
                      {effectivelyDone && <Icon name="check" size={nodeSize - 7} color="var(--color-white)" />}
                      {!effectivelyDone && effectiveStatus === 'in-progress' && <div style={{ width: nodeSize / 3, height: nodeSize / 3, borderRadius: '50%', background: dot }} />}
                    </button>

                    {/* Card */}
                    <div style={{ flex: 1, minWidth: 0, background: effectivelyDone ? `${dot}08` : 'var(--color-white)', border: `1px solid ${effectivelyDone ? dot + '30' : 'var(--color-purple-pale-34)'}`, borderLeft: `3px solid ${dot}`, borderRadius: 12, padding: cardPad, transition: 'box-shadow 150ms, background 300ms', boxShadow: '0 1px 3px rgba(var(--color-black-rgb), 0.03)' }}
                      onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 4px 16px rgba(var(--color-black-rgb), 0.07)')}
                      onMouseLeave={e => (e.currentTarget.style.boxShadow = '0 1px 3px rgba(var(--color-black-rgb), 0.03)')}
                      onContextMenu={e => { if (!isOwner) return; e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, milestone: m }); }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                        {m.emoji && <span style={{ fontSize: layout === 'detailed' ? 20 : 16, lineHeight: 1.2, flexShrink: 0 }}>{m.emoji}</span>}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontFamily: 'var(--font-heading)', fontSize: titleSize, fontWeight: 700, color: effectivelyDone ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)', textDecoration: effectivelyDone && m.status === 'done' ? 'line-through' : 'none', transition: 'color 300ms' }}>{m.title}</span>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-heading)', fontSize: 10, fontWeight: 700, color: st.color, background: `${st.color}1a`, padding: '2px 8px', borderRadius: 9999, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                              <Icon name={st.icon} size={11} color={st.color} />{st.label}
                            </span>
                            {isToday && <span style={{ display: 'inline-flex', alignItems: 'center', fontFamily: 'var(--font-heading)', fontSize: 10, fontWeight: 700, color: 'var(--color-orange)', background: 'var(--color-orange-pale-3)', padding: '2px 8px', borderRadius: 9999, letterSpacing: '0.04em' }}>TODAY</span>}
                            {(m.attachmentCount ?? 0) > 0 && (
                              <span title={`${m.attachmentCount} attachment${m.attachmentCount === 1 ? '' : 's'}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-quaternary)' }}>
                                <Icon name="attach_file" size={12} color="var(--color-text-quaternary)" />{m.attachmentCount}
                              </span>
                            )}
                          </div>
                          {(dateLabel || m.time) && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontFamily: 'var(--font-body)', fontSize: 12, color: isPast && !isToday ? 'var(--color-success)' : 'var(--color-text-tertiary)' }}>
                              <Icon name="event" size={13} color={isPast && !isToday ? 'var(--color-success)' : 'var(--color-accent-purple-light)'} />
                              {dateLabel}{m.time ? `${dateLabel ? ' · ' : ''}${m.time}` : ''}
                            </div>
                          )}
                          {m.description && layout !== 'compact' && (
                            <div style={{ marginTop: 6, display: '-webkit-box', WebkitLineClamp: 6, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                              <MarkdownView source={m.description} fontSize={13} />
                            </div>
                          )}
                        </div>
                        {isOwner && (
                          <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                            <button onClick={() => setEditing(m)} title="Edit milestone"
                              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer' }}
                              onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-tint)')}
                              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                              <Icon name="edit" size={15} color="var(--color-text-tertiary)" />
                            </button>
                            <button onClick={() => setDeleting(m)} title="Delete milestone"
                              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer' }}
                              onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-red-pale-5)')}
                              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                              <Icon name="delete" size={15} color="var(--color-error)" />
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
                style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: gap, marginLeft: nodeSize + 18 + 8, padding: '10px 14px', borderRadius: 10, border: '1.5px dashed var(--color-purple-tint-3)', background: 'var(--color-purple-pale-2)', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: accent }}
                onMouseEnter={e => (e.currentTarget.style.background = bg)}
                onMouseLeave={e => (e.currentTarget.style.background = 'var(--color-purple-pale-2)')}>
                <Icon name="add" size={16} color={accent} /> Add milestone
              </button>
            )}
          </div>
        )}
      </div>

      {adding && <MilestoneEditor accent={accent} onSave={handleAdd} onClose={() => setAdding(false)} ownerId={timeline.isPublic ? timeline.userId : undefined} mentionMembers={mentionMembers} />}
      {editing && <MilestoneEditor accent={accent} initial={editing} onSave={data => handleSave(editing.id, data)} onDelete={() => { handleDelete(editing.id); setEditing(null); }} onClose={() => setEditing(null)} ownerId={timeline.isPublic ? timeline.userId : undefined} mentionMembers={mentionMembers} workspaceId={timeline.workspaceId} />}
      {deleting && (
        <DeleteConfirmModal
          name={deleting.title}
          heading="Delete milestone?"
          description={<>"<span style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>{deleting.title}</span>" will be moved to trash.</>}
          onConfirm={() => { handleDelete(deleting.id); setDeleting(null); }}
          onCancel={() => setDeleting(null)}
        />
      )}

      {contextMenu && (() => {
        const m = contextMenu.milestone;
        const items: ContextMenuEntry[] = [
          { key: 'settings', label: 'More settings…', icon: 'tune', onClick: () => setEditing(m) },
          { key: 'rename', label: 'Rename', icon: 'edit', onClick: () => setRenaming(m) },
          { key: 'move', label: 'Move to another timeline', icon: 'drive_file_move', onClick: () => setMoving(m) },
          { key: 'div1', divider: true },
          { key: 'delete', label: 'Delete', icon: 'delete', danger: true, onClick: () => setDeleting(m) },
        ];
        return <ContextMenu x={contextMenu.x} y={contextMenu.y} items={items} onClose={() => setContextMenu(null)} />;
      })()}

      {renaming && (
        <RenameDialog
          value={renaming.title}
          accentColor={accent}
          onSave={v => { const trimmed = v.trim(); if (trimmed && trimmed !== renaming.title) handleSave(renaming.id, { title: trimmed }); setRenaming(null); }}
          onCancel={() => setRenaming(null)}
        />
      )}

      {moving && (
        <MoveMilestoneModal
          milestone={moving}
          currentTimelineId={timeline.id}
          onPick={targetTimelineId => handleMove(moving.id, targetTimelineId)}
          onClose={() => setMoving(null)}
        />
      )}
    </div>
  );
}
