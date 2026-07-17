import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { List, Folder, Timeline, GpsFile, MarkdownList } from '../types';
import Icon from './Icon';
import useAppStore from '../store/useAppStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import useInstalledAppsStore from '../store/useInstalledAppsStore';
import useMarkdownListsStore from '../store/useMarkdownListsStore';
import WorkspaceWizard from '../modals/WorkspaceWizard';
import WorkspaceSettingsModal from '../modals/WorkspaceSettingsModal';
import ItemSettingsModal, { type ItemSettingsUpdates } from '../modals/ItemSettingsModal';
import MoveToWorkspaceModal from '../modals/MoveToWorkspaceModal';
import ContextMenu, { type ContextMenuEntry } from './ContextMenu';
import RenameDialog from './RenameDialog';
import { apiGetGpsFiles, apiReorderTimelines, type ShareInfo } from '../api/client';

const MINI = 60;

// ── NavItem ──────────────────────────────────────────────────────────────────
interface NavItemProps {
  icon: string;
  label: string;
  active?: boolean;
  onClick: () => void;
  collapsed: boolean;
}
function NavItem({ icon, label, active, onClick, collapsed }: NavItemProps) {
  const [hov, setHov] = useState(false);
  const col = active ? 'var(--color-primary)' : 'var(--color-text-tertiary)';
  const bg = active ? 'var(--color-surface-tint)' : hov ? 'var(--color-surface-tint-2)' : 'transparent';
  return (
    <div style={{ position: 'relative' }}>
      <button title={collapsed ? label : undefined} onClick={onClick}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 10, padding: collapsed ? '8px 0' : '8px 10px', justifyContent: collapsed ? 'center' : 'flex-start', borderRadius: 8, cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: active ? 600 : 450, color: col, border: 'none', background: bg, width: '100%', transition: 'all 200ms' }}>
        <Icon name={icon} size={19} color={col} />
        {!collapsed && <span>{label}</span>}
      </button>
      {collapsed && hov && (
        <div style={{ position: 'fixed', left: MINI + 8, zIndex: 200, background: 'var(--color-text-primary)', color: 'var(--color-white)', borderRadius: 6, padding: '4px 10px', fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 500, pointerEvents: 'none', whiteSpace: 'nowrap' }}>
          {label}
        </div>
      )}
    </div>
  );
}

// ── ListItemRow ───────────────────────────────────────────────────────────────
interface ListItemRowProps {
  list: List;
  isActive: boolean;
  collapsed: boolean;
  indented?: boolean;
  dragOverId: string | null;
  folders: Folder[];
  isTaskDropTarget?: boolean;
  wasRecentlyDropped?: boolean;
  onNavigate: (path: string) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}
function ListItemRow({ list, isActive, collapsed, indented, dragOverId, folders, isTaskDropTarget, wasRecentlyDropped, onNavigate, onDragStart, onDragOver, onDragLeave, onDrop }: ListItemRowProps) {
  const [hov, setHov] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showMoveWorkspace, setShowMoveWorkspace] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const { deleteList, updateList, setLists } = useAppStore();
  const currentWorkspaceId = useWorkspaceStore(s => s.currentWorkspaceId);

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = menuBtnRef.current?.getBoundingClientRect();
    if (rect) setMenuPos({ top: rect.bottom + 4, left: rect.left });
    setMenuOpen(o => !o);
  };

  const openContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ top: e.clientY, left: e.clientX });
    setMenuOpen(true);
  };

  const handleRename = (v: string) => {
    const trimmed = v.trim();
    if (trimmed && trimmed !== list.name) updateList(list.id, { name: trimmed });
    setEditingName(false);
  };

  const handleDelete = () => {
    deleteList(list.id);
    setShowDeleteDialog(false);
    onNavigate('/dashboard');
  };

  const handleSettingsChange = (updates: ItemSettingsUpdates) => {
    // folderId: null clears the folder server-side; locally it behaves like undefined.
    updateList(list.id, updates as Partial<List>);
  };

  const menuItems: ContextMenuEntry[] = [
    { key: 'rename', label: 'Edit name', icon: 'edit', onClick: () => setEditingName(true) },
    { key: 'settings', label: 'More settings…', icon: 'tune', onClick: () => setShowSettings(true) },
    { key: 'move-ws', label: 'Move to workspace…', icon: 'drive_file_move', onClick: () => setShowMoveWorkspace(true) },
    { key: 'div1', divider: true },
    { key: 'delete', label: 'Delete list', icon: 'delete', danger: true, onClick: () => setShowDeleteDialog(true) },
  ];

  return (
    <>
      <div draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onContextMenu={openContextMenu}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{
          display: 'flex', alignItems: 'center', borderRadius: 8,
          borderTop: dragOverId === list.id ? '2px solid var(--color-accent-purple-light)' : '2px solid transparent',
          position: 'relative',
          animation: isTaskDropTarget ? 'taskDropPulse 1.2s ease-in-out infinite' : (wasRecentlyDropped ? 'taskDropSuccess 550ms ease-out forwards' : undefined),
          transition: isTaskDropTarget || wasRecentlyDropped ? 'none' : 'border-color 120ms',
          paddingLeft: indented ? 8 : 0,
        }}>

        <button title={collapsed ? list.name : undefined}
          onClick={() => onNavigate(`/list/${list.id}`)}
          style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 10, padding: collapsed ? '8px 0' : '8px 10px', justifyContent: collapsed ? 'center' : 'flex-start', flex: 1, minWidth: 0, background: hov ? (list.colorBg ?? 'var(--color-surface-tint-2)') : 'transparent', color: isActive ? (list.color ?? 'var(--color-primary)') : 'var(--color-text-secondary)', fontWeight: isActive ? 600 : 450, borderRadius: 8, transition: 'all 150ms', cursor: 'pointer', border: 'none', fontFamily: 'var(--font-heading)', fontSize: 13.5, textAlign: 'left', width: '100%' }}>
          {!collapsed && (
            <Icon
              name={list.isPublic ? 'public' : 'lock'}
              size={13}
              color="var(--color-text-quaternary)"
            />
          )}
          {list.emoji
            ? <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>{list.emoji}</span>
            : <Icon name="format_list_bulleted" size={19} color={isActive ? (list.color ?? 'var(--color-primary)') : 'var(--color-text-tertiary)'} />
          }
          {!collapsed && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{list.name}</span>}
        </button>

        {!collapsed && !isTaskDropTarget && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, paddingRight: 4, flexShrink: 0 }}>
            <button
              ref={menuBtnRef}
              onClick={openMenu}
              title="To-Do options"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 4, border: 'none', background: menuOpen ? 'var(--color-purple-pale-39)' : 'transparent', cursor: 'pointer', padding: 0, opacity: hov || menuOpen ? 1 : 0, transition: 'opacity 150ms, background 120ms' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-purple-pale-39)')}
              onMouseLeave={e => { if (!menuOpen) e.currentTarget.style.background = 'transparent'; }}
            >
              <Icon name="more_vert" size={15} color="var(--color-accent-purple-light)" />
            </button>
            <div style={{ opacity: hov ? 1 : 0, transition: 'opacity 150ms', cursor: 'grab', display: 'flex', alignItems: 'center' }}>
              <Icon name="drag_indicator" size={15} color="var(--color-border-strong)" />
            </div>
          </div>
        )}

        {isTaskDropTarget && (
          <div style={{
            position: 'absolute',
            right: collapsed ? '50%' : 6,
            top: '50%',
            transform: collapsed ? 'translate(50%, -50%)' : 'translateY(-50%)',
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            background: 'var(--color-primary)',
            borderRadius: 9999,
            padding: collapsed ? '3px 5px' : '3px 9px',
            boxShadow: '0 2px 10px rgba(var(--color-primary-rgb), 0.4)',
            animation: 'moveHerePill 180ms cubic-bezier(0.34,1.56,0.64,1) both',
            zIndex: 10,
          }}>
            {!collapsed && (
              <span style={{ fontFamily: 'var(--font-heading)', fontSize: 10, fontWeight: 700, color: 'var(--color-white)', letterSpacing: '0.03em', whiteSpace: 'nowrap' }}>
                Move here
              </span>
            )}
            <Icon name="arrow_right_alt" size={collapsed ? 13 : 12} color="var(--color-white)" />
          </div>
        )}
      </div>

      {/* Right-click / "..." menu — shared component, two triggers */}
      {menuOpen && menuPos && (
        <ContextMenu x={menuPos.left} y={menuPos.top} items={menuItems} onClose={() => setMenuOpen(false)} />
      )}

      {/* More settings dialog */}
      {showSettings && (
        <ItemSettingsModal
          kind="list"
          name={list.name}
          emoji={list.emoji}
          color={list.color}
          isPublic={list.isPublic}
          folders={folders}
          folderId={list.folderId}
          itemId={list.id}
          creatorId={list.userId}
          share={{ enabled: list.shareEnabled, token: list.shareToken, hasPassword: list.shareHasPassword, expiresAt: list.shareExpiresAt, subpages: list.shareSubpages, viewMode: list.shareViewMode ?? list.viewMode ?? 'list' }}
          onShareUpdated={(s: ShareInfo) => setLists(prev => prev.map(l => l.id === list.id ? { ...l, shareEnabled: s.enabled, shareToken: s.token, shareHasPassword: s.hasPassword, shareExpiresAt: s.expiresAt, shareSubpages: s.subpages ?? l.shareSubpages, shareViewMode: s.viewMode ?? l.shareViewMode } : l))}
          onVisibilityApplied={(p: boolean) => setLists(prev => prev.map(l => l.id === list.id ? { ...l, isPublic: p } : l))}
          onChange={handleSettingsChange}
          onClose={() => setShowSettings(false)}
        />
      )}

      {/* Move to another workspace */}
      {showMoveWorkspace && (
        <MoveToWorkspaceModal
          kind="list"
          itemId={list.id}
          itemName={list.name}
          currentWorkspaceId={list.workspaceId}
          onMoved={(workspaceId) => {
            if (currentWorkspaceId && workspaceId !== currentWorkspaceId) {
              setLists(prev => prev.filter(l => l.id !== list.id));
            } else {
              setLists(prev => prev.map(l => l.id === list.id ? { ...l, workspaceId } : l));
            }
          }}
          onClose={() => setShowMoveWorkspace(false)}
        />
      )}

      {editingName && (
        <RenameDialog
          value={list.name}
          onSave={handleRename}
          onCancel={() => setEditingName(false)}
        />
      )}

      {/* Delete confirmation dialog */}
      {showDeleteDialog && createPortal(
        <div
          onClick={() => setShowDeleteDialog(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.18)', backdropFilter: 'blur(4px)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'backdropIn 180ms ease both' }}>
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: 'var(--color-white)', borderRadius: 14, padding: '28px 32px', maxWidth: 380, width: '100%', boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--color-error-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Icon name="delete" size={20} color="var(--color-error)" />
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}>Delete list?</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginBottom: 24 }}>
              "<span style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>{list.name}</span>" and all its tasks will be permanently deleted.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowDeleteDialog(false)} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleDelete} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-error)', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Delete</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

// ── TimelineItemRow ───────────────────────────────────────────────────────────
interface TimelineItemRowProps {
  timeline: Timeline;
  isActive: boolean;
  collapsed: boolean;
  indented?: boolean;
  folders: Folder[];
  dragOverId?: string | null;
  onNavigate: (path: string) => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (e: React.DragEvent) => void;
}
function TimelineItemRow({ timeline, isActive, collapsed, indented, folders, dragOverId, onNavigate, onDragStart, onDragOver, onDragLeave, onDrop }: TimelineItemRowProps) {
  const [hov, setHov] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showMoveWorkspace, setShowMoveWorkspace] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const { updateTimeline, deleteTimeline, setTimelines } = useAppStore();
  const currentWorkspaceId = useWorkspaceStore(s => s.currentWorkspaceId);

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = menuBtnRef.current?.getBoundingClientRect();
    if (rect) setMenuPos({ top: rect.bottom + 4, left: rect.left });
    setMenuOpen(o => !o);
  };

  const openContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ top: e.clientY, left: e.clientX });
    setMenuOpen(true);
  };

  const handleRename = (v: string) => {
    const trimmed = v.trim();
    if (trimmed && trimmed !== timeline.name) updateTimeline(timeline.id, { name: trimmed });
    setEditingName(false);
  };

  const handleDelete = () => {
    deleteTimeline(timeline.id);
    setShowDeleteDialog(false);
    onNavigate('/dashboard');
  };

  const handleSettingsChange = (updates: ItemSettingsUpdates) => {
    updateTimeline(timeline.id, updates as Partial<Timeline>);
  };

  const accent = timeline.color ?? 'var(--color-blue-mid-7)';

  const menuItems: ContextMenuEntry[] = [
    { key: 'rename', label: 'Edit name', icon: 'edit', onClick: () => setEditingName(true) },
    { key: 'settings', label: 'More settings…', icon: 'tune', onClick: () => setShowSettings(true) },
    { key: 'move-ws', label: 'Move to workspace…', icon: 'drive_file_move', onClick: () => setShowMoveWorkspace(true) },
    { key: 'div1', divider: true },
    { key: 'delete', label: 'Delete timeline', icon: 'delete', danger: true, onClick: () => setShowDeleteDialog(true) },
  ];

  return (
    <>
      <div
        draggable={!collapsed && !editingName}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onContextMenu={openContextMenu}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{ display: 'flex', alignItems: 'center', borderRadius: 8, position: 'relative', paddingLeft: indented ? 8 : 0, borderTop: dragOverId === timeline.id ? '2px solid var(--color-accent-purple-light)' : '2px solid transparent', transition: 'border-color 120ms' }}>

        <button title={collapsed ? timeline.name : undefined}
          onClick={() => onNavigate(`/timeline/${timeline.id}`)}
          style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 10, padding: collapsed ? '8px 0' : '8px 10px', justifyContent: collapsed ? 'center' : 'flex-start', flex: 1, minWidth: 0, background: hov ? (timeline.colorBg ?? 'var(--color-surface-tint-2)') : 'transparent', color: isActive ? accent : 'var(--color-text-secondary)', fontWeight: isActive ? 600 : 450, borderRadius: 8, transition: 'all 150ms', cursor: 'pointer', border: 'none', fontFamily: 'var(--font-heading)', fontSize: 13.5, textAlign: 'left', width: '100%' }}>
            {!collapsed && (
              <Icon name={timeline.isPublic ? 'public' : 'lock'} size={13} color="var(--color-text-quaternary)" />
            )}
            {timeline.emoji
              ? <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>{timeline.emoji}</span>
              : <Icon name="timeline" size={19} color={isActive ? accent : 'var(--color-text-tertiary)'} />
            }
            {!collapsed && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{timeline.name}</span>}
          </button>

        {!collapsed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, paddingRight: 4, flexShrink: 0 }}>
            <button
              ref={menuBtnRef}
              onClick={openMenu}
              title="Timeline options"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 4, border: 'none', background: menuOpen ? 'var(--color-purple-pale-39)' : 'transparent', cursor: 'pointer', padding: 0, opacity: hov || menuOpen ? 1 : 0, transition: 'opacity 150ms, background 120ms' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-purple-pale-39)')}
              onMouseLeave={e => { if (!menuOpen) e.currentTarget.style.background = 'transparent'; }}
            >
              <Icon name="more_vert" size={15} color="var(--color-accent-purple-light)" />
            </button>
            <div style={{ opacity: hov ? 1 : 0, transition: 'opacity 150ms', cursor: 'grab', display: 'flex', alignItems: 'center' }}>
              <Icon name="drag_indicator" size={15} color="var(--color-border-strong)" />
            </div>
          </div>
        )}
      </div>

      {/* Right-click / "..." menu — shared component, two triggers */}
      {menuOpen && menuPos && (
        <ContextMenu x={menuPos.left} y={menuPos.top} items={menuItems} onClose={() => setMenuOpen(false)} />
      )}

      {/* More settings dialog */}
      {showSettings && (
        <ItemSettingsModal
          kind="timeline"
          name={timeline.name}
          emoji={timeline.emoji}
          color={timeline.color}
          isPublic={timeline.isPublic}
          folders={folders}
          folderId={timeline.folderId}
          itemId={timeline.id}
          creatorId={timeline.userId}
          share={{ enabled: timeline.shareEnabled, token: timeline.shareToken, hasPassword: timeline.shareHasPassword, expiresAt: timeline.shareExpiresAt }}
          onShareUpdated={(s: ShareInfo) => setTimelines(prev => prev.map(t => t.id === timeline.id ? { ...t, shareEnabled: s.enabled, shareToken: s.token, shareHasPassword: s.hasPassword, shareExpiresAt: s.expiresAt } : t))}
          onVisibilityApplied={(p: boolean) => setTimelines(prev => prev.map(t => t.id === timeline.id ? { ...t, isPublic: p } : t))}
          onChange={handleSettingsChange}
          onClose={() => setShowSettings(false)}
        />
      )}

      {/* Move to another workspace */}
      {showMoveWorkspace && (
        <MoveToWorkspaceModal
          kind="timeline"
          itemId={timeline.id}
          itemName={timeline.name}
          currentWorkspaceId={timeline.workspaceId}
          onMoved={(workspaceId) => {
            if (currentWorkspaceId && workspaceId !== currentWorkspaceId) {
              setTimelines(prev => prev.filter(t => t.id !== timeline.id));
            } else {
              setTimelines(prev => prev.map(t => t.id === timeline.id ? { ...t, workspaceId } : t));
            }
          }}
          onClose={() => setShowMoveWorkspace(false)}
        />
      )}

      {editingName && (
        <RenameDialog
          value={timeline.name}
          accentColor={accent}
          onSave={handleRename}
          onCancel={() => setEditingName(false)}
        />
      )}

      {/* Delete confirmation dialog */}
      {showDeleteDialog && createPortal(
        <div
          onClick={() => setShowDeleteDialog(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.18)', backdropFilter: 'blur(4px)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'backdropIn 180ms ease both' }}>
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: 'var(--color-white)', borderRadius: 14, padding: '28px 32px', maxWidth: 380, width: '100%', boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--color-error-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Icon name="delete" size={20} color="var(--color-error)" />
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}>Delete timeline?</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginBottom: 24 }}>
              "<span style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>{timeline.name}</span>" and all its milestones will be moved to Trash.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowDeleteDialog(false)} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleDelete} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-error)', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Delete</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

// ── FolderRow ─────────────────────────────────────────────────────────────────
interface FolderRowProps {
  folder: Folder;
  lists: List[];
  timelines: Timeline[];
  active: 'dashboard' | 'calendar' | 'files' | 'list' | 'timeline' | 'settings' | 'folder' | 'gps' | 'templates' | 'automations' | 'markdownList';
  activeListId?: string;
  activeTimelineId?: string;
  activeFolderId?: string;
  collapsed: boolean;
  dragOverId: string | null;
  dragOverTimelineId: string | null;
  dragOverFolderId: string | null;
  dragOverFolderReorderId: string | null;
  dragOverTaskListId: string | null;
  recentlyDroppedListId: string | null;
  allFolders: Folder[];
  onNavigate: (path: string) => void;
  onListDragStart: (listId: string, e: React.DragEvent) => void;
  onListDragOver: (listId: string, e: React.DragEvent) => void;
  onListDragLeave: () => void;
  onListDrop: (listId: string, e: React.DragEvent) => void;
  onTimelineDragStart: (timelineId: string, e: React.DragEvent) => void;
  onTimelineDragOver: (timelineId: string, e: React.DragEvent) => void;
  onTimelineDragLeave: () => void;
  onTimelineDrop: (timelineId: string, e: React.DragEvent) => void;
  onFolderDragStart: (folderId: string, e: React.DragEvent) => void;
  onFolderDragOver: (folderId: string, e: React.DragEvent) => void;
  onFolderDragLeave: () => void;
  onFolderDrop: (folderId: string, e: React.DragEvent) => void;
  onFolderReorderDragOver: (folderId: string, e: React.DragEvent) => void;
  onFolderReorderDragLeave: () => void;
  onFolderReorderDrop: (folderId: string, e: React.DragEvent) => void;
}
function FolderRow({ folder, lists, timelines, active, activeListId, activeTimelineId, activeFolderId, collapsed, dragOverId, dragOverTimelineId, dragOverFolderId, dragOverFolderReorderId, dragOverTaskListId, recentlyDroppedListId, allFolders, onNavigate, onListDragStart, onListDragOver, onListDragLeave, onListDrop, onTimelineDragStart, onTimelineDragOver, onTimelineDragLeave, onTimelineDrop, onFolderDragStart, onFolderDragOver, onFolderDragLeave, onFolderDrop, onFolderReorderDragOver, onFolderReorderDragLeave, onFolderReorderDrop }: FolderRowProps) {
  const [hov, setHov] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(folder.name);
  const [showSettings, setShowSettings] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showMoveWorkspace, setShowMoveWorkspace] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const { updateFolder, deleteFolder, setFolders, setLists, setTimelines } = useAppStore();
  const currentWorkspaceId = useWorkspaceStore(s => s.currentWorkspaceId);

  // Collapsed-sidebar fold-out: a folder's contents are otherwise unreachable
  // from the sidebar itself once icon-only (its own expand/collapse chevron is
  // hidden, and there's no room for nested rows) — hovering the icon instead
  // pops a flyout with the same lists/timelines the expanded view would show.
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const [flyoutPos, setFlyoutPos] = useState<{ top: number; left: number } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const flyoutCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openFlyout = () => {
    if (flyoutCloseTimer.current) { clearTimeout(flyoutCloseTimer.current); flyoutCloseTimer.current = null; }
    const rect = rowRef.current?.getBoundingClientRect();
    if (rect) {
      // Rough content-height estimate (header row + divider + one row per item)
      // so a folder near the bottom of the viewport opens upward instead of
      // running off-screen — cheaper than a post-render measure-and-reflow pass.
      const estimatedHeight = 46 + Math.max(1, lists.length + timelines.length) * 33;
      const top = Math.min(rect.top, Math.max(16, window.innerHeight - estimatedHeight - 16));
      setFlyoutPos({ top, left: rect.right + 8 });
    }
    setFlyoutOpen(true);
  };
  const scheduleFlyoutClose = () => {
    if (flyoutCloseTimer.current) clearTimeout(flyoutCloseTimer.current);
    flyoutCloseTimer.current = setTimeout(() => setFlyoutOpen(false), 150);
  };
  useEffect(() => () => { if (flyoutCloseTimer.current) clearTimeout(flyoutCloseTimer.current); }, []);
  const navigateFromFlyout = (path: string) => { setFlyoutOpen(false); onNavigate(path); };

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = menuBtnRef.current?.getBoundingClientRect();
    if (rect) setMenuPos({ top: rect.bottom + 4, left: rect.left });
    setMenuOpen(o => !o);
  };

  const openContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ top: e.clientY, left: e.clientX });
    setMenuOpen(true);
  };

  const handleRename = () => {
    const trimmed = nameInput.trim();
    if (trimmed && trimmed !== folder.name) updateFolder(folder.id, { name: trimmed });
    setEditingName(false);
  };

  const toggleCollapsed = () => {
    updateFolder(folder.id, { collapsed: !folder.collapsed });
  };

  const handleDelete = () => {
    deleteFolder(folder.id);
    setShowDeleteDialog(false);
  };

  const accentColor = folder.color ?? 'var(--color-text-tertiary)';
  const isDragTarget = dragOverFolderId === folder.id;
  const isActiveDash = active === 'folder' && activeFolderId === folder.id;

  const menuItems: ContextMenuEntry[] = [
    { key: 'rename', label: 'Edit name', icon: 'edit', onClick: () => { setEditingName(true); setNameInput(folder.name); } },
    { key: 'settings', label: 'More settings…', icon: 'tune', onClick: () => setShowSettings(true) },
    { key: 'move-ws', label: 'Move to workspace…', icon: 'drive_file_move', onClick: () => setShowMoveWorkspace(true) },
    { key: 'div1', divider: true },
    { key: 'delete', label: 'Delete folder', icon: 'delete', danger: true, onClick: () => setShowDeleteDialog(true) },
  ];

  return (
    <>
      {/* Folder header */}
      <div
        ref={rowRef}
        draggable={!collapsed && !editingName}
        onDragStart={e => onFolderDragStart(folder.id, e)}
        onDragOver={e => {
          onFolderDragOver(folder.id, e);
          onFolderReorderDragOver(folder.id, e);
        }}
        onDragLeave={() => {
          onFolderDragLeave();
          onFolderReorderDragLeave();
        }}
        onDrop={e => {
          onFolderDrop(folder.id, e);
          onFolderReorderDrop(folder.id, e);
        }}
        onContextMenu={openContextMenu}
        onMouseEnter={() => { setHov(true); if (collapsed) openFlyout(); }}
        onMouseLeave={() => { setHov(false); if (collapsed) scheduleFlyoutClose(); }}
        style={{ display: 'flex', alignItems: 'center', borderRadius: 8, border: isDragTarget ? `2px solid ${accentColor}` : '2px solid transparent', borderTop: dragOverFolderReorderId === folder.id ? '2px solid var(--color-accent-purple-light)' : isDragTarget ? `2px solid ${accentColor}` : '2px solid transparent', transition: 'all 120ms', background: isDragTarget ? `${accentColor}15` : 'transparent' }}>

        {editingName && !collapsed ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', padding: '4px 8px', animation: 'menuItemIn 140ms ease both' }}>
            <input
              autoFocus
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onBlur={handleRename}
              onKeyDown={e => {
                if (e.key === 'Enter') handleRename();
                if (e.key === 'Escape') { setEditingName(false); setNameInput(folder.name); }
              }}
              style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13.5, border: 'none', borderBottom: `1.5px solid ${accentColor}`, outline: 'none', background: 'transparent', color: 'var(--color-text-primary)', padding: '2px 4px' }}
            />
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0, borderRadius: 8, background: isActiveDash ? `${accentColor}18` : 'transparent', transition: 'background 150ms' }}>
            {/* Chevron — toggles collapse */}
            {!collapsed && (
              <button
                onClick={e => { e.stopPropagation(); toggleCollapsed(); }}
                title={folder.collapsed ? 'Expand' : 'Collapse'}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '6px 3px 6px 6px', border: 'none', background: 'transparent', cursor: 'pointer', flexShrink: 0, borderRadius: 4 }}
              >
                <Icon name={folder.collapsed ? 'chevron_right' : 'expand_more'} size={14} color={accentColor} />
              </button>
            )}
            {/* Folder name — navigates to folder dashboard */}
            <button
              onClick={() => onNavigate(`/folder/${folder.id}`)}
              title={collapsed ? folder.name : `Open ${folder.name} overview`}
              style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 8, padding: collapsed ? '8px 0' : '5px 8px 5px 4px', justifyContent: collapsed ? 'center' : 'flex-start', flex: 1, minWidth: 0, background: 'transparent', borderRadius: 8, transition: 'all 150ms', cursor: 'pointer', border: 'none', fontFamily: 'var(--font-heading)', fontSize: 13.5, textAlign: 'left', width: '100%', color: accentColor }}
            >
              {folder.emoji
                ? <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>{folder.emoji}</span>
                : <Icon name="folder" size={17} color={accentColor} />
              }
              {!collapsed && (
                <span style={{ fontWeight: isActiveDash ? 700 : 600, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '0.01em', minWidth: 0 }}>
                  {folder.name}
                </span>
              )}
            </button>
          </div>
        )}

        {!collapsed && (
          <div style={{ display: 'flex', alignItems: 'center', paddingRight: 4, flexShrink: 0, gap: 2 }}>
            <button
              ref={menuBtnRef}
              onClick={openMenu}
              title="Folder options"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 4, border: 'none', background: menuOpen ? 'var(--color-purple-pale-39)' : 'transparent', cursor: 'pointer', padding: 0, opacity: hov || menuOpen ? 1 : 0, transition: 'opacity 150ms, background 120ms' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-purple-pale-39)')}
              onMouseLeave={e => { if (!menuOpen) e.currentTarget.style.background = 'transparent'; }}
            >
              <Icon name="more_vert" size={15} color="var(--color-accent-purple-light)" />
            </button>
            <div style={{ opacity: hov ? 1 : 0, transition: 'opacity 150ms', cursor: 'grab', display: 'flex', alignItems: 'center', pointerEvents: 'none' }}>
              <Icon name="drag_indicator" size={15} color="var(--color-border-strong)" />
            </div>
          </div>
        )}
      </div>

      {/* Folder contents */}
      {!folder.collapsed && !collapsed && (
        <div style={{ paddingLeft: 8 }}>
          {lists.map(list => {
            const isActive = active === 'list' && activeListId === list.id;
            return (
              <ListItemRow
                key={list.id}
                list={list}
                isActive={isActive}
                collapsed={collapsed}
                indented
                dragOverId={dragOverId}
                folders={allFolders}
                isTaskDropTarget={dragOverTaskListId === list.id}
                wasRecentlyDropped={recentlyDroppedListId === list.id}
                onNavigate={onNavigate}
                onDragStart={e => onListDragStart(list.id, e)}
                onDragOver={e => onListDragOver(list.id, e)}
                onDragLeave={onListDragLeave}
                onDrop={e => onListDrop(list.id, e)}
              />
            );
          })}
          {timelines.map(timeline => {
            const isActive = active === 'timeline' && activeTimelineId === timeline.id;
            return (
              <TimelineItemRow
                key={timeline.id}
                timeline={timeline}
                isActive={isActive}
                collapsed={collapsed}
                indented
                folders={allFolders}
                dragOverId={dragOverTimelineId}
                onNavigate={onNavigate}
                onDragStart={e => onTimelineDragStart(timeline.id, e)}
                onDragOver={e => onTimelineDragOver(timeline.id, e)}
                onDragLeave={onTimelineDragLeave}
                onDrop={e => onTimelineDrop(timeline.id, e)}
              />
            );
          })}
          {lists.length === 0 && timelines.length === 0 && (
            <div style={{ padding: '6px 10px', fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', fontStyle: 'italic' }}>
              Empty folder
            </div>
          )}
        </div>
      )}

      {/* Collapsed-sidebar fold-out — mirrors the expanded folder contents above,
          anchored to the right of the icon and shown on hover. */}
      {collapsed && flyoutOpen && flyoutPos && createPortal(
        <div
          onMouseEnter={openFlyout}
          onMouseLeave={scheduleFlyoutClose}
          style={{
            position: 'fixed', top: flyoutPos.top, left: flyoutPos.left, zIndex: 200,
            minWidth: 220, maxWidth: 280, maxHeight: 'calc(100vh - 32px)', overflowY: 'auto',
            background: 'var(--color-white)', borderRadius: 12, border: '1px solid var(--color-border)',
            boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.16)', padding: 6,
            animation: 'menuIn 160ms ease both', transformOrigin: 'top left',
          }}
        >
          <button
            onClick={() => navigateFromFlyout(`/folder/${folder.id}`)}
            title={`Open ${folder.name} overview`}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 8px', border: 'none', background: 'transparent', cursor: 'pointer', borderRadius: 8, fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 700, color: accentColor, textAlign: 'left' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-tint)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            {folder.emoji
              ? <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>{folder.emoji}</span>
              : <Icon name="folder" size={16} color={accentColor} />}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{folder.name}</span>
          </button>
          <div style={{ height: 1, background: 'var(--color-divider)', margin: '4px 4px 6px' }} />
          {lists.length === 0 && timelines.length === 0 ? (
            <div style={{ padding: '6px 8px', fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', fontStyle: 'italic' }}>
              Empty folder
            </div>
          ) : (
            <>
              {lists.map(list => {
                const isActive = active === 'list' && activeListId === list.id;
                return (
                  <button
                    key={list.id}
                    onClick={() => navigateFromFlyout(`/list/${list.id}`)}
                    title={list.name}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 8px', border: 'none', background: 'transparent', cursor: 'pointer', borderRadius: 8, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: isActive ? 600 : 450, color: isActive ? (list.color ?? 'var(--color-primary)') : 'var(--color-text-secondary)', textAlign: 'left' }}
                    onMouseEnter={e => (e.currentTarget.style.background = list.colorBg ?? 'var(--color-surface-tint-2)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    {list.emoji
                      ? <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>{list.emoji}</span>
                      : <Icon name="format_list_bulleted" size={16} color={isActive ? (list.color ?? 'var(--color-primary)') : 'var(--color-text-tertiary)'} />}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{list.name}</span>
                  </button>
                );
              })}
              {timelines.map(timeline => {
                const isActive = active === 'timeline' && activeTimelineId === timeline.id;
                return (
                  <button
                    key={timeline.id}
                    onClick={() => navigateFromFlyout(`/timeline/${timeline.id}`)}
                    title={timeline.name}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 8px', border: 'none', background: 'transparent', cursor: 'pointer', borderRadius: 8, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: isActive ? 600 : 450, color: isActive ? (timeline.color ?? 'var(--color-blue-mid-7)') : 'var(--color-text-secondary)', textAlign: 'left' }}
                    onMouseEnter={e => (e.currentTarget.style.background = timeline.colorBg ?? 'var(--color-surface-tint-2)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    {timeline.emoji
                      ? <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>{timeline.emoji}</span>
                      : <Icon name="timeline" size={16} color={isActive ? (timeline.color ?? 'var(--color-blue-mid-7)') : 'var(--color-text-tertiary)'} />}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{timeline.name}</span>
                  </button>
                );
              })}
            </>
          )}
        </div>,
        document.body
      )}

      {/* Right-click / "..." menu — shared component, two triggers */}
      {menuOpen && menuPos && (
        <ContextMenu x={menuPos.left} y={menuPos.top} items={menuItems} onClose={() => setMenuOpen(false)} />
      )}

      {/* More settings dialog */}
      {showSettings && (
        <ItemSettingsModal
          kind="folder"
          name={folder.name}
          emoji={folder.emoji}
          color={folder.color}
          isPublic={folder.isPublic ?? false}
          itemId={folder.id}
          creatorId={folder.userId}
          onVisibilityApplied={(p: boolean) => setFolders(prev => prev.map(f => f.id === folder.id ? { ...f, isPublic: p } : f))}
          onChange={updates => updateFolder(folder.id, updates as Partial<Folder>)}
          onClose={() => setShowSettings(false)}
        />
      )}

      {/* Move to another workspace — cascades to every list/timeline inside */}
      {showMoveWorkspace && (
        <MoveToWorkspaceModal
          kind="folder"
          itemId={folder.id}
          itemName={folder.name}
          currentWorkspaceId={folder.workspaceId}
          onMoved={(workspaceId) => {
            if (currentWorkspaceId && workspaceId !== currentWorkspaceId) {
              setFolders(prev => prev.filter(f => f.id !== folder.id));
              setLists(prev => prev.filter(l => l.folderId !== folder.id));
              setTimelines(prev => prev.filter(t => t.folderId !== folder.id));
            } else {
              setFolders(prev => prev.map(f => f.id === folder.id ? { ...f, workspaceId } : f));
              setLists(prev => prev.map(l => l.folderId === folder.id ? { ...l, workspaceId } : l));
              setTimelines(prev => prev.map(t => t.folderId === folder.id ? { ...t, workspaceId } : t));
            }
          }}
          onClose={() => setShowMoveWorkspace(false)}
        />
      )}

      {/* Delete folder confirmation */}
      {showDeleteDialog && createPortal(
        <div
          onClick={() => setShowDeleteDialog(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.18)', backdropFilter: 'blur(4px)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'backdropIn 180ms ease both' }}>
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: 'var(--color-white)', borderRadius: 14, padding: '28px 32px', maxWidth: 380, width: '100%', boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--color-error-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Icon name="folder_off" size={20} color="var(--color-error)" />
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}>Delete folder?</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginBottom: 24 }}>
              "<span style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>{folder.name}</span>" will be deleted. Lists inside it will be moved out and kept.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowDeleteDialog(false)} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleDelete} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-error)', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Delete</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

// ── StandaloneListWithSublists ────────────────────────────────────────────────
interface StandaloneListWithSublistsProps {
  list: List;
  sublists: List[];
  active: 'dashboard' | 'calendar' | 'files' | 'list' | 'timeline' | 'settings' | 'folder' | 'gps' | 'templates' | 'automations' | 'markdownList';
  activeListId?: string;
  collapsed: boolean;
  dragOverId: string | null;
  dragOverTaskListId: string | null;
  recentlyDroppedListId: string | null;
  folders: Folder[];
  onNavigate: (path: string) => void;
  onListDragStart: (listId: string, e: React.DragEvent) => void;
  onListDragOver: (listId: string, e: React.DragEvent) => void;
  onListDragLeave: () => void;
  onListDrop: (listId: string, e: React.DragEvent) => void;
}

function StandaloneListWithSublists({ list, sublists, active, activeListId, collapsed, dragOverId, dragOverTaskListId, recentlyDroppedListId, folders, onNavigate, onListDragStart, onListDragOver, onListDragLeave, onListDrop }: StandaloneListWithSublistsProps) {
  const [subExpanded, setSubExpanded] = useState(true);
  const isActive = active === 'list' && activeListId === list.id;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {!collapsed && sublists.length > 0 && (
          <button onClick={() => setSubExpanded(e => !e)}
            style={{ display: 'flex', alignItems: 'center', padding: '0 2px', border: 'none', background: 'transparent', cursor: 'pointer', flexShrink: 0 }}>
            <Icon name={subExpanded ? 'expand_more' : 'chevron_right'} size={14} color="var(--color-text-quaternary)" />
          </button>
        )}
        <div style={{ flex: 1 }}>
          <ListItemRow
            list={list}
            isActive={isActive}
            collapsed={collapsed}
            dragOverId={dragOverId}
            folders={folders}
            isTaskDropTarget={dragOverTaskListId === list.id}
            wasRecentlyDropped={recentlyDroppedListId === list.id}
            onNavigate={onNavigate}
            onDragStart={e => onListDragStart(list.id, e)}
            onDragOver={e => onListDragOver(list.id, e)}
            onDragLeave={onListDragLeave}
            onDrop={e => onListDrop(list.id, e)}
          />
        </div>
      </div>
      {!collapsed && subExpanded && sublists.map(sub => {
        const isSubActive = active === 'list' && activeListId === sub.id;
        return (
          <div key={sub.id} style={{ paddingLeft: (sub.depth ?? 1) * 12, borderLeft: '2px solid var(--color-border)', marginLeft: 10 }}>
            <ListItemRow
              list={sub}
              isActive={isSubActive}
              collapsed={collapsed}
              dragOverId={dragOverId}
              folders={folders}
              isTaskDropTarget={dragOverTaskListId === sub.id}
              wasRecentlyDropped={recentlyDroppedListId === sub.id}
              onNavigate={onNavigate}
              onDragStart={e => onListDragStart(sub.id, e)}
              onDragOver={e => onListDragOver(sub.id, e)}
              onDragLeave={onListDragLeave}
              onDrop={e => onListDrop(sub.id, e)}
            />
          </div>
        );
      })}
    </div>
  );
}

// ── MarkdownListRow ─────────────────────────────────────────────────────────
interface MarkdownListRowProps {
  markdownList: MarkdownList;
  isActive: boolean;
  collapsed: boolean;
  onNavigate: (path: string) => void;
}
function MarkdownListRow({ markdownList, isActive, collapsed, onNavigate }: MarkdownListRowProps) {
  const [hov, setHov] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const { update, remove, patch } = useMarkdownListsStore();

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = menuBtnRef.current?.getBoundingClientRect();
    if (rect) setMenuPos({ top: rect.bottom + 4, left: rect.left });
    setMenuOpen(o => !o);
  };
  const openContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ top: e.clientY, left: e.clientX });
    setMenuOpen(true);
  };
  const handleRename = (v: string) => {
    const trimmed = v.trim();
    if (trimmed && trimmed !== markdownList.name) void update(markdownList.id, { name: trimmed });
    setEditingName(false);
  };
  const handleDelete = () => {
    void remove(markdownList.id);
    setShowDeleteDialog(false);
    onNavigate('/dashboard');
  };

  const menuItems: ContextMenuEntry[] = [
    { key: 'rename', label: 'Edit name', icon: 'edit', onClick: () => setEditingName(true) },
    { key: 'settings', label: 'More settings…', icon: 'tune', onClick: () => setShowSettings(true) },
    { key: 'div1', divider: true },
    { key: 'delete', label: 'Delete markdown list', icon: 'delete', danger: true, onClick: () => setShowDeleteDialog(true) },
  ];

  return (
    <>
      <div onContextMenu={openContextMenu} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{ display: 'flex', alignItems: 'center', borderRadius: 8 }}>
        <button title={collapsed ? markdownList.name : undefined}
          onClick={() => onNavigate(`/markdown-list/${markdownList.id}`)}
          style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 10, padding: collapsed ? '8px 0' : '8px 10px', justifyContent: collapsed ? 'center' : 'flex-start', flex: 1, minWidth: 0, background: hov ? (markdownList.colorBg ?? 'var(--color-surface-tint-2)') : 'transparent', color: isActive ? (markdownList.color ?? 'var(--color-primary)') : 'var(--color-text-secondary)', fontWeight: isActive ? 600 : 450, borderRadius: 8, transition: 'all 150ms', cursor: 'pointer', border: 'none', fontFamily: 'var(--font-heading)', fontSize: 13.5, textAlign: 'left', width: '100%' }}>
          {markdownList.emoji
            ? <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>{markdownList.emoji}</span>
            : <Icon name="notes" size={19} color={isActive ? (markdownList.color ?? 'var(--color-primary)') : 'var(--color-text-tertiary)'} />
          }
          {!collapsed && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{markdownList.name}</span>}
        </button>
        {!collapsed && (
          <button ref={menuBtnRef} onClick={openMenu} title="Markdown list options"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 4, border: 'none', background: menuOpen ? 'var(--color-purple-pale-39)' : 'transparent', cursor: 'pointer', padding: 0, opacity: hov || menuOpen ? 1 : 0, transition: 'opacity 150ms, background 120ms', marginRight: 4, flexShrink: 0 }}>
            <Icon name="more_vert" size={15} color="var(--color-accent-purple-light)" />
          </button>
        )}
      </div>

      {menuOpen && menuPos && (
        <ContextMenu x={menuPos.left} y={menuPos.top} items={menuItems} onClose={() => setMenuOpen(false)} />
      )}

      {editingName && (
        <RenameDialog value={markdownList.name} onSave={handleRename} onCancel={() => setEditingName(false)} />
      )}

      {showSettings && (
        <ItemSettingsModal
          kind="markdownList"
          name={markdownList.name}
          emoji={markdownList.emoji}
          color={markdownList.color}
          isPublic={markdownList.isPublic}
          itemId={markdownList.id}
          share={{ enabled: markdownList.shareEnabled, token: markdownList.shareToken, hasPassword: markdownList.shareHasPassword, expiresAt: markdownList.shareExpiresAt }}
          onShareUpdated={(s: ShareInfo) => patch(markdownList.id, { shareEnabled: s.enabled, shareToken: s.token, shareHasPassword: s.hasPassword, shareExpiresAt: s.expiresAt })}
          onVisibilityApplied={(p: boolean) => patch(markdownList.id, { isPublic: p })}
          onChange={(updates: ItemSettingsUpdates) => void update(markdownList.id, updates as Parameters<typeof update>[1])}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showDeleteDialog && createPortal(
        <div
          onClick={() => setShowDeleteDialog(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.18)', backdropFilter: 'blur(4px)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'backdropIn 180ms ease both' }}>
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: 'var(--color-white)', borderRadius: 14, padding: '28px 32px', maxWidth: 380, width: '100%', boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--color-error-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Icon name="delete" size={20} color="var(--color-error)" />
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 8 }}>Delete markdown list?</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginBottom: 24 }}>
              "<span style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>{markdownList.name}</span>" and its Todo list will be moved to Trash.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowDeleteDialog(false)} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: '1px solid var(--color-border-alt)', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleDelete} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-error)', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Delete</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

// ── MarkdownListWithTodo ──────────────────────────────────────────────────────
// Mirrors StandaloneListWithSublists' fold-out chevron pattern: the
// auto-managed Todo list (one real `lists` row per `/todo` block in the doc)
// is revealed/collapsed under its owning Markdown List rather than shown
// separately at root.
interface MarkdownListWithTodoProps {
  markdownList: MarkdownList;
  todoList: List | undefined;
  active: 'dashboard' | 'calendar' | 'files' | 'list' | 'timeline' | 'settings' | 'folder' | 'gps' | 'templates' | 'automations' | 'markdownList';
  activeListId?: string;
  activeMarkdownListId?: string;
  collapsed: boolean;
  dragOverId: string | null;
  dragOverTaskListId: string | null;
  recentlyDroppedListId: string | null;
  folders: Folder[];
  onNavigate: (path: string) => void;
  onListDragStart: (listId: string, e: React.DragEvent) => void;
  onListDragOver: (listId: string, e: React.DragEvent) => void;
  onListDragLeave: () => void;
  onListDrop: (listId: string, e: React.DragEvent) => void;
}
function MarkdownListWithTodo({ markdownList, todoList, active, activeListId, activeMarkdownListId, collapsed, dragOverId, dragOverTaskListId, recentlyDroppedListId, folders, onNavigate, onListDragStart, onListDragOver, onListDragLeave, onListDrop }: MarkdownListWithTodoProps) {
  const [subExpanded, setSubExpanded] = useState(true);
  const isActive = active === 'markdownList' && activeMarkdownListId === markdownList.id;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {!collapsed && todoList && (
          <button onClick={() => setSubExpanded(e => !e)}
            style={{ display: 'flex', alignItems: 'center', padding: '0 2px', border: 'none', background: 'transparent', cursor: 'pointer', flexShrink: 0 }}>
            <Icon name={subExpanded ? 'expand_more' : 'chevron_right'} size={14} color="var(--color-text-quaternary)" />
          </button>
        )}
        <div style={{ flex: 1 }}>
          <MarkdownListRow markdownList={markdownList} isActive={isActive} collapsed={collapsed} onNavigate={onNavigate} />
        </div>
      </div>
      {!collapsed && subExpanded && todoList && (
        <div style={{ paddingLeft: 12, borderLeft: '2px solid var(--color-border)', marginLeft: 10 }}>
          <ListItemRow
            list={todoList}
            isActive={active === 'list' && activeListId === todoList.id}
            collapsed={collapsed}
            dragOverId={dragOverId}
            folders={folders}
            isTaskDropTarget={dragOverTaskListId === todoList.id}
            wasRecentlyDropped={recentlyDroppedListId === todoList.id}
            onNavigate={onNavigate}
            onDragStart={e => onListDragStart(todoList.id, e)}
            onDragOver={e => onListDragOver(todoList.id, e)}
            onDragLeave={onListDragLeave}
            onDrop={e => onListDrop(todoList.id, e)}
          />
        </div>
      )}
    </div>
  );
}

// ── WorkspaceSwitcher ─────────────────────────────────────────────────────────
function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const { workspaces, currentWorkspaceId, setCurrentWorkspace, deletingWorkspaceId } = useWorkspaceStore();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const openedForDeletion = useRef(false);

  const current = workspaces.find(w => w.id === currentWorkspaceId);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (openedForDeletion.current) return; // don't close during deletion animation
      if (dropRef.current && !dropRef.current.contains(e.target as Node) && btnRef.current && !btnRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  // Auto-open dropdown to show deletion animation
  useEffect(() => {
    if (deletingWorkspaceId) {
      const rect = btnRef.current?.getBoundingClientRect();
      if (rect) setDropdownPos({ top: rect.bottom + 4, left: Math.max(8, rect.left) });
      setDropdownOpen(true);
      openedForDeletion.current = true;
    } else if (openedForDeletion.current) {
      setDropdownOpen(false);
      openedForDeletion.current = false;
    }
  }, [deletingWorkspaceId]);

  const openDropdown = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) setDropdownPos({ top: rect.bottom + 4, left: Math.max(8, rect.left) });
    setDropdownOpen(o => !o);
  };

  // "New workspace" shortcut — same as the dropdown's "New workspace" item.
  useEffect(() => {
    const onCreateWorkspace = () => { setShowWizard(true); setDropdownOpen(false); };
    window.addEventListener('shortcut:create-workspace', onCreateWorkspace);
    return () => window.removeEventListener('shortcut:create-workspace', onCreateWorkspace);
  }, []);

  return (
    <>
      <button ref={btnRef} onClick={openDropdown} title={collapsed ? (current?.name ?? 'Workspaces') : undefined}
        style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 8, padding: collapsed ? '8px 0' : '8px 10px', justifyContent: collapsed ? 'center' : 'flex-start', width: '100%', borderRadius: 8, border: 'none', background: dropdownOpen ? 'var(--color-surface-tint)' : 'transparent', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 500, color: 'var(--color-primary)', transition: 'background 150ms' }}>
        <div style={{ width: 22, height: 22, borderRadius: 6, background: 'var(--color-purple-pale-21)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
          {current?.image
            ? <img src={current.image} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <span style={{ fontSize: 13 }}>{current?.emoji ?? '🏠'}</span>
          }
        </div>
        {!collapsed && (
          <>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{current?.name ?? 'Select workspace'}</span>
            <Icon name="unfold_more" size={15} color="var(--color-accent-purple-light)" />
          </>
        )}
      </button>

      {dropdownOpen && dropdownPos && (
        <div ref={dropRef}
          style={{ position: 'fixed', top: dropdownPos.top, left: dropdownPos.left, zIndex: 500, background: 'var(--color-white)', borderRadius: 12, boxShadow: '0 4px 24px rgba(var(--color-black-rgb), 0.14)', border: '1px solid var(--color-border)', minWidth: 230, padding: '4px 0', animation: 'menuIn 140ms ease both', overflow: 'hidden' }}>

          {workspaces.length === 0 && (
            <div style={{ padding: '12px 14px', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>No workspaces yet.</div>
          )}

          {workspaces.map(ws => (
            <div key={ws.id} style={{ overflow: 'hidden', animation: ws.id === deletingWorkspaceId ? 'wsItemOut 420ms ease forwards' : undefined }}>
              <button
                onClick={() => { if (ws.id === deletingWorkspaceId) return; setCurrentWorkspace(ws.id); setDropdownOpen(false); }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 14px', border: 'none', background: ws.id === currentWorkspaceId ? 'var(--color-surface-tint)' : 'transparent', cursor: ws.id === deletingWorkspaceId ? 'default' : 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: ws.id === currentWorkspaceId ? 600 : 450, color: ws.id === currentWorkspaceId ? 'var(--color-primary)' : 'var(--color-text-primary)', textAlign: 'left', pointerEvents: ws.id === deletingWorkspaceId ? 'none' : undefined }}
                onMouseEnter={e => { if (ws.id !== currentWorkspaceId && ws.id !== deletingWorkspaceId) e.currentTarget.style.background = 'var(--color-purple-pale-11)'; }}
                onMouseLeave={e => { if (ws.id !== currentWorkspaceId) e.currentTarget.style.background = 'transparent'; }}>
                <div style={{ width: 26, height: 26, borderRadius: 8, background: 'var(--color-purple-pale-21)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
                  {ws.image
                    ? <img src={ws.image} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <span style={{ fontSize: 14 }}>{ws.emoji ?? '🏠'}</span>
                  }
                </div>
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ws.name}</div>
                  {(() => {
                  if (ws.visibility === 'public') return <div style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-text-quaternary)' }}>Public</div>;
                  if ((ws.memberCount ?? 1) > 1) return <div style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-text-quaternary)' }}>Shared</div>;
                  return <div style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-text-quaternary)' }}>Private</div>;
                })()}
                </div>
                {ws.id === currentWorkspaceId && <Icon name="check" size={14} color="var(--color-primary)" />}
              </button>
            </div>
          ))}

          <div style={{ height: 1, background: 'var(--color-divider)', margin: '4px 0' }} />

          {current && (current.role === 'owner' || current.ownerId === current.ownerId) && (
            <button
              onClick={() => { setShowSettings(true); setDropdownOpen(false); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 450, color: 'var(--color-text-secondary)', textAlign: 'left' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-tint)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <Icon name="settings" size={15} color="var(--color-text-tertiary)" /> Workspace settings
            </button>
          )}

          <button
            onClick={() => { setShowWizard(true); setDropdownOpen(false); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-primary)', textAlign: 'left' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-tint)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <Icon name="add_circle" size={15} color="var(--color-primary)" /> New workspace
          </button>
        </div>
      )}

      {showWizard && <WorkspaceWizard onClose={() => setShowWizard(false)} />}
      {showSettings && current && <WorkspaceSettingsModal workspace={current} onClose={() => setShowSettings(false)} />}
    </>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
interface SidebarProps {
  active: 'dashboard' | 'calendar' | 'files' | 'list' | 'timeline' | 'settings' | 'folder' | 'gps' | 'templates' | 'automations' | 'markdownList';
  activeListId?: string;
  activeTimelineId?: string;
  activeFolderId?: string;
  activeGpsFileId?: string;
  activeMarkdownListId?: string;
  lists: List[];
  width: number;
  onNavigate: (path: string) => void;
  onOpenModal: (modal: 'add' | 'completed' | 'trash' | 'archived') => void;
  onReorderLists: (fromId: string, toId: string) => void;
  onResizeStart: (startX: number) => void;
  onTaskDropToList: (taskId: number, listId: string) => void;
  isMobile?: boolean;
  drawerOpen?: boolean;
  /** True while the user is actively dragging the resize handle — width
   *  transitions are suppressed during a live drag so the sidebar tracks the
   *  cursor 1:1, and re-enabled the moment the drag ends (or on a collapse/
   *  expand toggle) so those changes animate smoothly instead of snapping. */
  resizing?: boolean;
}

function fmtDistShort(m?: number | null) {
  if (m == null) return null;
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
}

export default function Sidebar({ active, activeListId, activeTimelineId, activeFolderId, activeGpsFileId, activeMarkdownListId, lists, width, onNavigate, onOpenModal, onReorderLists, onResizeStart, onTaskDropToList, isMobile, drawerOpen, resizing }: SidebarProps) {
  const markdownLists = useMarkdownListsStore(s => s.markdownLists);
  const mdTodoListIds = new Set(markdownLists.map(m => m.todoListId).filter((x): x is string => !!x));
  const collapsed = isMobile ? false : width <= 72;
  const [addHov, setAddHov] = useState(false);
  const [folderHov, setFolderHov] = useState(false);
  const [templatesHov, setTemplatesHov] = useState(false);
  const [automationsHov, setAutomationsHov] = useState(false);
  const automationsInstalled = useInstalledAppsStore((s) => s.installedApps.includes('automations'));
  const [calendarHov, setCalendarHov] = useState(false);
  const [handleHov, setHandleHov] = useState(false);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverTimelineId, setDragOverTimelineId] = useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [dragOverFolderReorderId, setDragOverFolderReorderId] = useState<string | null>(null);
  const [dragOverTaskListId, setDragOverTaskListId] = useState<string | null>(null);
  const [recentlyDroppedListId, setRecentlyDroppedListId] = useState<string | null>(null);
  const [addingFolder, setAddingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const folderInputRef = useRef<HTMLInputElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const [gpsFiles, setGpsFiles] = useState<GpsFile[]>([]);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsSearch, setGpsSearch] = useState('');

  const { folders, timelines, addFolder, updateList, updateFolder, updateTimeline, setFolders, setTimelines, loadFromApi, setSidebarWidth } = useAppStore();

  // Click-to-toggle the sidebar collapse (an alternative to dragging the resize
  // handle). Mirrors the `toggle-sidebar` keyboard shortcut in KeyboardShortcuts.tsx.
  const toggleCollapsed = useCallback(() => {
    setSidebarWidth(width <= 72 ? 256 : MINI);
  }, [width, setSidebarWidth]);

  // Scroll sidebar to top whenever the mobile drawer opens so the logo is always visible.
  useEffect(() => {
    if (isMobile && drawerOpen) {
      asideRef.current?.scrollTo({ top: 0 });
    }
  }, [drawerOpen, isMobile]);

  useEffect(() => {
    const clearTaskDrag = () => { setDragOverTaskListId(null); setDragOverTimelineId(null); };
    document.addEventListener('dragend', clearTaskDrag);
    return () => document.removeEventListener('dragend', clearTaskDrag);
  }, []);

  // "New folder" shortcut — same as clicking the Add Folder button.
  useEffect(() => {
    const onCreateFolder = () => { setAddingFolder(true); setTimeout(() => folderInputRef.current?.focus(), 50); };
    window.addEventListener('shortcut:create-folder', onCreateFolder);
    return () => window.removeEventListener('shortcut:create-folder', onCreateFolder);
  }, []);

  useEffect(() => {
    if (active !== 'gps') return;
    // Loading flag must reset on every GPS tab activation, not just mount
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGpsLoading(true);
    apiGetGpsFiles()
      .then(data => { setGpsFiles(data); setGpsLoading(false); })
      .catch(() => setGpsLoading(false));
    const refresh = () => {
      apiGetGpsFiles().then(data => setGpsFiles(data)).catch(() => {});
    };
    window.addEventListener('gps-files-changed', refresh);
    return () => window.removeEventListener('gps-files-changed', refresh);
  }, [active]);

  const handleTaskDrop = useCallback((listId: string, taskId: number) => {
    onTaskDropToList(taskId, listId);
    setDragOverTaskListId(null);
    setRecentlyDroppedListId(listId);
    setTimeout(() => setRecentlyDroppedListId(null), 600);
  }, [onTaskDropToList]);

  const handleListDrop = useCallback((toId: string, e: React.DragEvent) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData('dashtaskid') || e.dataTransfer.getData('listtaskid');
    if (taskId) {
      const id = parseInt(taskId, 10);
      if (!isNaN(id)) handleTaskDrop(toId, id);
      return;
    }
    const fromId = e.dataTransfer.getData('listId');
    if (fromId && fromId !== toId) onReorderLists(fromId, toId);
    setDragOverId(null);
  }, [onReorderLists, handleTaskDrop]);

  const handleFolderDrop = useCallback((folderId: string, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const listId = e.dataTransfer.getData('listId');
    if (listId) {
      updateList(listId, { folderId });
      setDragOverFolderId(null);
      return;
    }
    const timelineId = e.dataTransfer.getData('timelineId');
    if (timelineId) {
      updateTimeline(timelineId, { folderId });
      setDragOverFolderId(null);
    }
  }, [updateList, updateTimeline]);

  // Reorder timelines (and move them between scopes) by dropping one onto another.
  // The dragged timeline inherits the drop target's folder, so dropping onto a
  // timeline inside a folder moves it in, and onto a root timeline moves it out.
  const handleTimelineReorderDrop = useCallback((toId: string, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverTimelineId(null);
    const fromId = e.dataTransfer.getData('timelineId');
    if (!fromId || fromId === toId) return;

    const arr = [...timelines];
    const fromIdx = arr.findIndex(t => t.id === fromId);
    const target = arr.find(t => t.id === toId);
    if (fromIdx === -1 || !target) return;

    const [moved] = arr.splice(fromIdx, 1);
    const insertIdx = arr.findIndex(t => t.id === toId);
    arr.splice(insertIdx, 0, { ...moved, folderId: target.folderId });
    const reordered = arr.map((t, i) => ({ ...t, position: i }));
    setTimelines(reordered);

    const folderChanged = (moved.folderId ?? null) !== (target.folderId ?? null);
    if (folderChanged) updateTimeline(moved.id, { folderId: target.folderId ?? null } as Partial<Timeline>);
    apiReorderTimelines(reordered.map(t => t.id)).catch(() => loadFromApi());
  }, [timelines, setTimelines, updateTimeline, loadFromApi]);

  const timelineDragHandlers = {
    onTimelineDragStart: (timelineId: string, e: React.DragEvent) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('timelineId', timelineId); },
    onTimelineDragOver: (timelineId: string, e: React.DragEvent) => {
      if (e.dataTransfer.types.includes('timelineid')) { e.preventDefault(); setDragOverTimelineId(timelineId); }
    },
    onTimelineDragLeave: () => setDragOverTimelineId(null),
    onTimelineDrop: handleTimelineReorderDrop,
  };

  const onFolderReorderDrop = useCallback((toId: string, e: React.DragEvent) => {
    e.preventDefault();
    const fromId = e.dataTransfer.getData('folderId');
    if (fromId && fromId !== toId) {
      const ordered = [...folders].sort((a, b) => a.position - b.position);
      const fromIndex = ordered.findIndex(f => f.id === fromId);
      const toIndex = ordered.findIndex(f => f.id === toId);
      if (fromIndex >= 0 && toIndex >= 0) {
        const [moved] = ordered.splice(fromIndex, 1);
        ordered.splice(toIndex, 0, moved);

        const normalized = ordered.map((folder, index) => ({
          ...folder,
          position: index,
        }));

        setFolders(normalized);
        normalized.forEach(f => updateFolder(f.id, { position: f.position }));
      }
    }
    setDragOverFolderReorderId(null);
  }, [folders, setFolders, updateFolder]);

  const handleCreateFolder = () => {
    const name = newFolderName.trim();
    if (name) {
      addFolder({ id: `folder_${Date.now()}`, name, position: folders.length, collapsed: false });
    }
    setNewFolderName('');
    setAddingFolder(false);
  };

  // Defensive grouping: an item whose folderId doesn't match any loaded folder
  // (cross-workspace folder, partial load, historical drift) must render as
  // standalone — filtering it into a folder that isn't on screen would make it
  // silently disappear from the sidebar even though the API returned it.
  const loadedFolderIds = new Set(folders.map(f => f.id));
  // A Markdown List's auto-managed Todo list is a real `lists` row, but it's
  // rendered nested under its owning Markdown List (MarkdownListWithTodo)
  // rather than again as its own standalone entry.
  const standaloneListItems = lists.filter(l => (!l.folderId || !loadedFolderIds.has(l.folderId)) && !mdTodoListIds.has(l.id));
  const standaloneTimelines = timelines.filter(t => !t.folderId || !loadedFolderIds.has(t.folderId));

  // ── GPS sidebar mode ───────────────────────────────────────────────────────
  if (active === 'gps') {
    return (
      <aside ref={asideRef} style={{
        width: isMobile ? 280 : width,
        minWidth: isMobile ? 280 : width,
        height: '100vh',
        background: 'var(--color-purple-pale-13)',
        borderRight: '1px solid var(--color-border-alt)',
        display: 'flex',
        flexDirection: 'column',
        padding: isMobile
          ? 'calc(env(safe-area-inset-top, 0px) + 16px) 12px 16px'
          : collapsed ? '16px 6px' : '16px 12px',
        gap: 4,
        position: 'fixed',
        left: isMobile ? (drawerOpen ? 0 : -280) : 0,
        top: 0,
        zIndex: isMobile ? 60 : 40,
        overflowY: 'auto',
        overflowX: 'hidden',
        boxSizing: 'border-box',
        transition: isMobile
          ? 'left 260ms cubic-bezier(0.22,1,0.36,1)'
          : resizing ? undefined : 'width 240ms cubic-bezier(0.22,1,0.36,1), min-width 240ms cubic-bezier(0.22,1,0.36,1)',
      }}>
        {/* Resize handle — desktop only */}
        {!isMobile && (
          <div onMouseDown={e => { e.preventDefault(); onResizeStart(e.clientX); }}
            onMouseEnter={() => setHandleHov(true)} onMouseLeave={() => setHandleHov(false)}
            style={{ position: 'absolute', right: 0, top: 0, width: 6, height: '100%', cursor: 'col-resize', zIndex: 50, background: handleHov ? 'rgba(var(--color-primary-rgb), 0.10)' : 'transparent', transition: 'background 150ms', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {handleHov && <div style={{ width: 2, height: 48, borderRadius: 2, background: 'var(--color-accent-purple-light)', opacity: 0.7 }} />}
            {handleHov && (
              <button type="button"
                onMouseDown={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); toggleCollapsed(); }}
                title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                style={{ position: 'fixed', top: '50%', left: width - 12, transform: 'translateY(-50%)', width: 24, height: 24, borderRadius: 7, border: '1px solid var(--color-border)', background: 'var(--color-white)', boxShadow: '0 2px 8px rgba(var(--color-primary-rgb), 0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0, zIndex: 60, transition: resizing ? undefined : 'left 240ms cubic-bezier(0.22,1,0.36,1)' }}>
                <Icon name={collapsed ? 'chevron_right' : 'chevron_left'} size={14} color="var(--color-primary)" />
              </button>
            )}
          </div>
        )}

        {/* Logo / header */}
        <button type="button" onClick={() => onNavigate('/dashboard')} title={collapsed ? 'Dashboard' : undefined}
          style={{ padding: collapsed ? '12px 0 20px' : '12px 8px 20px', display: 'flex', flexDirection: 'column', alignItems: collapsed ? 'center' : 'flex-start', gap: 4, background: 'transparent', border: 'none', cursor: 'pointer', width: '100%', borderRadius: 8 }}>
          <img src="/solytiq-cloud.png" alt="Solytiq" style={{ width: isMobile ? 32 : 44, height: isMobile ? 32 : 44, borderRadius: isMobile ? 9 : 11, objectFit: 'cover', marginBottom: 6, flexShrink: 0 }} />
          {!collapsed && (
            <>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 500, color: 'var(--color-primary)', lineHeight: 1.2, whiteSpace: 'nowrap' }}>Solytiq Cloud</div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.03em', whiteSpace: 'nowrap' }}>Your Routes. Your cloud.</div>
            </>
          )}
        </button>

        {/* Upload button */}
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('gps-upload-trigger'))}
          title={collapsed ? 'Upload Route' : undefined}
          style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 8, padding: collapsed ? '8px 0' : '8px 10px', justifyContent: collapsed ? 'center' : 'flex-start', borderRadius: 8, cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 500, color: 'var(--color-primary)', background: 'transparent', border: 'none', transition: 'background 200ms', width: '100%' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-tint)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <Icon name="upload" size={19} color="var(--color-primary)" />
          {!collapsed && <span>Upload Route</span>}
        </button>

        {!collapsed && <div style={{ height: 1, background: 'var(--color-border)', margin: '2px 8px' }} />}

        {/* Search */}
        {!collapsed && (
          <div style={{ padding: '0 4px 4px', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--color-white)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '5px 8px' }}>
              <Icon name="search" size={14} color="var(--color-text-quaternary)" />
              <input
                value={gpsSearch}
                onChange={e => setGpsSearch(e.target.value)}
                placeholder="Search routes…"
                style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-primary)' }}
              />
              {gpsSearch && (
                <button onClick={() => setGpsSearch('')} style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}>
                  <Icon name="close" size={13} color="var(--color-text-quaternary)" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Route list */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
          {gpsLoading && !collapsed && (
            <div style={{ padding: '16px 8px', fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', textAlign: 'center' }}>Loading…</div>
          )}
          {!gpsLoading && gpsFiles.length === 0 && !collapsed && (
            <div style={{ padding: '20px 8px', fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)', textAlign: 'center', lineHeight: 1.6 }}>
              No routes yet.<br />Upload a .GPX or .FIT file.
            </div>
          )}
          {gpsFiles.filter(f => !gpsSearch || f.name.toLowerCase().includes(gpsSearch.toLowerCase())).map(file => {
            const isActive = activeGpsFileId === file.id;
            const displayName = file.name.replace(/\.(gpx|fit)$/i, '');
            if (collapsed) {
              return (
                <div key={file.id} style={{ position: 'relative' }}>
                  <button
                    title={displayName}
                    onClick={() => onNavigate(`/gps?file=${file.id}`)}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', padding: '8px 0', border: 'none', background: isActive ? 'var(--color-surface-tint)' : 'transparent', borderRadius: 8, cursor: 'pointer', transition: 'all 150ms' }}
                  >
                    <Icon name="route" size={18} color={isActive ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
                  </button>
                </div>
              );
            }
            return (
              <div
                key={file.id}
                onClick={() => onNavigate(`/gps?file=${file.id}`)}
                style={{ background: isActive ? 'var(--color-surface-tint)' : 'transparent', borderLeft: `3px solid ${isActive ? 'var(--color-primary)' : 'transparent'}`, borderRadius: 8, padding: '7px 8px 7px 6px', cursor: 'pointer', transition: 'all 150ms' }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--color-surface-tint-2)'; }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 4, background: file.fileType === 'gpx' ? 'var(--color-purple-pale-21)' : 'var(--color-teal-tint-1)', color: file.fileType === 'gpx' ? 'var(--color-primary)' : 'var(--color-teal-deep-2)', letterSpacing: '0.04em', flexShrink: 0 }}>
                    {file.fileType.toUpperCase()}
                  </span>
                  <span style={{ fontSize: 12.5, fontWeight: isActive ? 600 : 450, color: isActive ? 'var(--color-primary)' : 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, fontFamily: 'var(--font-heading)' }}>
                    {displayName}
                  </span>
                </div>
                {file.metadata && (
                  <div style={{ marginTop: 3, fontSize: 11, color: 'var(--color-text-quaternary)', display: 'flex', gap: 8, paddingLeft: 2, fontFamily: 'var(--font-body)' }}>
                    {file.metadata.totalDistance != null && <span>{fmtDistShort(file.metadata.totalDistance)}</span>}
                    {file.metadata.totalElevationGain != null && file.metadata.totalElevationGain > 0 && <span>↑{Math.round(file.metadata.totalElevationGain)}m</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Bottom: version */}
        <div style={{ marginTop: 'auto', borderTop: '1px solid var(--color-border)', paddingTop: 8 }}>
          {!collapsed && (
            <div style={{ padding: '6px 10px 2px', fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-purple-tint-10)', letterSpacing: '0.03em', userSelect: 'none' }}>
              v1.52.0
            </div>
          )}
        </div>
      </aside>
    );
  }

  return (
    <aside ref={asideRef} style={{
      width: isMobile ? 280 : width,
      minWidth: isMobile ? 280 : width,
      height: '100vh',
      background: 'var(--color-purple-pale-13)',
      borderRight: '1px solid var(--color-border-alt)',
      display: 'flex',
      flexDirection: 'column',
      padding: isMobile
        ? 'calc(env(safe-area-inset-top, 0px) + 16px) 12px 16px'
        : collapsed ? '16px 6px' : '16px 12px',
      gap: 4,
      position: 'fixed',
      left: isMobile ? (drawerOpen ? 0 : -280) : 0,
      top: 0,
      zIndex: isMobile ? 60 : 40,
      overflowY: 'auto',
      overflowX: 'hidden',
      boxSizing: 'border-box',
      transition: isMobile
        ? 'left 260ms cubic-bezier(0.22,1,0.36,1)'
        : resizing ? undefined : 'width 240ms cubic-bezier(0.22,1,0.36,1), min-width 240ms cubic-bezier(0.22,1,0.36,1)',
    }}>

      {/* Resize handle — desktop only */}
      {!isMobile && (
        <div onMouseDown={e => { e.preventDefault(); onResizeStart(e.clientX); }}
          onMouseEnter={() => setHandleHov(true)} onMouseLeave={() => setHandleHov(false)}
          style={{ position: 'absolute', right: 0, top: 0, width: 6, height: '100%', cursor: 'col-resize', zIndex: 50, background: handleHov ? 'rgba(var(--color-primary-rgb), 0.10)' : 'transparent', transition: 'background 150ms', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {handleHov && <div style={{ width: 2, height: 48, borderRadius: 2, background: 'var(--color-accent-purple-light)', opacity: 0.7 }} />}
          {handleHov && (
            <button type="button"
              onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); toggleCollapsed(); }}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              style={{ position: 'absolute', top: '50%', right: 3, transform: 'translateY(-50%)', width: 20, height: 20, borderRadius: '50%', border: '1px solid var(--color-border)', background: 'var(--color-white)', boxShadow: '0 2px 8px rgba(var(--color-primary-rgb), 0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0, zIndex: 60 }}>
              <Icon name={collapsed ? 'chevron_right' : 'chevron_left'} size={14} color="var(--color-primary)" />
            </button>
          )}
        </div>
      )}

      {/* Logo / header */}
      <button type="button" onClick={() => onNavigate('/dashboard')} title={collapsed ? 'Dashboard' : undefined}
        style={{ padding: collapsed ? '12px 0 20px' : '12px 8px 20px', display: 'flex', flexDirection: 'column', alignItems: collapsed ? 'center' : 'flex-start', gap: 4, background: 'transparent', border: 'none', cursor: 'pointer', width: '100%', borderRadius: 8 }}>
        <img src="/solytiq-cloud.png" alt="Solytiq" style={{ width: 44, height: 44, borderRadius: 11, objectFit: 'cover', marginBottom: 6, flexShrink: 0 }} />
        {!collapsed && (
          <>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 500, color: 'var(--color-primary)', lineHeight: 1.2, whiteSpace: 'nowrap' }}>Solytiq Cloud</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.03em', whiteSpace: 'nowrap' }}>Your to-dos. Your cloud.</div>
          </>
        )}
      </button>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <WorkspaceSwitcher collapsed={collapsed} />

        {/* Calendar — global (all-workspace) view */}
        <button
          onClick={() => onNavigate('/calendar')}
          title={collapsed ? 'Calendar' : undefined}
          onMouseEnter={() => setCalendarHov(true)}
          onMouseLeave={() => setCalendarHov(false)}
          style={{
            display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 8,
            padding: collapsed ? '8px 0' : '8px 10px', justifyContent: collapsed ? 'center' : 'flex-start',
            borderRadius: 8, cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13.5,
            fontWeight: active === 'calendar' ? 700 : 500,
            color: active === 'calendar' ? 'var(--color-primary)' : 'var(--color-text-secondary)',
            background: active === 'calendar' ? 'var(--color-surface-tint)' : (calendarHov ? 'var(--color-surface-tint-3)' : 'transparent'),
            border: 'none', transition: 'background 150ms', width: '100%',
          }}>
          <Icon name="calendar_month" size={17} color={active === 'calendar' ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
          {!collapsed && <span>Calendar</span>}
        </button>

        {/* Templates — global gallery, not scoped to the current workspace */}
        <button
          onClick={() => onNavigate('/templates')}
          title={collapsed ? 'Templates' : undefined}
          onMouseEnter={() => setTemplatesHov(true)}
          onMouseLeave={() => setTemplatesHov(false)}
          style={{
            display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 8,
            padding: collapsed ? '8px 0' : '8px 10px', justifyContent: collapsed ? 'center' : 'flex-start',
            borderRadius: 8, cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13.5,
            fontWeight: active === 'templates' ? 700 : 500,
            color: active === 'templates' ? 'var(--color-primary)' : 'var(--color-text-secondary)',
            background: active === 'templates' ? 'var(--color-surface-tint)' : (templatesHov ? 'var(--color-surface-tint-3)' : 'transparent'),
            border: 'none', transition: 'background 150ms', width: '100%',
          }}>
          <Icon name="dashboard_customize" size={17} color={active === 'templates' ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
          {!collapsed && <span>Templates</span>}
        </button>

        {/* Automations — per-workspace, only shown once the admin has
            installed the Automation Hub app (Settings → System → Discover Apps) */}
        {automationsInstalled && (
          <button
            onClick={() => onNavigate('/automations')}
            title={collapsed ? 'Automations' : undefined}
            onMouseEnter={() => setAutomationsHov(true)}
            onMouseLeave={() => setAutomationsHov(false)}
            style={{
              display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 8,
              padding: collapsed ? '8px 0' : '8px 10px', justifyContent: collapsed ? 'center' : 'flex-start',
              borderRadius: 8, cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13.5,
              fontWeight: active === 'automations' ? 700 : 500,
              color: active === 'automations' ? 'var(--color-primary)' : 'var(--color-text-secondary)',
              background: active === 'automations' ? 'var(--color-surface-tint)' : (automationsHov ? 'var(--color-surface-tint-3)' : 'transparent'),
              border: 'none', transition: 'background 150ms', width: '100%',
            }}>
            <Icon name="bolt" size={17} color={active === 'automations' ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
            {!collapsed && <span>Automations</span>}
          </button>
        )}

        <div style={{ height: 1, background: 'var(--color-border)', margin: '6px 8px' }} />

        {/* Add List / Add Folder buttons */}
        <div style={{ display: 'flex', gap: 4 }}>
          <button title={collapsed ? 'Add' : undefined}
            onMouseEnter={() => setAddHov(true)} onMouseLeave={() => setAddHov(false)}
            onClick={() => onOpenModal('add')}
            style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 8, padding: collapsed ? '8px 0' : '8px 10px', justifyContent: collapsed ? 'center' : 'flex-start', flex: 1, borderRadius: 8, cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 500, color: 'var(--color-primary)', background: addHov ? 'var(--color-surface-tint)' : 'transparent', border: 'none', transition: 'background 200ms' }}>
            <Icon name="add" size={19} color="var(--color-primary)" />
            {!collapsed && <span>Add</span>}
          </button>
          {!collapsed && (
            <button title="Add Folder"
              onMouseEnter={() => setFolderHov(true)} onMouseLeave={() => setFolderHov(false)}
              onClick={() => { setAddingFolder(true); setTimeout(() => folderInputRef.current?.focus(), 50); }}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, border: 'none', background: folderHov ? 'var(--color-surface-tint)' : 'transparent', cursor: 'pointer', padding: 0, flexShrink: 0, transition: 'background 200ms', alignSelf: 'center' }}>
              <Icon name="create_new_folder" size={17} color="var(--color-primary)" />
            </button>
          )}
        </div>

        {/* New folder input */}
        {addingFolder && !collapsed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: 'var(--color-surface-tint-alt)', borderRadius: 8, border: '1.5px solid var(--color-accent-purple-soft-alt)' }}>
            <Icon name="folder" size={15} color="var(--color-primary)" />
            <input
              ref={folderInputRef}
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              onBlur={handleCreateFolder}
              onKeyDown={e => {
                if (e.key === 'Enter') handleCreateFolder();
                if (e.key === 'Escape') { setAddingFolder(false); setNewFolderName(''); }
              }}
              placeholder="Folder name…"
              style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, border: 'none', outline: 'none', background: 'transparent', color: 'var(--color-text-primary)' }}
            />
          </div>
        )}

        {/* Folders */}
        {[...folders].sort((a, b) => a.position - b.position).map(folder => {
          const folderLists = lists.filter(l => l.folderId === folder.id);
          const folderTimelines = timelines.filter(t => t.folderId === folder.id);
          return (
            <FolderRow
              key={folder.id}
              folder={folder}
              lists={folderLists}
              timelines={folderTimelines}
              active={active}
              activeListId={activeListId}
              activeTimelineId={activeTimelineId}
              activeFolderId={activeFolderId}
              collapsed={collapsed}
              dragOverId={dragOverId}
              dragOverTimelineId={dragOverTimelineId}
              dragOverFolderId={dragOverFolderId}
              dragOverFolderReorderId={dragOverFolderReorderId}
              dragOverTaskListId={dragOverTaskListId}
              recentlyDroppedListId={recentlyDroppedListId}
              allFolders={folders}
              onNavigate={onNavigate}
              {...timelineDragHandlers}
              onListDragStart={(listId, e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('listId', listId); }}
              onListDragOver={(listId, e) => {
                if (e.dataTransfer.types.includes('dashtaskid') || e.dataTransfer.types.includes('listtaskid')) {
                  e.preventDefault();
                  setDragOverTaskListId(listId);
                  setDragOverId(null);
                } else if (e.dataTransfer.types.includes('listid')) {
                  e.preventDefault();
                  setDragOverId(listId);
                  setDragOverTaskListId(null);
                }
              }}
              onListDragLeave={() => { setDragOverId(null); setDragOverTaskListId(null); }}
              onListDrop={(listId, e) => handleListDrop(listId, e)}
              onFolderDragStart={(folderId, e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('folderId', folderId); }}
              onFolderDragOver={(folderId, e) => {
                const canDrop = e.dataTransfer.types.includes('listid') || e.dataTransfer.types.includes('timelineid');
                if (canDrop) {
                  e.preventDefault();
                  setDragOverFolderId(folderId);
                }
              }}
              onFolderDragLeave={() => setDragOverFolderId(null)}
              onFolderDrop={handleFolderDrop}
              onFolderReorderDragOver={(folderId, e) => {
                const isFolder = e.dataTransfer.types.includes('folderid');
                if (isFolder) {
                  e.preventDefault();
                  setDragOverFolderReorderId(folderId);
                }
              }}
              onFolderReorderDragLeave={() => setDragOverFolderReorderId(null)}
              onFolderReorderDrop={onFolderReorderDrop}
            />
          );
        })}

        {/* Standalone lists (root level). A sublist whose parent task is not in
            any loaded list (orphaned by a partial delete or historical drift)
            is promoted to root so it stays reachable instead of vanishing. */}
        {(() => {
          const allLoadedTaskIds = new Set(lists.flatMap(l => l.sections.flatMap(s => s.tasks.map(t => t.id))));
          return standaloneListItems.filter(l => !l.parentTaskId || !allLoadedTaskIds.has(l.parentTaskId));
        })().map((list) => {
          const taskIds = new Set(list.sections.flatMap(s => s.tasks.map(t => t.id)));
          const sublists = lists.filter(l2 => l2.parentTaskId != null && taskIds.has(l2.parentTaskId));
          return (
            <StandaloneListWithSublists
              key={list.id}
              list={list}
              sublists={sublists}
              active={active}
              activeListId={activeListId}
              collapsed={collapsed}
              dragOverId={dragOverId}
              dragOverTaskListId={dragOverTaskListId}
              recentlyDroppedListId={recentlyDroppedListId}
              folders={folders}
              onNavigate={onNavigate}
              onListDragStart={(listId, e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('listId', listId); }}
              onListDragOver={(listId, e) => {
                if (e.dataTransfer.types.includes('dashtaskid') || e.dataTransfer.types.includes('listtaskid')) {
                  e.preventDefault();
                  setDragOverTaskListId(listId);
                  setDragOverId(null);
                } else if (e.dataTransfer.types.includes('listid')) {
                  e.preventDefault();
                  setDragOverId(listId);
                  setDragOverTaskListId(null);
                }
              }}
              onListDragLeave={() => { setDragOverId(null); setDragOverTaskListId(null); }}
              onListDrop={(listId, e) => handleListDrop(listId, e)}
            />
          );
        })}

        {/* Markdown Lists (root level — not yet foldered, see CLAUDE.md) */}
        {markdownLists.map((md) => (
          <MarkdownListWithTodo
            key={md.id}
            markdownList={md}
            todoList={md.todoListId ? lists.find(l => l.id === md.todoListId) : undefined}
            active={active}
            activeListId={activeListId}
            activeMarkdownListId={activeMarkdownListId}
            collapsed={collapsed}
            dragOverId={dragOverId}
            dragOverTaskListId={dragOverTaskListId}
            recentlyDroppedListId={recentlyDroppedListId}
            folders={folders}
            onNavigate={onNavigate}
            onListDragStart={(listId, e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('listId', listId); }}
            onListDragOver={(listId, e) => {
              if (e.dataTransfer.types.includes('dashtaskid') || e.dataTransfer.types.includes('listtaskid')) {
                e.preventDefault();
                setDragOverTaskListId(listId);
                setDragOverId(null);
              }
            }}
            onListDragLeave={() => { setDragOverId(null); setDragOverTaskListId(null); }}
            onListDrop={(listId, e) => handleListDrop(listId, e)}
          />
        ))}

        {/* Standalone timelines (root level) */}
        {standaloneTimelines.map(timeline => (
          <TimelineItemRow
            key={timeline.id}
            timeline={timeline}
            isActive={active === 'timeline' && activeTimelineId === timeline.id}
            collapsed={collapsed}
            folders={folders}
            dragOverId={dragOverTimelineId}
            onNavigate={onNavigate}
            onDragStart={e => timelineDragHandlers.onTimelineDragStart(timeline.id, e)}
            onDragOver={e => timelineDragHandlers.onTimelineDragOver(timeline.id, e)}
            onDragLeave={timelineDragHandlers.onTimelineDragLeave}
            onDrop={e => timelineDragHandlers.onTimelineDrop(timeline.id, e)}
          />
        ))}
      </div>

      <div style={{ marginTop: 'auto', borderTop: '1px solid var(--color-border)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <NavItem icon="check_circle" label="Completed" active={false} onClick={() => onOpenModal('completed')} collapsed={collapsed} />
        <NavItem icon="delete" label="Trash" active={false} onClick={() => onOpenModal('trash')} collapsed={collapsed} />
        <NavItem icon="archive" label="Archived" active={false} onClick={() => onOpenModal('archived')} collapsed={collapsed} />
        {!collapsed && (
          <div style={{ padding: '6px 10px 2px', fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-purple-tint-10)', letterSpacing: '0.03em', userSelect: 'none' }}>
            v1.52.0
          </div>
        )}
      </div>
    </aside>
  );
}
