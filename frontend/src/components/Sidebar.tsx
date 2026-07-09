import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { List, Folder, Timeline, GpsFile } from '../types';
import Icon from './Icon';
import useAppStore from '../store/useAppStore';
import useWorkspaceStore from '../store/useWorkspaceStore';
import WorkspaceWizard from '../modals/WorkspaceWizard';
import WorkspaceSettingsModal from '../modals/WorkspaceSettingsModal';
import ItemSettingsModal, { type ItemSettingsUpdates } from '../modals/ItemSettingsModal';
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
  const col = active ? '#5e4dbb' : '#787584';
  const bg = active ? '#F5F3FF' : hov ? '#f1ecf6' : 'transparent';
  return (
    <div style={{ position: 'relative' }}>
      <button title={collapsed ? label : undefined} onClick={onClick}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 10, padding: collapsed ? '8px 0' : '8px 10px', justifyContent: collapsed ? 'center' : 'flex-start', borderRadius: 8, cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: active ? 600 : 450, color: col, border: 'none', background: bg, width: '100%', transition: 'all 200ms' }}>
        <Icon name={icon} size={19} color={col} />
        {!collapsed && <span>{label}</span>}
      </button>
      {collapsed && hov && (
        <div style={{ position: 'fixed', left: MINI + 8, zIndex: 200, background: '#1c1b22', color: '#fff', borderRadius: 6, padding: '4px 10px', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 500, pointerEvents: 'none', whiteSpace: 'nowrap' }}>
          {label}
        </div>
      )}
    </div>
  );
}

// ── RenameDialog ──────────────────────────────────────────────────────────────
function RenameDialog({ value, accentColor = '#5e4dbb', onChange, onSave, onCancel }: {
  value: string; accentColor?: string;
  onChange: (v: string) => void; onSave: () => void; onCancel: () => void;
}) {
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', backdropFilter: 'blur(4px)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 20px', animation: 'backdropIn 180ms ease both' }}
      onClick={onCancel}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '24px 28px', width: '100%', maxWidth: 360, boxShadow: '0 8px 32px rgba(0,0,0,0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22', marginBottom: 16 }}>Rename</div>
        <input
          autoFocus
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel(); }}
          style={{ width: '100%', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, border: `1.5px solid ${accentColor}`, borderRadius: 8, outline: 'none', padding: '10px 12px', color: '#1c1b22', background: '#faf8ff', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onCancel}
            style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #e8e4f0', background: '#f7f2fc', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#787584', cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={onSave}
            style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: accentColor, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', cursor: 'pointer' }}>
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body
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
  const [nameInput, setNameInput] = useState(list.name);
  const [showSettings, setShowSettings] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { deleteList, updateList, setLists } = useAppStore();

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        menuBtnRef.current && !menuBtnRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = menuBtnRef.current?.getBoundingClientRect();
    if (rect) setMenuPos({ top: rect.bottom + 4, left: rect.left });
    setMenuOpen(o => !o);
  };

  const handleRename = () => {
    const trimmed = nameInput.trim();
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

  return (
    <>
      <div draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{
          display: 'flex', alignItems: 'center', borderRadius: 8,
          borderTop: dragOverId === list.id ? '2px solid #9d8dff' : '2px solid transparent',
          position: 'relative',
          animation: isTaskDropTarget ? 'taskDropPulse 1.2s ease-in-out infinite' : (wasRecentlyDropped ? 'taskDropSuccess 550ms ease-out forwards' : undefined),
          transition: isTaskDropTarget || wasRecentlyDropped ? 'none' : 'border-color 120ms',
          paddingLeft: indented ? 8 : 0,
        }}>

        <button title={collapsed ? list.name : undefined}
          onClick={() => onNavigate(`/list/${list.id}`)}
          style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 10, padding: collapsed ? '8px 0' : '8px 10px', justifyContent: collapsed ? 'center' : 'flex-start', flex: 1, background: hov ? (list.colorBg ?? '#f1ecf6') : 'transparent', color: isActive ? (list.color ?? '#5e4dbb') : '#484552', fontWeight: isActive ? 600 : 450, borderRadius: 8, transition: 'all 150ms', cursor: 'pointer', border: 'none', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, textAlign: 'left', width: '100%' }}>
          {!collapsed && (
            <Icon
              name={list.isPublic ? 'public' : 'lock'}
              size={13}
              color="#b0acbe"
            />
          )}
          {list.emoji
            ? <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>{list.emoji}</span>
            : <Icon name="format_list_bulleted" size={19} color={isActive ? (list.color ?? '#5e4dbb') : '#787584'} />
          }
          {!collapsed && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{list.name}</span>}
        </button>

        {!collapsed && !isTaskDropTarget && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, paddingRight: 4, flexShrink: 0 }}>
            <button
              ref={menuBtnRef}
              onClick={openMenu}
              title="List options"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 4, border: 'none', background: menuOpen ? '#ebe6f0' : 'transparent', cursor: 'pointer', padding: 0, opacity: hov || menuOpen ? 1 : 0, transition: 'opacity 150ms, background 120ms' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#ebe6f0')}
              onMouseLeave={e => { if (!menuOpen) e.currentTarget.style.background = 'transparent'; }}
            >
              <Icon name="more_vert" size={15} color="#9d8dff" />
            </button>
            <div style={{ opacity: hov ? 1 : 0, transition: 'opacity 150ms', cursor: 'grab', display: 'flex', alignItems: 'center' }}>
              <Icon name="drag_indicator" size={15} color="#c9c4d5" />
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
            background: '#5e4dbb',
            borderRadius: 9999,
            padding: collapsed ? '3px 5px' : '3px 9px',
            boxShadow: '0 2px 10px rgba(94,77,187,0.4)',
            animation: 'moveHerePill 180ms cubic-bezier(0.34,1.56,0.64,1) both',
            zIndex: 10,
          }}>
            {!collapsed && (
              <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10, fontWeight: 700, color: '#fff', letterSpacing: '0.03em', whiteSpace: 'nowrap' }}>
                Move here
              </span>
            )}
            <Icon name="arrow_right_alt" size={collapsed ? 13 : 12} color="#fff" />
          </div>
        )}
      </div>

      {/* Dropdown menu */}
      {menuOpen && menuPos && (
        <div ref={menuRef}
          style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, zIndex: 400, background: '#fff', borderRadius: 10, boxShadow: '0 4px 20px rgba(0,0,0,0.13)', border: '1px solid #e8e4f0', minWidth: 180, padding: '4px 0', animation: 'menuIn 140ms ease both', transformOrigin: 'top left' }}>
          <button
            onClick={() => { setMenuOpen(false); setEditingName(true); setNameInput(list.name); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#1c1b22', textAlign: 'left', animation: 'menuItemIn 160ms ease both', animationDelay: '0ms' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Icon name="edit" size={15} color="#787584" />
            Edit name
          </button>

          <button
            onClick={() => { setMenuOpen(false); setShowSettings(true); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#1c1b22', textAlign: 'left', animation: 'menuItemIn 160ms ease both', animationDelay: '30ms' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Icon name="tune" size={15} color="#787584" />
            More settings…
          </button>

          <div style={{ height: 1, background: '#f0ecf8', margin: '3px 0' }} />

          <button
            onClick={() => { setMenuOpen(false); setShowDeleteDialog(true); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#ba1a1a', textAlign: 'left', animation: 'menuItemIn 160ms ease both', animationDelay: '60ms' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#fff0ef')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Icon name="delete" size={15} color="#ba1a1a" />
            Delete list
          </button>
        </div>
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
          share={{ enabled: list.shareEnabled, token: list.shareToken, hasPassword: list.shareHasPassword, expiresAt: list.shareExpiresAt, subpages: list.shareSubpages }}
          onShareUpdated={(s: ShareInfo) => setLists(prev => prev.map(l => l.id === list.id ? { ...l, shareEnabled: s.enabled, shareToken: s.token, shareHasPassword: s.hasPassword, shareExpiresAt: s.expiresAt, shareSubpages: s.subpages ?? l.shareSubpages } : l))}
          onVisibilityApplied={(p: boolean) => setLists(prev => prev.map(l => l.id === list.id ? { ...l, isPublic: p } : l))}
          onChange={handleSettingsChange}
          onClose={() => setShowSettings(false)}
        />
      )}

      {editingName && (
        <RenameDialog
          value={nameInput}
          onChange={setNameInput}
          onSave={handleRename}
          onCancel={() => { setEditingName(false); setNameInput(list.name); }}
        />
      )}

      {/* Delete confirmation dialog */}
      {showDeleteDialog && createPortal(
        <div
          onClick={() => setShowDeleteDialog(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', backdropFilter: 'blur(4px)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'backdropIn 180ms ease both' }}>
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 380, width: '100%', boxShadow: '0 8px 32px rgba(0,0,0,0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#ffdad6', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Icon name="delete" size={20} color="#ba1a1a" />
            </div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22', marginBottom: 8 }}>Delete list?</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', lineHeight: 1.5, marginBottom: 24 }}>
              "<span style={{ color: '#1c1b22', fontWeight: 500 }}>{list.name}</span>" and all its tasks will be permanently deleted.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowDeleteDialog(false)} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: '1px solid #E5E7EB', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleDelete} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#ba1a1a', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Delete</button>
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
  const [nameInput, setNameInput] = useState(timeline.name);
  const [showSettings, setShowSettings] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { updateTimeline, deleteTimeline, setTimelines } = useAppStore();

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        menuBtnRef.current && !menuBtnRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = menuBtnRef.current?.getBoundingClientRect();
    if (rect) setMenuPos({ top: rect.bottom + 4, left: rect.left });
    setMenuOpen(o => !o);
  };

  const handleRename = () => {
    const trimmed = nameInput.trim();
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

  const accent = timeline.color ?? '#1D4ED8';

  return (
    <>
      <div
        draggable={!collapsed && !editingName}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{ display: 'flex', alignItems: 'center', borderRadius: 8, position: 'relative', paddingLeft: indented ? 8 : 0, borderTop: dragOverId === timeline.id ? '2px solid #9d8dff' : '2px solid transparent', transition: 'border-color 120ms' }}>

        <button title={collapsed ? timeline.name : undefined}
          onClick={() => onNavigate(`/timeline/${timeline.id}`)}
          style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 10, padding: collapsed ? '8px 0' : '8px 10px', justifyContent: collapsed ? 'center' : 'flex-start', flex: 1, background: hov ? (timeline.colorBg ?? '#f1ecf6') : 'transparent', color: isActive ? accent : '#484552', fontWeight: isActive ? 600 : 450, borderRadius: 8, transition: 'all 150ms', cursor: 'pointer', border: 'none', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, textAlign: 'left', width: '100%' }}>
            {!collapsed && (
              <Icon name={timeline.isPublic ? 'public' : 'lock'} size={13} color="#b0acbe" />
            )}
            {timeline.emoji
              ? <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>{timeline.emoji}</span>
              : <Icon name="timeline" size={19} color={isActive ? accent : '#787584'} />
            }
            {!collapsed && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{timeline.name}</span>}
          </button>

        {!collapsed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, paddingRight: 4, flexShrink: 0 }}>
            <button
              ref={menuBtnRef}
              onClick={openMenu}
              title="Timeline options"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 4, border: 'none', background: menuOpen ? '#ebe6f0' : 'transparent', cursor: 'pointer', padding: 0, opacity: hov || menuOpen ? 1 : 0, transition: 'opacity 150ms, background 120ms' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#ebe6f0')}
              onMouseLeave={e => { if (!menuOpen) e.currentTarget.style.background = 'transparent'; }}
            >
              <Icon name="more_vert" size={15} color="#9d8dff" />
            </button>
            <div style={{ opacity: hov ? 1 : 0, transition: 'opacity 150ms', cursor: 'grab', display: 'flex', alignItems: 'center' }}>
              <Icon name="drag_indicator" size={15} color="#c9c4d5" />
            </div>
          </div>
        )}
      </div>

      {/* Dropdown menu */}
      {menuOpen && menuPos && (
        <div ref={menuRef}
          style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, zIndex: 400, background: '#fff', borderRadius: 10, boxShadow: '0 4px 20px rgba(0,0,0,0.13)', border: '1px solid #e8e4f0', minWidth: 190, padding: '4px 0', animation: 'menuIn 140ms ease both', transformOrigin: 'top left' }}>
          <button
            onClick={() => { setMenuOpen(false); setEditingName(true); setNameInput(timeline.name); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#1c1b22', textAlign: 'left', animation: 'menuItemIn 160ms ease both' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Icon name="edit" size={15} color="#787584" />
            Edit name
          </button>

          <button
            onClick={() => { setMenuOpen(false); setShowSettings(true); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#1c1b22', textAlign: 'left', animation: 'menuItemIn 160ms ease both', animationDelay: '30ms' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Icon name="tune" size={15} color="#787584" />
            More settings…
          </button>

          <div style={{ height: 1, background: '#f0ecf8', margin: '3px 0' }} />

          <button
            onClick={() => { setMenuOpen(false); setShowDeleteDialog(true); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#ba1a1a', textAlign: 'left', animation: 'menuItemIn 160ms ease both', animationDelay: '60ms' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#fff0ef')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Icon name="delete" size={15} color="#ba1a1a" />
            Delete timeline
          </button>
        </div>
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

      {editingName && (
        <RenameDialog
          value={nameInput}
          accentColor={accent}
          onChange={setNameInput}
          onSave={handleRename}
          onCancel={() => { setEditingName(false); setNameInput(timeline.name); }}
        />
      )}

      {/* Delete confirmation dialog */}
      {showDeleteDialog && createPortal(
        <div
          onClick={() => setShowDeleteDialog(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', backdropFilter: 'blur(4px)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'backdropIn 180ms ease both' }}>
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 380, width: '100%', boxShadow: '0 8px 32px rgba(0,0,0,0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#ffdad6', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Icon name="delete" size={20} color="#ba1a1a" />
            </div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22', marginBottom: 8 }}>Delete timeline?</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', lineHeight: 1.5, marginBottom: 24 }}>
              "<span style={{ color: '#1c1b22', fontWeight: 500 }}>{timeline.name}</span>" and all its milestones will be moved to Trash.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowDeleteDialog(false)} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: '1px solid #E5E7EB', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleDelete} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#ba1a1a', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Delete</button>
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
  active: 'dashboard' | 'calendar' | 'files' | 'list' | 'timeline' | 'settings' | 'folder' | 'gps' | 'templates';
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
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { updateFolder, deleteFolder, setFolders } = useAppStore();

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        menuBtnRef.current && !menuBtnRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = menuBtnRef.current?.getBoundingClientRect();
    if (rect) setMenuPos({ top: rect.bottom + 4, left: rect.left });
    setMenuOpen(o => !o);
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

  const accentColor = folder.color ?? '#787584';
  const isDragTarget = dragOverFolderId === folder.id;
  const isActiveDash = active === 'folder' && activeFolderId === folder.id;

  return (
    <>
      {/* Folder header */}
      <div
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
        onMouseEnter={() => setHov(true)}
        onMouseLeave={() => setHov(false)}
        style={{ display: 'flex', alignItems: 'center', borderRadius: 8, border: isDragTarget ? `2px solid ${accentColor}` : '2px solid transparent', borderTop: dragOverFolderReorderId === folder.id ? '2px solid #9d8dff' : isDragTarget ? `2px solid ${accentColor}` : '2px solid transparent', transition: 'all 120ms', background: isDragTarget ? `${accentColor}15` : 'transparent' }}>

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
              style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, border: 'none', borderBottom: `1.5px solid ${accentColor}`, outline: 'none', background: 'transparent', color: '#1c1b22', padding: '2px 4px' }}
            />
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', flex: 1, borderRadius: 8, background: isActiveDash ? `${accentColor}18` : 'transparent', transition: 'background 150ms' }}>
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
              style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 8, padding: collapsed ? '8px 0' : '5px 8px 5px 4px', justifyContent: collapsed ? 'center' : 'flex-start', flex: 1, background: 'transparent', borderRadius: 8, transition: 'all 150ms', cursor: 'pointer', border: 'none', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, textAlign: 'left', width: '100%', color: accentColor }}
            >
              {folder.emoji
                ? <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>{folder.emoji}</span>
                : <Icon name="folder" size={17} color={accentColor} />
              }
              {!collapsed && (
                <span style={{ fontWeight: isActiveDash ? 700 : 600, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '0.01em' }}>
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
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 4, border: 'none', background: menuOpen ? '#ebe6f0' : 'transparent', cursor: 'pointer', padding: 0, opacity: hov || menuOpen ? 1 : 0, transition: 'opacity 150ms, background 120ms' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#ebe6f0')}
              onMouseLeave={e => { if (!menuOpen) e.currentTarget.style.background = 'transparent'; }}
            >
              <Icon name="more_vert" size={15} color="#9d8dff" />
            </button>
            <div style={{ opacity: hov ? 1 : 0, transition: 'opacity 150ms', cursor: 'grab', display: 'flex', alignItems: 'center', pointerEvents: 'none' }}>
              <Icon name="drag_indicator" size={15} color="#c9c4d5" />
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
            <div style={{ padding: '6px 10px', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe', fontStyle: 'italic' }}>
              Empty folder
            </div>
          )}
        </div>
      )}

      {/* Folder 3-dot menu */}
      {menuOpen && menuPos && (
        <div ref={menuRef}
          style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, zIndex: 400, background: '#fff', borderRadius: 10, boxShadow: '0 4px 20px rgba(0,0,0,0.13)', border: '1px solid #e8e4f0', minWidth: 180, padding: '4px 0', animation: 'menuIn 140ms ease both', transformOrigin: 'top left' }}>

          <button
            onClick={() => { setMenuOpen(false); setEditingName(true); setNameInput(folder.name); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#1c1b22', textAlign: 'left', animation: 'menuItemIn 160ms ease both', animationDelay: '0ms' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Icon name="edit" size={15} color="#787584" />
            Edit name
          </button>

          <button
            onClick={() => { setMenuOpen(false); setShowSettings(true); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#1c1b22', textAlign: 'left', animation: 'menuItemIn 160ms ease both', animationDelay: '30ms' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Icon name="tune" size={15} color="#787584" />
            More settings…
          </button>

          <div style={{ height: 1, background: '#f0ecf8', margin: '3px 0' }} />

          <button
            onClick={() => { setMenuOpen(false); setShowDeleteDialog(true); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#ba1a1a', textAlign: 'left', animation: 'menuItemIn 160ms ease both', animationDelay: '60ms' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#fff0ef')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Icon name="delete" size={15} color="#ba1a1a" />
            Delete folder
          </button>
        </div>
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

      {/* Delete folder confirmation */}
      {showDeleteDialog && createPortal(
        <div
          onClick={() => setShowDeleteDialog(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', backdropFilter: 'blur(4px)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'backdropIn 180ms ease both' }}>
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 380, width: '100%', boxShadow: '0 8px 32px rgba(0,0,0,0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#ffdad6', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
              <Icon name="folder_off" size={20} color="#ba1a1a" />
            </div>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22', marginBottom: 8 }}>Delete folder?</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', lineHeight: 1.5, marginBottom: 24 }}>
              "<span style={{ color: '#1c1b22', fontWeight: 500 }}>{folder.name}</span>" will be deleted. Lists inside it will be moved out and kept.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowDeleteDialog(false)} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: '1px solid #E5E7EB', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleDelete} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#ba1a1a', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer' }}>Delete</button>
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
  active: 'dashboard' | 'calendar' | 'files' | 'list' | 'timeline' | 'settings' | 'folder' | 'gps' | 'templates';
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
            <Icon name={subExpanded ? 'expand_more' : 'chevron_right'} size={14} color="#b0acbe" />
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
          <div key={sub.id} style={{ paddingLeft: (sub.depth ?? 1) * 12, borderLeft: '2px solid #e8e4f0', marginLeft: 10 }}>
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
        style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 8, padding: collapsed ? '8px 0' : '8px 10px', justifyContent: collapsed ? 'center' : 'flex-start', width: '100%', borderRadius: 8, border: 'none', background: dropdownOpen ? '#F5F3FF' : 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 500, color: '#5e4dbb', transition: 'background 150ms' }}>
        <div style={{ width: 22, height: 22, borderRadius: 6, background: '#ede9fe', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
          {current?.image
            ? <img src={current.image} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <span style={{ fontSize: 13 }}>{current?.emoji ?? '🏠'}</span>
          }
        </div>
        {!collapsed && (
          <>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{current?.name ?? 'Select workspace'}</span>
            <Icon name="unfold_more" size={15} color="#9d8dff" />
          </>
        )}
      </button>

      {dropdownOpen && dropdownPos && (
        <div ref={dropRef}
          style={{ position: 'fixed', top: dropdownPos.top, left: dropdownPos.left, zIndex: 500, background: '#fff', borderRadius: 12, boxShadow: '0 4px 24px rgba(0,0,0,0.14)', border: '1px solid #e8e4f0', minWidth: 230, padding: '4px 0', animation: 'menuIn 140ms ease both', overflow: 'hidden' }}>

          {workspaces.length === 0 && (
            <div style={{ padding: '12px 14px', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#b0acbe' }}>No workspaces yet.</div>
          )}

          {workspaces.map(ws => (
            <div key={ws.id} style={{ overflow: 'hidden', animation: ws.id === deletingWorkspaceId ? 'wsItemOut 420ms ease forwards' : undefined }}>
              <button
                onClick={() => { if (ws.id === deletingWorkspaceId) return; setCurrentWorkspace(ws.id); setDropdownOpen(false); }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 14px', border: 'none', background: ws.id === currentWorkspaceId ? '#f5f3ff' : 'transparent', cursor: ws.id === deletingWorkspaceId ? 'default' : 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: ws.id === currentWorkspaceId ? 600 : 450, color: ws.id === currentWorkspaceId ? '#5e4dbb' : '#1c1b22', textAlign: 'left', pointerEvents: ws.id === deletingWorkspaceId ? 'none' : undefined }}
                onMouseEnter={e => { if (ws.id !== currentWorkspaceId && ws.id !== deletingWorkspaceId) e.currentTarget.style.background = '#f7f4fc'; }}
                onMouseLeave={e => { if (ws.id !== currentWorkspaceId) e.currentTarget.style.background = 'transparent'; }}>
                <div style={{ width: 26, height: 26, borderRadius: 8, background: '#ede9fe', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
                  {ws.image
                    ? <img src={ws.image} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <span style={{ fontSize: 14 }}>{ws.emoji ?? '🏠'}</span>
                  }
                </div>
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ws.name}</div>
                  {(() => {
                  if (ws.visibility === 'public') return <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 10.5, color: '#b0acbe' }}>Public</div>;
                  if ((ws.memberCount ?? 1) > 1) return <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 10.5, color: '#b0acbe' }}>Shared</div>;
                  return <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 10.5, color: '#b0acbe' }}>Private</div>;
                })()}
                </div>
                {ws.id === currentWorkspaceId && <Icon name="check" size={14} color="#5e4dbb" />}
              </button>
            </div>
          ))}

          <div style={{ height: 1, background: '#f0ecf8', margin: '4px 0' }} />

          {current && (current.role === 'owner' || current.ownerId === current.ownerId) && (
            <button
              onClick={() => { setShowSettings(true); setDropdownOpen(false); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 450, color: '#484552', textAlign: 'left' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <Icon name="settings" size={15} color="#787584" /> Workspace settings
            </button>
          )}

          <button
            onClick={() => { setShowWizard(true); setDropdownOpen(false); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#5e4dbb', textAlign: 'left' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <Icon name="add_circle" size={15} color="#5e4dbb" /> New workspace
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
  active: 'dashboard' | 'calendar' | 'files' | 'list' | 'timeline' | 'settings' | 'folder' | 'gps' | 'templates';
  activeListId?: string;
  activeTimelineId?: string;
  activeFolderId?: string;
  activeGpsFileId?: string;
  lists: List[];
  width: number;
  onNavigate: (path: string) => void;
  onOpenModal: (modal: 'add' | 'completed' | 'trash') => void;
  onReorderLists: (fromId: string, toId: string) => void;
  onResizeStart: (startX: number) => void;
  onTaskDropToList: (taskId: number, listId: string) => void;
  isMobile?: boolean;
  drawerOpen?: boolean;
}

function fmtDistShort(m?: number | null) {
  if (m == null) return null;
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
}

export default function Sidebar({ active, activeListId, activeTimelineId, activeFolderId, activeGpsFileId, lists, width, onNavigate, onOpenModal, onReorderLists, onResizeStart, onTaskDropToList, isMobile, drawerOpen }: SidebarProps) {
  const collapsed = isMobile ? false : width <= 72;
  const [addHov, setAddHov] = useState(false);
  const [folderHov, setFolderHov] = useState(false);
  const [templatesHov, setTemplatesHov] = useState(false);
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

  const { folders, timelines, addFolder, updateList, updateFolder, updateTimeline, setFolders, setTimelines, loadFromApi } = useAppStore();

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
    const taskId = e.dataTransfer.getData('dashtaskid');
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
  const standaloneListItems = lists.filter(l => !l.folderId || !loadedFolderIds.has(l.folderId));
  const standaloneTimelines = timelines.filter(t => !t.folderId || !loadedFolderIds.has(t.folderId));

  // ── GPS sidebar mode ───────────────────────────────────────────────────────
  if (active === 'gps') {
    return (
      <aside ref={asideRef} style={{
        width: isMobile ? 280 : width,
        minWidth: isMobile ? 280 : width,
        height: '100vh',
        background: '#f7f2fc',
        borderRight: '1px solid #E5E7EB',
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
        transition: isMobile ? 'left 260ms cubic-bezier(0.22,1,0.36,1)' : undefined,
      }}>
        {/* Resize handle — desktop only */}
        {!isMobile && (
          <div onMouseDown={e => { e.preventDefault(); onResizeStart(e.clientX); }}
            onMouseEnter={() => setHandleHov(true)} onMouseLeave={() => setHandleHov(false)}
            style={{ position: 'absolute', right: 0, top: 0, width: 6, height: '100%', cursor: 'col-resize', zIndex: 50, background: handleHov ? 'rgba(94,77,187,0.10)' : 'transparent', transition: 'background 150ms', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {handleHov && <div style={{ width: 2, height: 48, borderRadius: 2, background: '#9d8dff', opacity: 0.7 }} />}
          </div>
        )}

        {/* Logo / header */}
        <button type="button" onClick={() => onNavigate('/dashboard')} title={collapsed ? 'Dashboard' : undefined}
          style={{ padding: collapsed ? '12px 0 20px' : '12px 8px 20px', display: 'flex', flexDirection: 'column', alignItems: collapsed ? 'center' : 'flex-start', gap: 4, background: 'transparent', border: 'none', cursor: 'pointer', width: '100%', borderRadius: 8 }}>
          <img src="/solytiq-cloud.png" alt="Solytiq" style={{ width: isMobile ? 32 : 44, height: isMobile ? 32 : 44, borderRadius: isMobile ? 9 : 11, objectFit: 'cover', marginBottom: 6, flexShrink: 0 }} />
          {!collapsed && (
            <>
              <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 500, color: '#5e4dbb', lineHeight: 1.2, whiteSpace: 'nowrap' }}>Solytiq Cloud</div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.03em', whiteSpace: 'nowrap' }}>Your Routes. Your cloud.</div>
            </>
          )}
        </button>

        {/* Upload button */}
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('gps-upload-trigger'))}
          title={collapsed ? 'Upload Route' : undefined}
          style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 8, padding: collapsed ? '8px 0' : '8px 10px', justifyContent: collapsed ? 'center' : 'flex-start', borderRadius: 8, cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 500, color: '#5e4dbb', background: 'transparent', border: 'none', transition: 'background 200ms', width: '100%' }}
          onMouseEnter={e => (e.currentTarget.style.background = '#F5F3FF')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <Icon name="upload" size={19} color="#5e4dbb" />
          {!collapsed && <span>Upload Route</span>}
        </button>

        {!collapsed && <div style={{ height: 1, background: '#e8e4f0', margin: '2px 8px' }} />}

        {/* Search */}
        {!collapsed && (
          <div style={{ padding: '0 4px 4px', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #e8e4f0', borderRadius: 8, padding: '5px 8px' }}>
              <Icon name="search" size={14} color="#b0acbe" />
              <input
                value={gpsSearch}
                onChange={e => setGpsSearch(e.target.value)}
                placeholder="Search routes…"
                style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#1c1b22' }}
              />
              {gpsSearch && (
                <button onClick={() => setGpsSearch('')} style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}>
                  <Icon name="close" size={13} color="#b0acbe" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Route list */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
          {gpsLoading && !collapsed && (
            <div style={{ padding: '16px 8px', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe', textAlign: 'center' }}>Loading…</div>
          )}
          {!gpsLoading && gpsFiles.length === 0 && !collapsed && (
            <div style={{ padding: '20px 8px', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe', textAlign: 'center', lineHeight: 1.6 }}>
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
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', padding: '8px 0', border: 'none', background: isActive ? '#F5F3FF' : 'transparent', borderRadius: 8, cursor: 'pointer', transition: 'all 150ms' }}
                  >
                    <Icon name="route" size={18} color={isActive ? '#5e4dbb' : '#787584'} />
                  </button>
                </div>
              );
            }
            return (
              <div
                key={file.id}
                onClick={() => onNavigate(`/gps?file=${file.id}`)}
                style={{ background: isActive ? '#F5F3FF' : 'transparent', borderLeft: `3px solid ${isActive ? '#5e4dbb' : 'transparent'}`, borderRadius: 8, padding: '7px 8px 7px 6px', cursor: 'pointer', transition: 'all 150ms' }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = '#f1ecf6'; }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 4, background: file.fileType === 'gpx' ? '#ede9fe' : '#ccfbf1', color: file.fileType === 'gpx' ? '#5e4dbb' : '#0d9488', letterSpacing: '0.04em', flexShrink: 0 }}>
                    {file.fileType.toUpperCase()}
                  </span>
                  <span style={{ fontSize: 12.5, fontWeight: isActive ? 600 : 450, color: isActive ? '#5e4dbb' : '#1c1b22', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, fontFamily: 'Hanken Grotesk, sans-serif' }}>
                    {displayName}
                  </span>
                </div>
                {file.metadata && (
                  <div style={{ marginTop: 3, fontSize: 11, color: '#b0acbe', display: 'flex', gap: 8, paddingLeft: 2, fontFamily: 'Inter, sans-serif' }}>
                    {file.metadata.totalDistance != null && <span>{fmtDistShort(file.metadata.totalDistance)}</span>}
                    {file.metadata.totalElevationGain != null && file.metadata.totalElevationGain > 0 && <span>↑{Math.round(file.metadata.totalElevationGain)}m</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Bottom: version */}
        <div style={{ marginTop: 'auto', borderTop: '1px solid #e8e4f0', paddingTop: 8 }}>
          {!collapsed && (
            <div style={{ padding: '6px 10px 2px', fontFamily: 'Inter, sans-serif', fontSize: 10.5, color: '#c0bcd0', letterSpacing: '0.03em', userSelect: 'none' }}>
              v1.32.1
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
      background: '#f7f2fc',
      borderRight: '1px solid #E5E7EB',
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
      transition: isMobile ? 'left 260ms cubic-bezier(0.22,1,0.36,1)' : undefined,
    }}>

      {/* Resize handle — desktop only */}
      {!isMobile && (
        <div onMouseDown={e => { e.preventDefault(); onResizeStart(e.clientX); }}
          onMouseEnter={() => setHandleHov(true)} onMouseLeave={() => setHandleHov(false)}
          style={{ position: 'absolute', right: 0, top: 0, width: 6, height: '100%', cursor: 'col-resize', zIndex: 50, background: handleHov ? 'rgba(94,77,187,0.10)' : 'transparent', transition: 'background 150ms', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {handleHov && <div style={{ width: 2, height: 48, borderRadius: 2, background: '#9d8dff', opacity: 0.7 }} />}
        </div>
      )}

      {/* Logo / header */}
      <button type="button" onClick={() => onNavigate('/dashboard')} title={collapsed ? 'Dashboard' : undefined}
        style={{ padding: collapsed ? '12px 0 20px' : '12px 8px 20px', display: 'flex', flexDirection: 'column', alignItems: collapsed ? 'center' : 'flex-start', gap: 4, background: 'transparent', border: 'none', cursor: 'pointer', width: '100%', borderRadius: 8 }}>
        <img src="/solytiq-cloud.png" alt="Solytiq" style={{ width: 44, height: 44, borderRadius: 11, objectFit: 'cover', marginBottom: 6, flexShrink: 0 }} />
        {!collapsed && (
          <>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 500, color: '#5e4dbb', lineHeight: 1.2, whiteSpace: 'nowrap' }}>Solytiq Cloud</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.03em', whiteSpace: 'nowrap' }}>Your lists. Your cloud.</div>
          </>
        )}
      </button>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <WorkspaceSwitcher collapsed={collapsed} />

        {/* Templates — global gallery, not scoped to the current workspace */}
        <button
          onClick={() => onNavigate('/templates')}
          title={collapsed ? 'Templates' : undefined}
          onMouseEnter={() => setTemplatesHov(true)}
          onMouseLeave={() => setTemplatesHov(false)}
          style={{
            display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 8,
            padding: collapsed ? '8px 0' : '8px 10px', justifyContent: collapsed ? 'center' : 'flex-start',
            borderRadius: 8, cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5,
            fontWeight: active === 'templates' ? 700 : 500,
            color: active === 'templates' ? '#5e4dbb' : '#484552',
            background: active === 'templates' ? '#F5F3FF' : (templatesHov ? '#faf9ff' : 'transparent'),
            border: 'none', transition: 'background 150ms', width: '100%',
          }}>
          <Icon name="dashboard_customize" size={17} color={active === 'templates' ? '#5e4dbb' : '#787584'} />
          {!collapsed && <span>Templates</span>}
        </button>

        <div style={{ height: 1, background: '#e8e4f0', margin: '6px 8px' }} />

        {/* Add List / Add Folder buttons */}
        <div style={{ display: 'flex', gap: 4 }}>
          <button title={collapsed ? 'Add' : undefined}
            onMouseEnter={() => setAddHov(true)} onMouseLeave={() => setAddHov(false)}
            onClick={() => onOpenModal('add')}
            style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 8, padding: collapsed ? '8px 0' : '8px 10px', justifyContent: collapsed ? 'center' : 'flex-start', flex: 1, borderRadius: 8, cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 500, color: '#5e4dbb', background: addHov ? '#F5F3FF' : 'transparent', border: 'none', transition: 'background 200ms' }}>
            <Icon name="add" size={19} color="#5e4dbb" />
            {!collapsed && <span>Add</span>}
          </button>
          {!collapsed && (
            <button title="Add Folder"
              onMouseEnter={() => setFolderHov(true)} onMouseLeave={() => setFolderHov(false)}
              onClick={() => { setAddingFolder(true); setTimeout(() => folderInputRef.current?.focus(), 50); }}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, border: 'none', background: folderHov ? '#F5F3FF' : 'transparent', cursor: 'pointer', padding: 0, flexShrink: 0, transition: 'background 200ms', alignSelf: 'center' }}>
              <Icon name="create_new_folder" size={17} color="#5e4dbb" />
            </button>
          )}
        </div>

        {/* New folder input */}
        {addingFolder && !collapsed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: '#f0edff', borderRadius: 8, border: '1.5px solid #c4b5fd' }}>
            <Icon name="folder" size={15} color="#5e4dbb" />
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
              style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, border: 'none', outline: 'none', background: 'transparent', color: '#1c1b22' }}
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
                if (e.dataTransfer.types.includes('dashtaskid')) {
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
                if (e.dataTransfer.types.includes('dashtaskid')) {
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

      <div style={{ marginTop: 'auto', borderTop: '1px solid #e8e4f0', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <NavItem icon="check_circle" label="Completed" active={false} onClick={() => onOpenModal('completed')} collapsed={collapsed} />
        <NavItem icon="delete" label="Trash" active={false} onClick={() => onOpenModal('trash')} collapsed={collapsed} />
        {!collapsed && (
          <div style={{ padding: '6px 10px 2px', fontFamily: 'Inter, sans-serif', fontSize: 10.5, color: '#c0bcd0', letterSpacing: '0.03em', userSelect: 'none' }}>
            v1.32.1
          </div>
        )}
      </div>
    </aside>
  );
}
