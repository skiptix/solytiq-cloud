import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from '@/components/animate-ui/motion';
import type { Task, TaskAttachment, SharedFile } from '../types';
import Icon from './Icon';
import { useMobile } from '../hooks/useBreakpoint';
import CalendarPicker from './CalendarPicker';
import TaskChangeHistory from './TaskChangeHistory';
import NotesEditor from './NotesEditor';
import TaggedUsersRow from './TaggedUsersRow';
import RelationsPanel from './graph/RelationsPanel';
import AttachmentPreviewModal from './AttachmentPreview';
import { isPreviewable } from '../utils/attachmentPreview';
import { backdropVariants, modalVariants, sheetVariants } from '@/components/animate-ui/motionTokens';
import { DeleteConfirmModal } from './TaskItem';
import useAppStore from '../store/useAppStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import useAuthStore from '../store/useAuthStore';
import useAIStore from '../store/useAIStore';
import {
  apiCreateList, apiCreateSection, apiAddListTask, apiUpdateTask, apiUpdateListTask,
  apiGetTaskAttachments, apiUploadTaskAttachment, apiLinkTaskAttachment, apiDeleteTaskAttachment, apiDownloadTaskAttachment,
  apiTaskAttachmentBlob, apiGetFiles, apiGetWorkspaceMembers, apiGetItemMembers,
} from '../api/client';
import type { WorkspaceMember } from '../types';
import type { MentionMember } from '../utils/mention';

function fmtAttSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function attMimeLabel(mime: string): string {
  if (mime.includes('pdf'))   return 'PDF';
  if (mime.includes('image')) return mime.split('/')[1]?.toUpperCase().slice(0, 4) ?? 'IMG';
  if (mime.includes('video')) return 'VID';
  if (mime.includes('zip') || mime.includes('compressed')) return 'ZIP';
  if (mime.includes('word') || mime.includes('document')) return 'DOC';
  return mime.split('/')[1]?.toUpperCase().slice(0, 4) ?? 'FILE';
}

function attMimeColor(mime: string): string {
  if (mime.includes('pdf'))   return 'var(--color-red-mid-4)';
  if (mime.includes('image')) return 'var(--color-blue-mid-5)';
  if (mime.includes('video')) return 'var(--color-purple-mid-9)';
  if (mime.includes('zip'))   return 'var(--color-warning)';
  return 'var(--color-primary)';
}

export function AttachBadge({ mime }: { mime: string }) {
  return (
    <div style={{ width: 34, height: 34, borderRadius: 8, background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexShrink: 0, position: 'relative', overflow: 'hidden' }}>
      <Icon name="description" size={17} color="var(--color-blue-tint-3)" />
      <div style={{ position: 'absolute', bottom: 2, left: '50%', transform: 'translateX(-50%)', background: attMimeColor(mime), color: 'var(--color-white)', fontFamily: 'var(--font-body)', fontSize: 6, fontWeight: 800, padding: '1px 3px', borderRadius: 2 }}>{attMimeLabel(mime)}</div>
    </div>
  );
}

// ── Drag & drop attachment support ────────────────────────────────
// Shared by the item (TaskDialog) and milestone (TimelineScreen) editors:
// spread `dropHandlers` on the dialog card (which must be position:relative)
// and render <AttachDropOverlay visible={dragging} /> inside it.
export function useAttachmentDrop(onFiles: (files: File[]) => void, enabled = true) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  // Only react to real file drags — not text selections or in-app element drags.
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  const onDragEnter = (e: React.DragEvent) => {
    if (!enabled || !hasFiles(e)) return;
    e.preventDefault();
    depth.current += 1;
    setDragging(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!enabled || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!enabled || !hasFiles(e)) return;
    e.preventDefault();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!enabled || !hasFiles(e)) return;
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) onFiles(files);
  };

  return { dragging, dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}

export function AttachDropOverlay({ visible, subtitle }: { visible: boolean; subtitle: string }) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          variants={backdropVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          style={{ position: 'absolute', inset: 0, zIndex: 30, background: 'rgba(var(--color-surface-tint-3-rgb), 0.94)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', padding: 24 }}>
          <div style={{ border: '2px dashed var(--color-primary)', borderRadius: 16, background: 'var(--color-surface-tint)', padding: '30px 46px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, boxShadow: '0 8px 40px rgba(var(--color-primary-rgb), 0.10)', maxWidth: '100%' }}>
            <div style={{ width: 50, height: 50, borderRadius: 14, background: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="upload_file" size={26} color="var(--color-white)" />
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', textAlign: 'center' }}>Drop files to attach</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', textAlign: 'center' }}>{subtitle}</div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── File picker modal (choose from existing Files) ────────────────
export function FilePicker({ onSelect, onClose }: { onSelect: (file: SharedFile) => void; onClose: () => void }) {
  const [files, setFiles] = useState<SharedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [picking, setPickingId] = useState<string | null>(null);

  useEffect(() => {
    apiGetFiles().then(r => setFiles(r.files)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const filtered = files.filter(f =>
    f.name.toLowerCase().includes(search.toLowerCase()) ||
    (f.title ?? '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <motion.div
      variants={backdropVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      style={{ position: 'fixed', inset: 0, zIndex: 1500, background: 'rgba(var(--color-black-rgb), 0.32)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        variants={modalVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        style={{ background: 'var(--color-white)', borderRadius: 18, width: '100%', maxWidth: 480, maxHeight: '70vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 60px rgba(var(--color-black-rgb), 0.22)', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 18px 14px', borderBottom: '1px solid var(--color-purple-pale-23)', flexShrink: 0 }}>
          <Icon name="folder_open" size={18} color="var(--color-primary)" />
          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', flex: 1 }}>Attach from Files</span>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-tint)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <Icon name="close" size={16} color="var(--color-text-tertiary)" />
          </button>
        </div>
        {/* Search */}
        <div style={{ padding: '10px 18px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 9, padding: '7px 12px' }}>
            <Icon name="search" size={15} color="var(--color-text-quaternary)" />
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search files…"
              style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)', background: 'transparent', border: 'none', outline: 'none' }}
            />
          </div>
        </div>
        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 10px 12px' }}>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 28 }}>
              <div style={{ width: 22, height: 22, border: '2.5px solid var(--color-border)', borderTopColor: 'var(--color-primary)', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: 'center', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)', padding: '28px 16px' }}>{search ? 'No matching files' : 'No files uploaded yet'}</div>
          ) : (
            filtered.map(f => (
              <button
                key={f.id}
                disabled={picking === f.id}
                onClick={() => { setPickingId(f.id); onSelect(f); }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '9px 10px', borderRadius: 10, border: 'none', background: picking === f.id ? 'var(--color-surface-tint)' : 'transparent', cursor: picking === f.id ? 'default' : 'pointer', textAlign: 'left', transition: 'background 120ms' }}
                onMouseEnter={e => { if (picking !== f.id) e.currentTarget.style.background = 'var(--color-surface-tint-3)'; }}
                onMouseLeave={e => { if (picking !== f.id) e.currentTarget.style.background = 'transparent'; }}
              >
                <AttachBadge mime={f.mimeType} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.title || f.name}</div>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', marginTop: 1 }}>{fmtAttSize(f.size)}</div>
                </div>
                {picking === f.id && (
                  <div style={{ width: 14, height: 14, border: '2px solid var(--color-accent-purple-soft-alt)', borderTopColor: 'var(--color-primary)', borderRadius: '50%', animation: 'spin 0.6s linear infinite', flexShrink: 0 }} />
                )}
                {picking !== f.id && <Icon name="add" size={16} color="var(--color-border-strong)" />}
              </button>
            ))
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

const PRIORITIES = ['High', 'Medium', 'Low'] as const;
const PRIORITY_COLORS: Record<string, string> = { High: 'var(--color-orange)', Medium: 'var(--color-warning-alt)', Low: 'var(--color-text-tertiary)' };

function localIso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function friendlyDate(iso?: string) {
  if (!iso) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(iso.slice(0, 10) + 'T12:00:00');
  if (iso === localIso(today)) return 'Today';
  const tom = new Date(today); tom.setDate(tom.getDate() + 1);
  if (iso === localIso(tom)) return 'Tomorrow';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "hh:mm - dd.mm.yyyy" in local time. */
function formatDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  return `${hh}:${mi} - ${dd}.${mo}.${d.getFullYear()}`;
}

/** Elapsed span as total-hours:minutes, e.g. "76:23" for 3d 4h 23m. */
function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  const hh = Math.floor(totalMinutes / 60);
  const mi = totalMinutes % 60;
  return `${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function Checkmark() {
  return (
    <svg width="12" height="9" viewBox="0 0 12 9" fill="none">
      <path d="M1 4.5L4.5 8L11 1" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SmallCheck() {
  return (
    <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
      <path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface TaskDialogProps {
  task: Task;
  onUpdate: (id: number, updates: Partial<Task>) => void;
  onDelete: (id: number) => void;
  onClose: () => void;
  /** Deprecated: the old Owner row is now folded into the Tag row (which always
   *  shows the creator). Kept optional so existing callers still type-check. */
  isPublic?: boolean;
}

export default function TaskDialog({ task, onUpdate, onDelete, onClose }: TaskDialogProps) {
  const isMobile = useMobile();
  const isListTask = task._source === 'list' && Boolean(task._listId);
  const [showChangelog, setShowChangelog] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.note ?? '');
  const [deadline, setDeadline] = useState(task.deadline ?? '');
  const [priority, setPriority] = useState<string>(task.priority ?? '');
  const [checked, setChecked] = useState(task.checked);
  const [showCal, setShowCal] = useState(false);
  const [calPos, setCalPos] = useState<{ top: number; left: number } | null>(null);
  const [showDelete, setShowDelete] = useState(false);
  const [linkedListId, setLinkedListId] = useState(task.linkedListId ?? null);
  const [newSubItem, setNewSubItem] = useState('');
  const [addingSubItem, setAddingSubItem] = useState(false);
  const [creatingList, setCreatingList] = useState(false);

  // Attachments
  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);
  const [attachLoading, setAttachLoading] = useState(true);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [removingAttId, setRemovingAttId] = useState<string | null>(null);
  const [downloadingAttId, setDownloadingAttId] = useState<string | null>(null);
  const [previewAtt, setPreviewAtt] = useState<TaskAttachment | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const titleRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const calBtnRef = useRef<HTMLButtonElement>(null);

  const loadAttachments = useCallback(async () => {
    try {
      const r = await apiGetTaskAttachments(task.id);
      setAttachments(r.attachments);
    } catch { /* silent */ } finally { setAttachLoading(false); }
  }, [task.id]);

  const { lists, setLists, updateListTask, loadFromApi } = useAppStore();
  const { currentWorkspaceId } = useWorkspaceStore();
  const currentUserId = useAuthStore(s => s.userId);
  const isAdmin = useAuthStore(s => s.isAdmin);

  // Which workspace the item lives in — list tasks inherit it from their list;
  // dash tasks carry it directly (falling back to the active workspace).
  const taskWorkspaceId = isListTask
    ? (lists.find(l => l.id === task._listId)?.workspaceId ?? null)
    : (task.workspaceId ?? currentWorkspaceId ?? null);
  // Only the item's creator (or an admin) may add/remove tags — mirrors who can
  // edit the item itself.
  const canEditTags = Boolean((task.creatorId && task.creatorId === currentUserId) || isAdmin);

  // Workspace members — powers both the Tag row's picker and the note's
  // @-mention typeahead. Only fetched for items that live in a workspace.
  const [wsMembers, setWsMembers] = useState<WorkspaceMember[]>([]);
  const [itemInvitees, setItemInvitees] = useState<MentionMember[]>([]);
  useEffect(() => {
    if (!taskWorkspaceId) { setWsMembers([]); return; }
    let alive = true;
    apiGetWorkspaceMembers(taskWorkspaceId).then(r => { if (alive) setWsMembers(r.members); }).catch(() => {});
    return () => { alive = false; };
  }, [taskWorkspaceId]);
  // People invited to the task's list can be @-mentioned too (covers a private
  // list in a solo/other workspace where there are no workspace members).
  useEffect(() => {
    if (!isListTask || !task._listId) { setItemInvitees([]); return; }
    let alive = true;
    apiGetItemMembers('list', task._listId)
      .then(r => { if (alive) setItemInvitees(r.members.map(m => ({ id: m.userId, username: m.username, fullName: m.fullName }))); })
      .catch(() => {});
    return () => { alive = false; };
  }, [isListTask, task._listId]);
  const mentionMembers: MentionMember[] = (() => {
    const byId = new Map<string, MentionMember>();
    for (const m of wsMembers) if (m.userId !== currentUserId) byId.set(m.userId, { id: m.userId, username: m.username, fullName: m.fullName ?? null });
    for (const m of itemInvitees) if (m.id !== currentUserId) byId.set(m.id, m);
    return [...byId.values()];
  })();

  const linkedList = linkedListId ? lists.find(l => l.id === linkedListId) : null;
  const subItems = linkedList?.sections.flatMap(s => s.tasks) ?? [];

  const resizeTA = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  useEffect(() => {
    if (titleRef.current) resizeTA(titleRef.current);
  }, []);

  useEffect(() => { loadAttachments(); }, [loadAttachments]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !showCal) onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, showCal]);

  // On mobile this dialog is a near-full-screen sheet — tell the floating AI
  // Assistant bubble (fixed, zIndex 9000) to hide itself for as long as we're
  // open, so it doesn't float on top of the Notes section.
  useEffect(() => {
    if (!isMobile) return;
    const { openBlockingDialog, closeBlockingDialog } = useAIStore.getState();
    openBlockingDialog();
    return () => closeBlockingDialog();
  }, [isMobile]);

  // "Delete open item / milestone" shortcut — same as the delete icon button.
  useEffect(() => {
    const onDeleteShortcut = () => setShowDelete(true);
    window.addEventListener('shortcut:delete-current', onDeleteShortcut);
    return () => window.removeEventListener('shortcut:delete-current', onDeleteShortcut);
  }, []);

  // "Toggle change history" shortcut — same as the manage_history icon button.
  // No-op for dash tasks, which have no tracked change history.
  useEffect(() => {
    if (!isListTask) return;
    const onToggleChangelog = () => setShowChangelog(v => !v);
    window.addEventListener('shortcut:toggle-changelog', onToggleChangelog);
    return () => window.removeEventListener('shortcut:toggle-changelog', onToggleChangelog);
  }, [isListTask]);

  // Buffered editing: field edits live in local state and are only persisted
  // when Save is clicked. Cancel/close discards them. (Attachments & sub-items
  // remain immediate — they're separate actions that can't be cleanly rolled back.)
  const handleSave = () => {
    const updates: Partial<Task> = {};
    const trimmed = title.trim();
    if (trimmed && trimmed !== task.title) updates.title = trimmed;
    if (checked !== task.checked) updates.checked = checked;
    if ((deadline || '') !== (task.deadline ?? '')) updates.deadline = deadline || undefined;
    if ((priority || '') !== (task.priority ?? '')) updates.priority = (priority as Task['priority']) || undefined;
    if ((notes || '') !== (task.note ?? '')) updates.note = notes || undefined;
    if (!task.noteMarkdown) updates.noteMarkdown = true;
    if (Object.keys(updates).length > 0) onUpdate(task.id, updates);
    onClose();
  };

  const handleFileUpload = async (file: File) => {
    setUploadProgress(0);
    try {
      const att = await apiUploadTaskAttachment(task.id, file, pct => setUploadProgress(pct));
      setAttachments(prev => [...prev, att]);
    } catch { /* silent */ } finally { setUploadProgress(null); }
  };

  const handleFilesUpload = async (files: File[]) => {
    for (const f of files) await handleFileUpload(f);
  };

  const { dragging, dropHandlers } = useAttachmentDrop(handleFilesUpload, uploadProgress === null);

  const handleLinkFile = async (sf: SharedFile) => {
    try {
      const r = await apiLinkTaskAttachment(task.id, sf.id);
      setAttachments(prev => [...prev, r.attachment]);
    } catch { /* silent */ } finally { setShowFilePicker(false); }
  };

  const handleRemoveAttachment = async (att: TaskAttachment) => {
    setRemovingAttId(att.id);
    try {
      await apiDeleteTaskAttachment(task.id, att.id);
      setAttachments(prev => prev.filter(a => a.id !== att.id));
    } catch { /* silent */ } finally { setRemovingAttId(null); }
  };

  const handleDownloadAttachment = async (att: TaskAttachment) => {
    setDownloadingAttId(att.id);
    try {
      await apiDownloadTaskAttachment(task.id, att.id, att.name);
    } catch { /* silent */ } finally { setDownloadingAttId(null); }
  };

  const handleAddSubItem = async () => {
    if (!newSubItem.trim()) return;
    const itemTitle = newSubItem.trim();
    setNewSubItem('');
    setAddingSubItem(false);

    try {
      let listId = linkedListId;
      let sectionId: string;

      if (!listId) {
        setCreatingList(true);
        const newListId = `list_${crypto.randomUUID()}`;
        const newSecId = `sec_${crypto.randomUUID()}`;

        // Inherit workspaceId from the parent list (list tasks) or the active workspace (dash tasks)
        const parentList = task._source === 'list' ? lists.find(l => l.id === task._listId) : null;
        const workspaceId = parentList?.workspaceId ?? currentWorkspaceId ?? undefined;
        const newDepth = (parentList?.depth ?? 0) + 1;
        const res = await apiCreateList({ id: newListId, name: title, color: 'var(--color-primary)', isPublic: false, workspaceId, parentTaskId: task.id, depth: newDepth });
        const actualListId = res.list?.id ?? newListId;

        const secRes = await apiCreateSection(actualListId, { id: newSecId, label: 'Tasks' });
        const actualSecId = secRes.section?.id ?? newSecId;

        // Optimistically add the new sublist to the store so it appears immediately
        // without waiting for the DB reload (which can be discarded by a concurrent SSE reload)
        setLists(prev => [
          ...prev,
          {
            id: actualListId,
            name: title,
            color: 'var(--color-primary)',
            isPublic: false,
            workspaceId: workspaceId,
            parentTaskId: task.id,
            depth: newDepth,
            sections: [{ id: actualSecId, label: 'Tasks', tasks: [] }],
          },
        ]);

        if (task._source === 'list' && task._listId) {
          await apiUpdateListTask(task._listId, task.id, { linkedListId: actualListId, linkedListType: 'sublist' });
        } else {
          await apiUpdateTask(task.id, { linkedListId: actualListId, linkedListType: 'sublist' });
        }

        setLinkedListId(actualListId);
        listId = actualListId;
        sectionId = actualSecId;
        setCreatingList(false);
      } else {
        let currentLinkedList = linkedList;
        if (!currentLinkedList) {
          await loadFromApi();
          currentLinkedList = useAppStore.getState().lists.find(l => l.id === listId) ?? null;
        }
        sectionId = currentLinkedList?.sections[0]?.id ?? '';
        if (!sectionId) {
          return;
        }
      }

      await apiAddListTask(listId, sectionId, { title: itemTitle });

      const wsId = useWorkspaceStore.getState().currentWorkspaceId;
      await loadFromApi(wsId ?? undefined);
    } catch (err) {
      setCreatingList(false);
    }
  };

  // Portaled to <body>: this dialog is opened from deep inside routed screens
  // whose ancestors (e.g. the page-transition wrapper) establish their own
  // stacking context, which would otherwise cap it below the sidebar/topbar
  // no matter how high its z-index is set.
  return createPortal(
    <>
      <motion.div
        ref={backdropRef}
        variants={backdropVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        onClick={e => { if (e.target === backdropRef.current) onClose(); }}
        style={{
          position: 'fixed', inset: 0, zIndex: 1200,
          background: 'rgba(var(--color-black-rgb), 0.28)', backdropFilter: 'blur(6px)',
          display: 'flex',
          alignItems: isMobile ? 'flex-end' : 'center',
          justifyContent: 'center',
          padding: isMobile ? 0 : '24px 20px',
        }}>

        <motion.div
          onClick={e => e.stopPropagation()}
          {...dropHandlers}
          variants={isMobile ? sheetVariants : modalVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          style={{
            background: 'var(--color-white)',
            borderRadius: isMobile ? '16px 16px 0 0' : 18,
            width: '100%',
            // Widens to make room for the change-history panel — the backdrop's
            // own flex centering re-centers the whole card smoothly as this
            // transitions, no extra positioning logic needed.
            maxWidth: isMobile ? undefined : (showChangelog ? 800 + 320 : 800),
            // dvh (not vh) on mobile: iOS Safari/Arc's vh is pegged to the
            // largest possible viewport (address bar hidden), so a bottom sheet
            // sized off it can be taller than the viewport actually visible
            // when the address bar is showing — pushing its top off-screen.
            // dvh tracks the real, current visible viewport instead.
            maxHeight: isMobile ? '90dvh' : '92vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: isMobile ? 'column' : 'row',
            position: 'relative',
            boxShadow: '0 32px 80px rgba(var(--color-black-rgb), 0.22), 0 2px 8px rgba(var(--color-black-rgb), 0.08)',
            transition: isMobile ? undefined : 'max-width 320ms cubic-bezier(0.4,0,0.2,1)',
          }}>

          <AttachDropOverlay visible={dragging} subtitle="Files will be uploaded and attached to this item" />

          {/* Main column — everything the dialog already had, now wrapped so a
              change-history panel can sit beside it on desktop. */}
          <div style={{ flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* Priority accent stripe */}
          <div style={{ height: 3, background: priority ? PRIORITY_COLORS[priority] : 'var(--color-purple-pale-23)', flexShrink: 0, transition: 'background 200ms' }} />

          {/* Scrollable body */}
          <div style={{ overflowY: 'auto', flex: 1, padding: isMobile ? '20px 16px 24px' : '28px 32px 36px' }}>

            {/* Title row */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 26 }}>
              <div
                onClick={() => setChecked(c => !c)}
                style={{
                  width: 24, height: 24, minWidth: 24, borderRadius: 7,
                  border: `2px solid ${checked ? 'var(--color-primary)' : 'var(--color-border-strong)'}`,
                  background: checked ? 'var(--color-primary)' : 'transparent',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all 150ms', marginTop: 4, flexShrink: 0,
                }}>
                {checked && <Checkmark />}
              </div>

              <textarea
                ref={titleRef}
                value={title}
                onChange={e => { setTitle(e.target.value); resizeTA(e.target); }}
                style={{
                  flex: 1, fontFamily: 'var(--font-heading)', fontSize: 22, fontWeight: 700,
                  color: 'var(--color-text-primary)', background: 'transparent', border: 'none', outline: 'none',
                  resize: 'none', lineHeight: 1.3, padding: 0, overflowY: 'hidden',
                  textDecoration: checked ? 'line-through' : 'none',
                  opacity: checked ? 0.4 : 1, transition: 'opacity 200ms',
                }}
                rows={1}
              />

              <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginTop: 2 }}>
                {isListTask && (
                  <button
                    onClick={() => setShowChangelog(v => !v)}
                    title={showChangelog ? 'Hide change history' : 'View change history'}
                    style={{ width: 34, height: 34, borderRadius: 9, background: showChangelog ? 'var(--color-surface-tint)' : 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 120ms' }}
                    onMouseEnter={e => { if (!showChangelog) e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
                    onMouseLeave={e => { if (!showChangelog) e.currentTarget.style.background = 'transparent'; }}>
                    <Icon name="manage_history" size={17} color={showChangelog ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                  </button>
                )}
                <button
                  onClick={() => setShowDelete(true)}
                  title="Delete task"
                  style={{ width: 34, height: 34, borderRadius: 9, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 120ms' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-error-bg)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <Icon name="delete" size={17} color="var(--color-error)" />
                </button>
                <button
                  onClick={onClose}
                  title="Close"
                  style={{ width: 34, height: 34, borderRadius: 9, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 120ms' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-tint)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <Icon name="close" size={18} color="var(--color-text-tertiary)" />
                </button>
              </div>
            </div>

            {/* Properties panel */}
            <div style={{ background: 'var(--color-surface-tint-3)', borderRadius: 12, marginBottom: 28, border: '1px solid var(--color-purple-pale-23)' }}>
              <PropRow icon="calendar_today" label="Due date" first>
                <div style={{ display: 'inline-flex', alignItems: 'center' }}>
                  <button
                    ref={calBtnRef}
                    onClick={() => {
                      const rect = calBtnRef.current?.getBoundingClientRect();
                      if (rect) setCalPos({ top: rect.bottom + 6, left: rect.left });
                      setShowCal(c => !c);
                    }}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      background: deadline ? 'var(--color-surface-tint)' : 'transparent',
                      border: `1px solid ${deadline ? 'var(--color-accent-purple-soft-alt)' : 'transparent'}`,
                      borderRadius: 8, padding: '5px 10px', cursor: 'pointer', transition: 'all 120ms',
                    }}
                    onMouseEnter={e => { if (!deadline) { (e.currentTarget.style.background = 'var(--color-surface-tint)'); (e.currentTarget.style.borderColor = 'var(--color-purple-pale-44)'); } }}
                    onMouseLeave={e => { if (!deadline) { (e.currentTarget.style.background = 'transparent'); (e.currentTarget.style.borderColor = 'transparent'); } }}>
                    <Icon name="calendar_today" size={13} color={deadline ? 'var(--color-primary)' : 'var(--color-border-strong)'} />
                    <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: deadline ? 'var(--color-primary)' : 'var(--color-border-strong)', fontWeight: deadline ? 500 : 400 }}>
                      {deadline ? friendlyDate(deadline) : 'No date'}
                    </span>
                  </button>
                  {deadline && (
                    <button
                      onClick={() => { setDeadline(''); setShowCal(false); }}
                      style={{ marginLeft: 4, background: 'none', border: 'none', cursor: 'pointer', padding: 3, display: 'inline-flex', alignItems: 'center' }}>
                      <Icon name="close" size={12} color="var(--color-purple-tint-11)" />
                    </button>
                  )}
                </div>
              </PropRow>

              <PropRow icon="flag" label="Priority">
                <div style={{ display: 'flex', gap: 6 }}>
                  {PRIORITIES.map(p => (
                    <button key={p}
                      onClick={() => setPriority(prev => (prev === p ? '' : p))}
                      style={{
                        padding: '4px 12px', borderRadius: 8,
                        border: `1px solid ${priority === p ? PRIORITY_COLORS[p] : 'var(--color-border-alt)'}`,
                        background: priority === p ? `${PRIORITY_COLORS[p]}18` : 'transparent',
                        fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600,
                        color: priority === p ? PRIORITY_COLORS[p] : 'var(--color-text-tertiary)',
                        cursor: 'pointer', transition: 'all 120ms',
                      }}>
                      {p}
                    </button>
                  ))}
                </div>
              </PropRow>

              {/* Tagged users — replaces the old badge chips AND the Owner row.
                  Defaults to the item creator (shown as the "Owner" chip); the
                  owner can tag other workspace members, who get notified. */}
              {/* Timeline / In list / Relations are desktop-only — they push the
                  card too tall for a mobile viewport and aren't essential for
                  a quick mobile edit; see the change-history panel above and
                  the Net (/graph) for the full picture. */}
              <PropRow icon="group" label="Tag" last={isMobile}>
                <TaggedUsersRow
                  taskId={task.id}
                  workspaceId={taskWorkspaceId}
                  listId={isListTask ? task._listId : null}
                  creatorId={task.creatorId}
                  canEdit={canEditTags}
                  members={wsMembers}
                />
              </PropRow>

              {!isMobile && (
                <PropRow icon="history" label="Timeline">
                  <TaskMiniTimeline createdAt={task.createdAt} completedAt={task.completedAt} checked={task.checked} />
                </PropRow>
              )}

              {!isMobile && task._listName && (
                <PropRow icon="format_list_bulleted" label="In list">
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-secondary)' }}>{task._listName}</span>
                </PropRow>
              )}

              {!isMobile && (
                <PropRow icon="hub" label="Relations" last>
                  <RelationsPanel entityType="task" entityId={String(task.id)} workspaceId={taskWorkspaceId ?? undefined} compact />
                </PropRow>
              )}
            </div>

            {/* Change history — mobile only; desktop gets the side panel instead. */}
            {isMobile && isListTask && (
              <TaskChangeHistory task={task} listId={task._listId!} open={showChangelog} variant="inline" />
            )}

            {/* Notes */}
            <div style={{ marginBottom: 28 }}>
              <NotesEditor
                value={notes}
                onChange={setNotes}
                minHeight={160}
                mentionMembers={mentionMembers}
                aiContext={{
                  kind: 'task',
                  title,
                  fields: {
                    Status: checked ? 'Completed' : 'Open',
                    Deadline: deadline || undefined,
                    Priority: priority || undefined,
                    Tag: task.badge || undefined,
                    List: task._listName,
                  },
                }}
              />
            </div>

            {/* Divider */}
            <div style={{ height: 1, background: 'var(--color-purple-pale-23)', marginBottom: 24 }} />

            {/* Attachments */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <SectionLabel>Attachments{attachments.length > 0 && <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 400, color: 'var(--color-border-strong)', textTransform: 'none', letterSpacing: 0, marginLeft: 6 }}>{attachments.length}</span>}</SectionLabel>
              </div>

              {/* Attachment rows */}
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
                  <button
                    onClick={() => handleDownloadAttachment(att)}
                    disabled={downloadingAttId === att.id}
                    title="Download"
                    style={{ width: 28, height: 28, borderRadius: 7, border: 'none', background: 'transparent', cursor: downloadingAttId === att.id ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                    onMouseEnter={e => { if (downloadingAttId !== att.id) e.currentTarget.style.background = 'var(--color-surface-tint)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                    {downloadingAttId === att.id
                      ? <div style={{ width: 12, height: 12, border: '2px solid var(--color-accent-purple-soft-alt)', borderTopColor: 'var(--color-primary)', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
                      : <Icon name="download" size={15} color="var(--color-primary)" />}
                  </button>
                  <button
                    onClick={() => handleRemoveAttachment(att)}
                    disabled={removingAttId === att.id}
                    title="Remove"
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

              {/* Upload progress row */}
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

              {/* Action buttons */}
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadProgress !== null}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: '1.5px dashed var(--color-blue-tint-3)', borderRadius: 9, padding: '7px 14px', cursor: uploadProgress !== null ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)', transition: 'all 120ms', opacity: uploadProgress !== null ? 0.5 : 1 }}
                  onMouseEnter={e => { if (uploadProgress === null) { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.color = 'var(--color-primary)'; e.currentTarget.style.background = 'var(--color-surface-tint-3)'; } }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-blue-tint-3)'; e.currentTarget.style.color = 'var(--color-text-tertiary)'; e.currentTarget.style.background = 'transparent'; }}>
                  <Icon name="upload" size={14} color="currentColor" />
                  Upload file
                </button>
                <button
                  onClick={() => setShowFilePicker(true)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: '1.5px dashed var(--color-blue-tint-3)', borderRadius: 9, padding: '7px 14px', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)', transition: 'all 120ms' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.color = 'var(--color-primary)'; e.currentTarget.style.background = 'var(--color-surface-tint-3)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-blue-tint-3)'; e.currentTarget.style.color = 'var(--color-text-tertiary)'; e.currentTarget.style.background = 'transparent'; }}>
                  <Icon name="folder_open" size={14} color="currentColor" />
                  Attach from Files
                </button>
              </div>

              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); e.target.value = ''; }}
              />
            </div>

            {/* Divider */}
            <div style={{ height: 1, background: 'var(--color-purple-pale-23)', marginBottom: 24 }} />

            {/* Sub-items */}
            <div style={{ minHeight: 120 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                <SectionLabel>Sub-items</SectionLabel>
                {subItems.length > 0 && (
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-border-strong)' }}>
                    {subItems.filter(t => t.checked).length}/{subItems.length}
                  </span>
                )}
                {creatingList && (
                  <div style={{ width: 13, height: 13, borderRadius: '50%', border: '2px solid var(--color-primary)', borderTopColor: 'transparent', animation: 'spin 0.6s linear infinite' }} />
                )}
              </div>

              {subItems.map(sub => (
                <div key={sub.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--color-surface-tint-3)' }}>
                  <div
                    onClick={() => linkedListId && updateListTask(linkedListId, sub.id, { checked: !sub.checked })}
                    style={{
                      width: 18, height: 18, minWidth: 18, borderRadius: 5,
                      border: `1.5px solid ${sub.checked ? 'var(--color-primary)' : 'var(--color-border-strong)'}`,
                      background: sub.checked ? 'var(--color-primary)' : 'transparent',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      transition: 'all 150ms', flexShrink: 0,
                    }}>
                    {sub.checked && <SmallCheck />}
                  </div>
                  <span style={{
                    fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-secondary)', flex: 1,
                    textDecoration: sub.checked ? 'line-through' : 'none',
                    opacity: sub.checked ? 0.45 : 1,
                  }}>
                    {sub.title}
                  </span>
                </div>
              ))}

              {addingSubItem ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', marginTop: subItems.length > 0 ? 4 : 0 }}>
                  <div style={{ width: 18, height: 18, minWidth: 18, borderRadius: 5, border: '1.5px dashed var(--color-border-strong)', flexShrink: 0 }} />
                  <input
                    autoFocus
                    value={newSubItem}
                    onChange={e => setNewSubItem(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); handleAddSubItem(); }
                      if (e.key === 'Escape') { setAddingSubItem(false); setNewSubItem(''); }
                    }}
                    onBlur={() => { if (!newSubItem.trim()) setAddingSubItem(false); else handleAddSubItem(); }}
                    placeholder="New sub-item…"
                    style={{ flex: 1, fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-secondary)', background: 'transparent', border: 'none', outline: 'none', padding: 0 }}
                  />
                </div>
              ) : (
                <button
                  onClick={() => setAddingSubItem(true)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    marginTop: subItems.length > 0 ? 8 : 0,
                    background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 0',
                    opacity: 0.55, transition: 'opacity 150ms',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                  onMouseLeave={e => (e.currentTarget.style.opacity = '0.55')}>
                  <Icon name="add" size={16} color="var(--color-primary)" />
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-primary)' }}>Add sub-item</span>
                </button>
              )}
            </div>
          </div>

          {/* Footer — explicit save / cancel */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 32px', borderTop: '1px solid var(--color-surface-tint-2)', flexShrink: 0 }}>
            <button onClick={onClose}
              style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '9px 18px', cursor: 'pointer' }}>
              Cancel
            </button>
            <button onClick={handleSave} disabled={!title.trim()}
              style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: title.trim() ? 'var(--color-primary)' : 'var(--color-border-strong)', border: 'none', borderRadius: 8, padding: '9px 22px', cursor: title.trim() ? 'pointer' : 'default' }}>
              Save
            </button>
          </div>
          </div>
          {/* Change-history panel — desktop only (mobile shows it inline in the
              scrollable body instead). Always mounted so TaskChangeHistory's
              lazy fetch only ever fires once; width animates 0 <-> 320. */}
          {!isMobile && isListTask && (
            <div style={{
              width: showChangelog ? 320 : 0, flexShrink: 0, overflow: 'hidden',
              borderLeft: '1px solid', borderLeftColor: showChangelog ? 'var(--color-surface-tint-2)' : 'transparent',
              transition: 'width 320ms cubic-bezier(0.4,0,0.2,1), border-color 320ms',
            }}>
              <div style={{ width: 320, height: '100%', flexShrink: 0 }}>
                <TaskChangeHistory task={task} listId={task._listId!} open={showChangelog} variant="panel" />
              </div>
            </div>
          )}
        </motion.div>
      </motion.div>

      {/* File picker modal */}
      <AnimatePresence>
        {showFilePicker && (
          <FilePicker
            key="file-picker"
            onSelect={handleLinkFile}
            onClose={() => setShowFilePicker(false)}
          />
        )}
      </AnimatePresence>

      {/* Calendar portaled to <body> so position:fixed is relative to the
          viewport, not the transformed modal card — keeps it under the button. */}
      {showCal && calPos && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 1350 }} onClick={() => setShowCal(false)} />
          <div style={{ position: 'fixed', top: calPos.top, left: calPos.left, zIndex: 1400 }}>
            <CalendarPicker
              value={deadline}
              onChange={d => { setDeadline(d); setShowCal(false); }}
              onClear={() => { setDeadline(''); setShowCal(false); }}
            />
          </div>
        </>,
        document.body
      )}

      {showDelete && (
        <DeleteConfirmModal
          task={{ ...task, title }}
          onConfirm={() => { onDelete(task.id); setShowDelete(false); onClose(); }}
          onCancel={() => setShowDelete(false)}
        />
      )}

      {previewAtt && (
        <AttachmentPreviewModal
          name={previewAtt.name}
          mimeType={previewAtt.mimeType}
          fetchBlob={() => apiTaskAttachmentBlob(task.id, previewAtt.id, previewAtt.mimeType)}
          onDownload={() => handleDownloadAttachment(previewAtt)}
          onClose={() => setPreviewAtt(null)}
        />
      )}
    </>,
    document.body
  );
}

function PropRow({ icon, label, children, last = false, first = false }: { icon: string; label: string; children: React.ReactNode; last?: boolean; first?: boolean }) {
  const isMobile = useMobile();
  return (
    <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'flex-start' : 'center', padding: isMobile ? '10px 12px' : '11px 16px', borderBottom: last ? 'none' : '1px solid rgba(var(--color-border-alt-rgb), 0.5)', borderRadius: first ? '11px 11px 0 0' : last ? '0 0 11px 11px' : 0, gap: isMobile ? 4 : 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: isMobile ? 'auto' : 130, flexShrink: 0 }}>
        <Icon name={icon} size={14} color="var(--color-purple-tint-11)" />
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)' }}>{label}</span>
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
        {children}
      </div>
    </div>
  );
}

/** Compact single-row "created → done" visual, auto-filled and read-only —
 *  used inside the Timeline PropRow. Reflects the persisted task, not the
 *  dialog's buffered (unsaved) checked/edit state. */
function TaskMiniTimeline({ createdAt, completedAt, checked }: { createdAt?: string; completedAt?: string | null; checked: boolean }) {
  const isMobile = useMobile();
  const durationMs = checked && createdAt && completedAt
    ? new Date(completedAt).getTime() - new Date(createdAt).getTime()
    : null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 12, width: '100%', flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--color-primary)', flexShrink: 0 }} />
          <span style={{ fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600, color: 'var(--color-accent-purple-light)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Created</span>
        </div>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-secondary)', paddingLeft: 12 }}>{formatDateTime(createdAt)}</span>
      </div>

      <div style={{
        flex: isMobile ? '0 0 100%' : 1, order: isMobile ? 3 : 0, minWidth: 24, height: 3, borderRadius: 2,
        background: checked ? 'var(--color-primary)' : 'repeating-linear-gradient(90deg, var(--color-purple-tint-6) 0 4px, transparent 4px 8px)',
      }} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: checked ? 'var(--color-success)' : 'transparent', border: checked ? 'none' : '1.5px solid var(--color-border-strong)', flexShrink: 0 }} />
          <span style={{ fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600, color: checked ? 'var(--color-success)' : 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Done</span>
        </div>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: checked ? 'var(--color-text-secondary)' : 'var(--color-text-quaternary)', paddingLeft: 12 }}>
          {checked ? formatDateTime(completedAt) : 'In progress'}
        </span>
      </div>

      {durationMs !== null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, marginLeft: isMobile ? 0 : 'auto', background: 'var(--color-surface-tint)', borderRadius: 999, padding: '3px 9px' }}>
          <Icon name="schedule" size={11} color="var(--color-primary)" />
          <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 600, color: 'var(--color-primary)' }}>{formatDuration(durationMs)}</span>
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, color: 'var(--color-border-strong)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.08em', display: 'inline-block' }}>
      {children}
    </div>
  );
}
