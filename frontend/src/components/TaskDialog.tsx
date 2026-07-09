import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { Task, TaskAttachment, SharedFile } from '../types';
import Icon from './Icon';
import { useMobile } from '../hooks/useBreakpoint';
import CalendarPicker from './CalendarPicker';
import CreatorBubble from './CreatorBubble';
import NotesEditor from './NotesEditor';
import { DeleteConfirmModal } from './TaskItem';
import useAppStore from '../store/useAppStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import useMembersStore from '../store/useMembersStore';
import {
  apiCreateList, apiCreateSection, apiAddListTask, apiUpdateTask, apiUpdateListTask,
  apiGetTaskAttachments, apiUploadTaskAttachment, apiLinkTaskAttachment, apiDeleteTaskAttachment, apiDownloadTaskAttachment,
  apiGetFiles,
} from '../api/client';

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
  if (mime.includes('pdf'))   return '#dc2626';
  if (mime.includes('image')) return '#2563eb';
  if (mime.includes('video')) return '#7c3aed';
  if (mime.includes('zip'))   return '#d97706';
  return '#5e4dbb';
}

export function AttachBadge({ mime }: { mime: string }) {
  return (
    <div style={{ width: 34, height: 34, borderRadius: 8, background: '#F9FAFB', border: '1px solid #E5E7EB', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexShrink: 0, position: 'relative', overflow: 'hidden' }}>
      <Icon name="description" size={17} color="#d1d5db" />
      <div style={{ position: 'absolute', bottom: 2, left: '50%', transform: 'translateX(-50%)', background: attMimeColor(mime), color: '#fff', fontFamily: 'Inter, sans-serif', fontSize: 6, fontWeight: 800, padding: '1px 3px', borderRadius: 2 }}>{attMimeLabel(mime)}</div>
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
  if (!visible) return null;
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 30, background: 'rgba(250,249,255,0.94)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', animation: 'backdropIn 160ms ease both', padding: 24 }}>
      <div style={{ border: '2px dashed #5e4dbb', borderRadius: 16, background: '#F5F3FF', padding: '30px 46px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, boxShadow: '0 8px 40px rgba(94,77,187,0.10)', maxWidth: '100%' }}>
        <div style={{ width: 50, height: 50, borderRadius: 14, background: '#5e4dbb', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="upload_file" size={26} color="#fff" />
        </div>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 700, color: '#1c1b22', textAlign: 'center' }}>Drop files to attach</div>
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', textAlign: 'center' }}>{subtitle}</div>
      </div>
    </div>
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
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1500, background: 'rgba(0,0,0,0.32)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: '#fff', borderRadius: 18, width: '100%', maxWidth: 480, maxHeight: '70vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 60px rgba(0,0,0,0.22)', animation: 'modalIn 240ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 18px 14px', borderBottom: '1px solid #F0EEF8', flexShrink: 0 }}>
          <Icon name="folder_open" size={18} color="#5e4dbb" />
          <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 700, color: '#1c1b22', flex: 1 }}>Attach from Files</span>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#F5F3FF')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <Icon name="close" size={16} color="#787584" />
          </button>
        </div>
        {/* Search */}
        <div style={{ padding: '10px 18px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 9, padding: '7px 12px' }}>
            <Icon name="search" size={15} color="#b0acbe" />
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search files…"
              style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#1c1b22', background: 'transparent', border: 'none', outline: 'none' }}
            />
          </div>
        </div>
        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 10px 12px' }}>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 28 }}>
              <div style={{ width: 22, height: 22, border: '2.5px solid #e8e4f0', borderTopColor: '#5e4dbb', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: 'center', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe', padding: '28px 16px' }}>{search ? 'No matching files' : 'No files uploaded yet'}</div>
          ) : (
            filtered.map(f => (
              <button
                key={f.id}
                disabled={picking === f.id}
                onClick={() => { setPickingId(f.id); onSelect(f); }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '9px 10px', borderRadius: 10, border: 'none', background: picking === f.id ? '#F5F3FF' : 'transparent', cursor: picking === f.id ? 'default' : 'pointer', textAlign: 'left', transition: 'background 120ms' }}
                onMouseEnter={e => { if (picking !== f.id) e.currentTarget.style.background = '#faf9ff'; }}
                onMouseLeave={e => { if (picking !== f.id) e.currentTarget.style.background = 'transparent'; }}
              >
                <AttachBadge mime={f.mimeType} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.title || f.name}</div>
                  <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', marginTop: 1 }}>{fmtAttSize(f.size)}</div>
                </div>
                {picking === f.id && (
                  <div style={{ width: 14, height: 14, border: '2px solid #c4b5fd', borderTopColor: '#5e4dbb', borderRadius: '50%', animation: 'spin 0.6s linear infinite', flexShrink: 0 }} />
                )}
                {picking !== f.id && <Icon name="add" size={16} color="#c9c4d5" />}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

const PRIORITIES = ['High', 'Medium', 'Low'] as const;
const PRIORITY_COLORS: Record<string, string> = { High: '#ea580c', Medium: '#f59e0b', Low: '#787584' };
const BADGE_COLORS: Record<string, { bg: string; color: string }> = {
  Work: { bg: '#f9e287', color: '#6e5e0d' },
  Personal: { bg: '#F5F3FF', color: '#5e4dbb' },
  Urgent: { bg: '#ffdad6', color: '#ba1a1a' },
  Tip: { bg: '#eff6ff', color: '#1D4ED8' },
};
const TAGS = ['Work', 'Personal', 'Urgent', 'Tip'] as const;

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
  /** When the containing list is public (workspace-visible), show an Owner row. */
  isPublic?: boolean;
}

export default function TaskDialog({ task, onUpdate, onDelete, onClose, isPublic }: TaskDialogProps) {
  const isMobile = useMobile();
  const owner = useMembersStore(s => (task.creatorId ? s.members[task.creatorId] : undefined));
  const showOwner = Boolean(isPublic && task.creatorId);
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.note ?? '');
  const [notesMarkdown, setNotesMarkdown] = useState(task.noteMarkdown ?? false);
  const [deadline, setDeadline] = useState(task.deadline ?? '');
  const [priority, setPriority] = useState<string>(task.priority ?? '');
  const [tag, setTag] = useState(task.badge ?? '');
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

  // "Delete open item / milestone" shortcut — same as the delete icon button.
  useEffect(() => {
    const onDeleteShortcut = () => setShowDelete(true);
    window.addEventListener('shortcut:delete-current', onDeleteShortcut);
    return () => window.removeEventListener('shortcut:delete-current', onDeleteShortcut);
  }, []);

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
    if ((tag || '') !== (task.badge ?? '')) updates.badge = tag || undefined;
    if ((notes || '') !== (task.note ?? '')) updates.note = notes || undefined;
    if (notesMarkdown !== (task.noteMarkdown ?? false)) updates.noteMarkdown = notesMarkdown;
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
        const res = await apiCreateList({ id: newListId, name: title, color: '#5e4dbb', isPublic: false, workspaceId, parentTaskId: task.id, depth: newDepth });
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
            color: '#5e4dbb',
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
      <div
        ref={backdropRef}
        onClick={e => { if (e.target === backdropRef.current) onClose(); }}
        style={{
          position: 'fixed', inset: 0, zIndex: 1200,
          background: 'rgba(0,0,0,0.28)', backdropFilter: 'blur(6px)',
          display: 'flex',
          alignItems: isMobile ? 'flex-end' : 'center',
          justifyContent: 'center',
          padding: isMobile ? 0 : '24px 20px',
        }}>

        <div
          onClick={e => e.stopPropagation()}
          {...dropHandlers}
          style={{
            background: '#fff',
            borderRadius: isMobile ? '16px 16px 0 0' : 18,
            width: '100%',
            maxWidth: isMobile ? undefined : 800,
            maxHeight: isMobile ? '94vh' : '92vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
            boxShadow: '0 32px 80px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.08)',
            animation: isMobile ? 'slideUp 280ms cubic-bezier(0.22,1,0.36,1) both' : 'modalIn 260ms cubic-bezier(0.34,1.56,0.64,1) both',
          }}>

          <AttachDropOverlay visible={dragging} subtitle="Files will be uploaded and attached to this item" />

          {/* Priority accent stripe */}
          <div style={{ height: 3, background: priority ? PRIORITY_COLORS[priority] : '#F0EEF8', flexShrink: 0, transition: 'background 200ms' }} />

          {/* Scrollable body */}
          <div style={{ overflowY: 'auto', flex: 1, padding: isMobile ? '20px 16px 24px' : '28px 32px 36px' }}>

            {/* Title row */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 26 }}>
              <div
                onClick={() => setChecked(c => !c)}
                style={{
                  width: 24, height: 24, minWidth: 24, borderRadius: 7,
                  border: `2px solid ${checked ? '#5e4dbb' : '#c9c4d5'}`,
                  background: checked ? '#5e4dbb' : 'transparent',
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
                  flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 22, fontWeight: 700,
                  color: '#1c1b22', background: 'transparent', border: 'none', outline: 'none',
                  resize: 'none', lineHeight: 1.3, padding: 0, overflowY: 'hidden',
                  textDecoration: checked ? 'line-through' : 'none',
                  opacity: checked ? 0.4 : 1, transition: 'opacity 200ms',
                }}
                rows={1}
              />

              <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginTop: 2 }}>
                <button
                  onClick={() => setShowDelete(true)}
                  title="Delete task"
                  style={{ width: 34, height: 34, borderRadius: 9, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 120ms' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#ffdad6')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <Icon name="delete" size={17} color="#ba1a1a" />
                </button>
                <button
                  onClick={onClose}
                  title="Close"
                  style={{ width: 34, height: 34, borderRadius: 9, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 120ms' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#F5F3FF')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <Icon name="close" size={18} color="#787584" />
                </button>
              </div>
            </div>

            {/* Properties panel */}
            <div style={{ background: '#faf9ff', borderRadius: 12, marginBottom: 28, border: '1px solid #F0EEF8' }}>
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
                      background: deadline ? '#F5F3FF' : 'transparent',
                      border: `1px solid ${deadline ? '#c4b5fd' : 'transparent'}`,
                      borderRadius: 8, padding: '5px 10px', cursor: 'pointer', transition: 'all 120ms',
                    }}
                    onMouseEnter={e => { if (!deadline) { (e.currentTarget.style.background = '#F5F3FF'); (e.currentTarget.style.borderColor = '#e2d9f3'); } }}
                    onMouseLeave={e => { if (!deadline) { (e.currentTarget.style.background = 'transparent'); (e.currentTarget.style.borderColor = 'transparent'); } }}>
                    <Icon name="calendar_today" size={13} color={deadline ? '#5e4dbb' : '#c9c4d5'} />
                    <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: deadline ? '#5e4dbb' : '#c9c4d5', fontWeight: deadline ? 500 : 400 }}>
                      {deadline ? friendlyDate(deadline) : 'No date'}
                    </span>
                  </button>
                  {deadline && (
                    <button
                      onClick={() => { setDeadline(''); setShowCal(false); }}
                      style={{ marginLeft: 4, background: 'none', border: 'none', cursor: 'pointer', padding: 3, display: 'inline-flex', alignItems: 'center' }}>
                      <Icon name="close" size={12} color="#b9b3cb" />
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
                        border: `1px solid ${priority === p ? PRIORITY_COLORS[p] : '#E5E7EB'}`,
                        background: priority === p ? `${PRIORITY_COLORS[p]}18` : 'transparent',
                        fontFamily: 'Inter, sans-serif', fontSize: 12, fontWeight: 600,
                        color: priority === p ? PRIORITY_COLORS[p] : '#787584',
                        cursor: 'pointer', transition: 'all 120ms',
                      }}>
                      {p}
                    </button>
                  ))}
                </div>
              </PropRow>

              <PropRow icon="label" label="Tag" last={!task._listName && !showOwner}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {TAGS.map(t => {
                    const c = BADGE_COLORS[t];
                    const active = tag === t;
                    return (
                      <button key={t}
                        onClick={() => setTag(prev => (prev === t ? '' : t))}
                        style={{
                          padding: '4px 12px', borderRadius: 9999,
                          border: `1px solid ${active ? c.color : '#E5E7EB'}`,
                          background: active ? c.bg : 'transparent',
                          fontFamily: 'Inter, sans-serif', fontSize: 12, fontWeight: 600,
                          color: active ? c.color : '#787584',
                          cursor: 'pointer', transition: 'all 120ms',
                        }}>
                        {t}
                      </button>
                    );
                  })}
                </div>
              </PropRow>

              {task._listName && (
                <PropRow icon="format_list_bulleted" label="In list" last={!showOwner}>
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#484552' }}>{task._listName}</span>
                </PropRow>
              )}

              {showOwner && task.creatorId && (
                <PropRow icon="account_circle" label="Owner" last>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <CreatorBubble creatorId={task.creatorId} taskHovered />
                    <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#484552' }}>
                      {owner ? (owner.fullName || owner.username) : 'Unknown'}
                    </span>
                  </div>
                </PropRow>
              )}
            </div>

            {/* Notes */}
            <div style={{ marginBottom: 28 }}>
              <NotesEditor
                value={notes}
                onChange={setNotes}
                markdown={notesMarkdown}
                onMarkdownChange={setNotesMarkdown}
                minHeight={160}
              />
            </div>

            {/* Divider */}
            <div style={{ height: 1, background: '#F0EEF8', marginBottom: 24 }} />

            {/* Attachments */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <SectionLabel>Attachments{attachments.length > 0 && <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 400, color: '#c9c4d5', textTransform: 'none', letterSpacing: 0, marginLeft: 6 }}>{attachments.length}</span>}</SectionLabel>
              </div>

              {/* Attachment rows */}
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
                  <button
                    onClick={() => handleDownloadAttachment(att)}
                    disabled={downloadingAttId === att.id}
                    title="Download"
                    style={{ width: 28, height: 28, borderRadius: 7, border: 'none', background: 'transparent', cursor: downloadingAttId === att.id ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                    onMouseEnter={e => { if (downloadingAttId !== att.id) e.currentTarget.style.background = '#F5F3FF'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                    {downloadingAttId === att.id
                      ? <div style={{ width: 12, height: 12, border: '2px solid #c4b5fd', borderTopColor: '#5e4dbb', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
                      : <Icon name="download" size={15} color="#5e4dbb" />}
                  </button>
                  <button
                    onClick={() => handleRemoveAttachment(att)}
                    disabled={removingAttId === att.id}
                    title="Remove"
                    style={{ width: 28, height: 28, borderRadius: 7, border: 'none', background: 'transparent', cursor: removingAttId === att.id ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                    onMouseEnter={e => { if (removingAttId !== att.id) e.currentTarget.style.background = '#ffdad6'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                    {removingAttId === att.id
                      ? <div style={{ width: 12, height: 12, border: '2px solid #e87575', borderTopColor: '#ba1a1a', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
                      : <Icon name="close" size={14} color="#ba1a1a" />}
                  </button>
                </div>
              ))}

              {/* Upload progress row */}
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

              {/* Action buttons */}
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadProgress !== null}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: '1.5px dashed #d1d5db', borderRadius: 9, padding: '7px 14px', cursor: uploadProgress !== null ? 'not-allowed' : 'pointer', fontFamily: 'Inter, sans-serif', fontSize: 12, fontWeight: 600, color: '#787584', transition: 'all 120ms', opacity: uploadProgress !== null ? 0.5 : 1 }}
                  onMouseEnter={e => { if (uploadProgress === null) { e.currentTarget.style.borderColor = '#5e4dbb'; e.currentTarget.style.color = '#5e4dbb'; e.currentTarget.style.background = '#faf9ff'; } }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = '#d1d5db'; e.currentTarget.style.color = '#787584'; e.currentTarget.style.background = 'transparent'; }}>
                  <Icon name="upload" size={14} color="currentColor" />
                  Upload file
                </button>
                <button
                  onClick={() => setShowFilePicker(true)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: '1.5px dashed #d1d5db', borderRadius: 9, padding: '7px 14px', cursor: 'pointer', fontFamily: 'Inter, sans-serif', fontSize: 12, fontWeight: 600, color: '#787584', transition: 'all 120ms' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = '#5e4dbb'; e.currentTarget.style.color = '#5e4dbb'; e.currentTarget.style.background = '#faf9ff'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = '#d1d5db'; e.currentTarget.style.color = '#787584'; e.currentTarget.style.background = 'transparent'; }}>
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
            <div style={{ height: 1, background: '#F0EEF8', marginBottom: 24 }} />

            {/* Sub-items */}
            <div style={{ minHeight: 120 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                <SectionLabel>Sub-items</SectionLabel>
                {subItems.length > 0 && (
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#c9c4d5' }}>
                    {subItems.filter(t => t.checked).length}/{subItems.length}
                  </span>
                )}
                {creatingList && (
                  <div style={{ width: 13, height: 13, borderRadius: '50%', border: '2px solid #5e4dbb', borderTopColor: 'transparent', animation: 'spin 0.6s linear infinite' }} />
                )}
              </div>

              {subItems.map(sub => (
                <div key={sub.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid #faf9ff' }}>
                  <div
                    onClick={() => linkedListId && updateListTask(linkedListId, sub.id, { checked: !sub.checked })}
                    style={{
                      width: 18, height: 18, minWidth: 18, borderRadius: 5,
                      border: `1.5px solid ${sub.checked ? '#5e4dbb' : '#c9c4d5'}`,
                      background: sub.checked ? '#5e4dbb' : 'transparent',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      transition: 'all 150ms', flexShrink: 0,
                    }}>
                    {sub.checked && <SmallCheck />}
                  </div>
                  <span style={{
                    fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#484552', flex: 1,
                    textDecoration: sub.checked ? 'line-through' : 'none',
                    opacity: sub.checked ? 0.45 : 1,
                  }}>
                    {sub.title}
                  </span>
                </div>
              ))}

              {addingSubItem ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', marginTop: subItems.length > 0 ? 4 : 0 }}>
                  <div style={{ width: 18, height: 18, minWidth: 18, borderRadius: 5, border: '1.5px dashed #c9c4d5', flexShrink: 0 }} />
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
                    style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#484552', background: 'transparent', border: 'none', outline: 'none', padding: 0 }}
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
                  <Icon name="add" size={16} color="#5e4dbb" />
                  <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#5e4dbb' }}>Add sub-item</span>
                </button>
              )}
            </div>
          </div>

          {/* Footer — explicit save / cancel */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 32px', borderTop: '1px solid #f1ecf6', flexShrink: 0 }}>
            <button onClick={onClose}
              style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: '1px solid #E5E7EB', borderRadius: 8, padding: '9px 18px', cursor: 'pointer' }}>
              Cancel
            </button>
            <button onClick={handleSave} disabled={!title.trim()}
              style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: title.trim() ? '#5e4dbb' : '#c9c4d5', border: 'none', borderRadius: 8, padding: '9px 22px', cursor: title.trim() ? 'pointer' : 'default' }}>
              Save
            </button>
          </div>
        </div>
      </div>

      {/* File picker modal */}
      {showFilePicker && (
        <FilePicker
          onSelect={handleLinkFile}
          onClose={() => setShowFilePicker(false)}
        />
      )}

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
    </>,
    document.body
  );
}

function PropRow({ icon, label, children, last = false, first = false }: { icon: string; label: string; children: React.ReactNode; last?: boolean; first?: boolean }) {
  const isMobile = useMobile();
  return (
    <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'flex-start' : 'center', padding: isMobile ? '10px 12px' : '11px 16px', borderBottom: last ? 'none' : '1px solid rgba(229,231,235,0.5)', borderRadius: first ? '11px 11px 0 0' : last ? '0 0 11px 11px' : 0, gap: isMobile ? 4 : 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: isMobile ? 'auto' : 130, flexShrink: 0 }}>
        <Icon name={icon} size={14} color="#b9b3cb" />
        <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584' }}>{label}</span>
      </div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
        {children}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 700, color: '#c9c4d5', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.08em', display: 'inline-block' }}>
      {children}
    </div>
  );
}
