import { useState, useCallback, useRef, useEffect } from 'react';
import type { List, Folder } from '../types';
import Icon from './Icon';
import useAppStore from '../store/useAppStore';

const MINI = 60;

const FOLDER_COLORS = [
  '#5e4dbb', '#1D4ED8', '#15803d', '#ea580c',
  '#db2777', '#ba1a1a', '#0d9488', '#6b7280',
];

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

// ── ListItemRow ───────────────────────────────────────────────────────────────
interface ListItemRowProps {
  list: List;
  isActive: boolean;
  collapsed: boolean;
  indented?: boolean;
  dragOverId: string | null;
  folders: Folder[];
  onNavigate: (path: string) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}
function ListItemRow({ list, isActive, collapsed, indented, dragOverId, folders, onNavigate, onDragStart, onDragOver, onDragLeave, onDrop }: ListItemRowProps) {
  const [hov, setHov] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [showAccessibility, setShowAccessibility] = useState(false);
  const [showMoveToFolder, setShowMoveToFolder] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(list.name);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { deleteList, updateList } = useAppStore();

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        menuBtnRef.current && !menuBtnRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
        setShowAccessibility(false);
        setShowMoveToFolder(false);
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
    setShowAccessibility(false);
    setShowMoveToFolder(false);
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

  const handleMoveToFolder = (folderId: string | undefined) => {
    updateList(list.id, { folderId });
    setMenuOpen(false);
    setShowMoveToFolder(false);
  };

  const otherFolders = folders.filter(f => f.id !== list.folderId);
  const inFolder = !!list.folderId;

  return (
    <>
      <div draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{ display: 'flex', alignItems: 'center', borderRadius: 8, borderTop: dragOverId === list.id ? '2px solid #9d8dff' : '2px solid transparent', transition: 'border-color 120ms', paddingLeft: indented ? 8 : 0 }}>

        {editingName && !collapsed ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', padding: '4px 8px' }}>
            <input
              autoFocus
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onBlur={handleRename}
              onKeyDown={e => {
                if (e.key === 'Enter') handleRename();
                if (e.key === 'Escape') { setEditingName(false); setNameInput(list.name); }
              }}
              style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, border: 'none', borderBottom: '1.5px solid #5e4dbb', outline: 'none', background: 'transparent', color: '#1c1b22', padding: '2px 4px' }}
            />
          </div>
        ) : (
          <button title={collapsed ? list.name : undefined}
            onClick={() => onNavigate(`/list/${list.id}`)}
            style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 10, padding: collapsed ? '8px 0' : '8px 10px', justifyContent: collapsed ? 'center' : 'flex-start', flex: 1, background: hov ? (list.colorBg ?? '#f1ecf6') : 'transparent', color: isActive ? (list.color ?? '#5e4dbb') : '#484552', fontWeight: isActive ? 600 : 450, borderRadius: 8, transition: 'all 150ms', cursor: 'pointer', border: 'none', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, textAlign: 'left', width: '100%' }}>
            {list.emoji
              ? <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>{list.emoji}</span>
              : <Icon name="format_list_bulleted" size={19} color={isActive ? (list.color ?? '#5e4dbb') : '#787584'} />
            }
            {!collapsed && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{list.name}</span>}
          </button>
        )}

        {!collapsed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, paddingRight: 4, flexShrink: 0 }}>
            {list.isPublic
              ? <Icon name="public" size={13} color="#b0acbe" />
              : <Icon name="lock" size={13} color="#b0acbe" />
            }
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
      </div>

      {/* Dropdown menu */}
      {menuOpen && menuPos && (
        <div ref={menuRef}
          style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, zIndex: 400, background: '#fff', borderRadius: 10, boxShadow: '0 4px 20px rgba(0,0,0,0.13)', border: '1px solid #e8e4f0', minWidth: 180, padding: '4px 0' }}>
          <button
            onClick={() => { setMenuOpen(false); setEditingName(true); setNameInput(list.name); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#1c1b22', textAlign: 'left' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Icon name="edit" size={15} color="#787584" />
            Edit name
          </button>

          <button
            onClick={() => setShowAccessibility(a => !a)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: showAccessibility ? '#f5f3ff' : 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#1c1b22', textAlign: 'left' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
            onMouseLeave={e => { if (!showAccessibility) e.currentTarget.style.background = 'transparent'; }}
          >
            <Icon name={list.isPublic ? 'public' : 'lock'} size={15} color="#787584" />
            Accessibility
            <span style={{ marginLeft: 'auto' }}>
              <Icon name={showAccessibility ? 'expand_less' : 'expand_more'} size={14} color="#b0acbe" />
            </span>
          </button>

          {showAccessibility && (
            <div style={{ padding: '2px 8px 4px', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {([{ label: 'Public', val: true }, { label: 'Private', val: false }] as const).map(opt => {
                const selected = list.isPublic === opt.val;
                return (
                  <button key={opt.label}
                    onClick={() => { updateList(list.id, { isPublic: opt.val }); setMenuOpen(false); setShowAccessibility(false); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', border: 'none', borderRadius: 6, background: selected ? '#f0edff' : 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: selected ? 600 : 450, color: selected ? '#5e4dbb' : '#484552', textAlign: 'left', width: '100%' }}
                    onMouseEnter={e => { if (!selected) e.currentTarget.style.background = '#f5f3ff'; }}
                    onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <Icon name={opt.val ? 'public' : 'lock'} size={13} color={selected ? '#5e4dbb' : '#787584'} />
                    {opt.label}
                    {selected && <span style={{ marginLeft: 'auto' }}><Icon name="check" size={13} color="#5e4dbb" /></span>}
                  </button>
                );
              })}
            </div>
          )}

          {/* Move to folder */}
          {folders.length > 0 && (
            <button
              onClick={() => setShowMoveToFolder(f => !f)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: showMoveToFolder ? '#f5f3ff' : 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#1c1b22', textAlign: 'left' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
              onMouseLeave={e => { if (!showMoveToFolder) e.currentTarget.style.background = 'transparent'; }}
            >
              <Icon name="folder_open" size={15} color="#787584" />
              Move to folder
              <span style={{ marginLeft: 'auto' }}>
                <Icon name={showMoveToFolder ? 'expand_less' : 'expand_more'} size={14} color="#b0acbe" />
              </span>
            </button>
          )}

          {showMoveToFolder && (
            <div style={{ padding: '2px 8px 4px', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {inFolder && (
                <button
                  onClick={() => handleMoveToFolder(undefined)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', border: 'none', borderRadius: 6, background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 500, color: '#484552', textAlign: 'left', width: '100%' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <Icon name="remove_circle_outline" size={13} color="#787584" />
                  Remove from folder
                </button>
              )}
              {otherFolders.map(f => (
                <button key={f.id}
                  onClick={() => handleMoveToFolder(f.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', border: 'none', borderRadius: 6, background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 500, color: '#484552', textAlign: 'left', width: '100%' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  {f.emoji
                    ? <span style={{ fontSize: 13 }}>{f.emoji}</span>
                    : <Icon name="folder" size={13} color={f.color ?? '#787584'} />
                  }
                  <span style={{ color: f.color ?? '#484552' }}>{f.name}</span>
                </button>
              ))}
            </div>
          )}

          <div style={{ height: 1, background: '#f0ecf8', margin: '3px 0' }} />

          <button
            onClick={() => { setMenuOpen(false); setShowDeleteDialog(true); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#ba1a1a', textAlign: 'left' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#fff0ef')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Icon name="delete" size={15} color="#ba1a1a" />
            Delete list
          </button>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {showDeleteDialog && (
        <div
          onClick={() => setShowDeleteDialog(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
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
        </div>
      )}
    </>
  );
}

// ── FolderRow ─────────────────────────────────────────────────────────────────
interface FolderRowProps {
  folder: Folder;
  lists: List[];
  active: 'dashboard' | 'scheduled' | 'list' | 'settings';
  activeListId?: string;
  collapsed: boolean;
  dragOverId: string | null;
  dragOverFolderId: string | null;
  allFolders: Folder[];
  onNavigate: (path: string) => void;
  onListDragStart: (listId: string, e: React.DragEvent) => void;
  onListDragOver: (listId: string, e: React.DragEvent) => void;
  onListDragLeave: () => void;
  onListDrop: (listId: string, e: React.DragEvent) => void;
  onFolderDragOver: (folderId: string, e: React.DragEvent) => void;
  onFolderDragLeave: () => void;
  onFolderDrop: (folderId: string, e: React.DragEvent) => void;
}
function FolderRow({ folder, lists, active, activeListId, collapsed, dragOverId, dragOverFolderId, allFolders, onNavigate, onListDragStart, onListDragOver, onListDragLeave, onListDrop, onFolderDragOver, onFolderDragLeave, onFolderDrop }: FolderRowProps) {
  const [hov, setHov] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(folder.name);
  const [showEmojiInput, setShowEmojiInput] = useState(false);
  const [emojiInput, setEmojiInput] = useState(folder.emoji ?? '');
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { updateFolder, deleteFolder } = useAppStore();

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        menuBtnRef.current && !menuBtnRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
        setShowEmojiInput(false);
        setShowColorPicker(false);
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
    setShowEmojiInput(false);
    setShowColorPicker(false);
  };

  const handleRename = () => {
    const trimmed = nameInput.trim();
    if (trimmed && trimmed !== folder.name) updateFolder(folder.id, { name: trimmed });
    setEditingName(false);
  };

  const handleEmojiSave = () => {
    updateFolder(folder.id, { emoji: emojiInput.trim() || undefined });
    setShowEmojiInput(false);
    setMenuOpen(false);
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

  return (
    <>
      {/* Folder header */}
      <div
        onDragOver={e => onFolderDragOver(folder.id, e)}
        onDragLeave={onFolderDragLeave}
        onDrop={e => onFolderDrop(folder.id, e)}
        onMouseEnter={() => setHov(true)}
        onMouseLeave={() => setHov(false)}
        style={{ display: 'flex', alignItems: 'center', borderRadius: 8, border: isDragTarget ? `2px solid ${accentColor}` : '2px solid transparent', transition: 'border-color 120ms', background: isDragTarget ? `${accentColor}15` : 'transparent' }}>

        {editingName && !collapsed ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', padding: '4px 8px' }}>
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
          <button
            onClick={collapsed ? undefined : toggleCollapsed}
            title={collapsed ? folder.name : undefined}
            style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 8, padding: collapsed ? '8px 0' : '6px 8px', justifyContent: collapsed ? 'center' : 'flex-start', flex: 1, background: 'transparent', borderRadius: 8, transition: 'all 150ms', cursor: 'pointer', border: 'none', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, textAlign: 'left', width: '100%', color: accentColor }}>
            {!collapsed && (
              <Icon name={folder.collapsed ? 'chevron_right' : 'expand_more'} size={14} color={accentColor} />
            )}
            {folder.emoji
              ? <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>{folder.emoji}</span>
              : <Icon name="folder" size={17} color={accentColor} />
            }
            {!collapsed && (
              <span style={{ fontWeight: 600, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '0.01em' }}>
                {folder.name}
              </span>
            )}
          </button>
        )}

        {!collapsed && (
          <div style={{ display: 'flex', alignItems: 'center', paddingRight: 4, flexShrink: 0 }}>
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
                onNavigate={onNavigate}
                onDragStart={e => onListDragStart(list.id, e)}
                onDragOver={e => onListDragOver(list.id, e)}
                onDragLeave={onListDragLeave}
                onDrop={e => onListDrop(list.id, e)}
              />
            );
          })}
          {lists.length === 0 && (
            <div style={{ padding: '6px 10px', fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe', fontStyle: 'italic' }}>
              No lists yet
            </div>
          )}
        </div>
      )}

      {/* Folder 3-dot menu */}
      {menuOpen && menuPos && (
        <div ref={menuRef}
          style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, zIndex: 400, background: '#fff', borderRadius: 10, boxShadow: '0 4px 20px rgba(0,0,0,0.13)', border: '1px solid #e8e4f0', minWidth: 180, padding: '4px 0' }}>

          <button
            onClick={() => { setMenuOpen(false); setEditingName(true); setNameInput(folder.name); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#1c1b22', textAlign: 'left' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Icon name="edit" size={15} color="#787584" />
            Rename
          </button>

          <button
            onClick={() => { setShowEmojiInput(e => !e); setShowColorPicker(false); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: showEmojiInput ? '#f5f3ff' : 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#1c1b22', textAlign: 'left' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
            onMouseLeave={e => { if (!showEmojiInput) e.currentTarget.style.background = 'transparent'; }}
          >
            <Icon name="mood" size={15} color="#787584" />
            Set emoji
            <span style={{ marginLeft: 'auto' }}>
              <Icon name={showEmojiInput ? 'expand_less' : 'expand_more'} size={14} color="#b0acbe" />
            </span>
          </button>

          {showEmojiInput && (
            <div style={{ padding: '4px 14px 8px', display: 'flex', gap: 6 }}>
              <input
                autoFocus
                value={emojiInput}
                onChange={e => setEmojiInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleEmojiSave(); if (e.key === 'Escape') setShowEmojiInput(false); }}
                placeholder="Emoji…"
                style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, border: '1.5px solid #d4cfe8', borderRadius: 6, padding: '4px 8px', outline: 'none', background: '#f9f7ff', color: '#1c1b22', width: 70 }}
              />
              <button onClick={handleEmojiSave} style={{ padding: '4px 10px', background: '#5e4dbb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600 }}>Set</button>
            </div>
          )}

          <button
            onClick={() => { setShowColorPicker(c => !c); setShowEmojiInput(false); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: showColorPicker ? '#f5f3ff' : 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#1c1b22', textAlign: 'left' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
            onMouseLeave={e => { if (!showColorPicker) e.currentTarget.style.background = 'transparent'; }}
          >
            <div style={{ width: 14, height: 14, borderRadius: '50%', background: folder.color ?? '#787584', border: '1.5px solid #e0dcea', flexShrink: 0 }} />
            Set color
            <span style={{ marginLeft: 'auto' }}>
              <Icon name={showColorPicker ? 'expand_less' : 'expand_more'} size={14} color="#b0acbe" />
            </span>
          </button>

          {showColorPicker && (
            <div style={{ padding: '4px 14px 8px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {FOLDER_COLORS.map(c => (
                <button key={c} onClick={() => { updateFolder(folder.id, { color: c }); setShowColorPicker(false); setMenuOpen(false); }}
                  title={c}
                  style={{ width: 22, height: 22, borderRadius: '50%', background: c, border: folder.color === c ? '2.5px solid #1c1b22' : '2px solid transparent', cursor: 'pointer', padding: 0, outline: 'none', transition: 'border 120ms' }} />
              ))}
            </div>
          )}

          <div style={{ height: 1, background: '#f0ecf8', margin: '3px 0' }} />

          <button
            onClick={() => { setMenuOpen(false); setShowDeleteDialog(true); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#ba1a1a', textAlign: 'left' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#fff0ef')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Icon name="delete" size={15} color="#ba1a1a" />
            Delete folder
          </button>
        </div>
      )}

      {/* Delete folder confirmation */}
      {showDeleteDialog && (
        <div
          onClick={() => setShowDeleteDialog(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
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
        </div>
      )}
    </>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
interface SidebarProps {
  active: 'dashboard' | 'scheduled' | 'list' | 'settings';
  activeListId?: string;
  lists: List[];
  width: number;
  onNavigate: (path: string) => void;
  onOpenModal: (modal: 'add-list' | 'completed' | 'trash') => void;
  onReorderLists: (fromId: string, toId: string) => void;
  onResizeStart: (startX: number) => void;
}

export default function Sidebar({ active, activeListId, lists, width, onNavigate, onOpenModal, onReorderLists, onResizeStart }: SidebarProps) {
  const collapsed = width <= 72;
  const [addHov, setAddHov] = useState(false);
  const [folderHov, setFolderHov] = useState(false);
  const [handleHov, setHandleHov] = useState(false);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [addingFolder, setAddingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const folderInputRef = useRef<HTMLInputElement>(null);

  const { folders, addFolder, updateList } = useAppStore();

  const handleListDrop = useCallback((toId: string, e: React.DragEvent) => {
    e.preventDefault();
    const fromId = e.dataTransfer.getData('listId');
    if (fromId && fromId !== toId) onReorderLists(fromId, toId);
    setDragOverId(null);
  }, [onReorderLists]);

  const handleFolderDrop = useCallback((folderId: string, e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const listId = e.dataTransfer.getData('listId');
    if (listId) updateList(listId, { folderId });
    setDragOverFolderId(null);
  }, [updateList]);

  const handleCreateFolder = () => {
    const name = newFolderName.trim();
    if (name) {
      addFolder({ id: `folder_${Date.now()}`, name, position: folders.length, collapsed: false });
    }
    setNewFolderName('');
    setAddingFolder(false);
  };

  const standaloneListItems = lists.filter(l => !l.folderId);

  return (
    <aside style={{ width, minWidth: width, height: '100vh', background: '#f7f2fc', borderRight: '1px solid #E5E7EB', display: 'flex', flexDirection: 'column', padding: collapsed ? '16px 6px' : '16px 12px', gap: 4, position: 'fixed', left: 0, top: 0, zIndex: 40, overflowY: 'auto', overflowX: 'hidden', boxSizing: 'border-box' }}>

      {/* Resize handle */}
      <div onMouseDown={e => { e.preventDefault(); onResizeStart(e.clientX); }}
        onMouseEnter={() => setHandleHov(true)} onMouseLeave={() => setHandleHov(false)}
        style={{ position: 'absolute', right: 0, top: 0, width: 6, height: '100%', cursor: 'col-resize', zIndex: 50, background: handleHov ? 'rgba(94,77,187,0.10)' : 'transparent', transition: 'background 150ms', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {handleHov && <div style={{ width: 2, height: 48, borderRadius: 2, background: '#9d8dff', opacity: 0.7 }} />}
      </div>

      {/* Logo / header */}
      <button type="button" onClick={() => onNavigate('/dashboard')} title={collapsed ? 'Dashboard' : undefined}
        style={{ padding: collapsed ? '12px 0 20px' : '12px 8px 20px', display: 'flex', flexDirection: 'column', alignItems: collapsed ? 'center' : 'flex-start', gap: 4, background: 'transparent', border: 'none', cursor: 'pointer', width: '100%', borderRadius: 8 }}>
        <img src="/solytiq-todo-logo.svg" alt="Solytiq" style={{ width: 44, height: 44, borderRadius: 11, objectFit: 'cover', marginBottom: 6, flexShrink: 0 }} />
        {!collapsed && (
          <>
            <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 500, color: '#5e4dbb', lineHeight: 1.2, whiteSpace: 'nowrap' }}>Solytiq Cloud</div>
            <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.03em', whiteSpace: 'nowrap' }}>Your lists. Your cloud.</div>
          </>
        )}
      </button>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <NavItem icon="today" label="Dashboard" active={active === 'dashboard'} onClick={() => onNavigate('/dashboard')} collapsed={collapsed} />
        <NavItem icon="calendar_month" label="Scheduled" active={active === 'scheduled'} onClick={() => onNavigate('/scheduled')} collapsed={collapsed} />

        <div style={{ height: 1, background: '#e8e4f0', margin: '6px 8px' }} />

        {/* Add List / Add Folder buttons */}
        <div style={{ display: 'flex', gap: 4 }}>
          <button title={collapsed ? 'Add List' : undefined}
            onMouseEnter={() => setAddHov(true)} onMouseLeave={() => setAddHov(false)}
            onClick={() => onOpenModal('add-list')}
            style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 8, padding: collapsed ? '8px 0' : '8px 10px', justifyContent: collapsed ? 'center' : 'flex-start', flex: 1, borderRadius: 8, cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 500, color: '#5e4dbb', background: addHov ? '#F5F3FF' : 'transparent', border: 'none', transition: 'background 200ms' }}>
            <Icon name="add" size={19} color="#5e4dbb" />
            {!collapsed && <span>Add List</span>}
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
        {folders.map(folder => {
          const folderLists = lists.filter(l => l.folderId === folder.id);
          return (
            <FolderRow
              key={folder.id}
              folder={folder}
              lists={folderLists}
              active={active}
              activeListId={activeListId}
              collapsed={collapsed}
              dragOverId={dragOverId}
              dragOverFolderId={dragOverFolderId}
              allFolders={folders}
              onNavigate={onNavigate}
              onListDragStart={(listId, e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('listId', listId); }}
              onListDragOver={(listId, e) => { e.preventDefault(); setDragOverId(listId); }}
              onListDragLeave={() => setDragOverId(null)}
              onListDrop={(listId, e) => handleListDrop(listId, e)}
              onFolderDragOver={(folderId, e) => { e.preventDefault(); setDragOverFolderId(folderId); }}
              onFolderDragLeave={() => setDragOverFolderId(null)}
              onFolderDrop={handleFolderDrop}
            />
          );
        })}

        {/* Standalone lists */}
        {standaloneListItems.map((list) => {
          const isActive = active === 'list' && activeListId === list.id;
          return (
            <ListItemRow
              key={list.id}
              list={list}
              isActive={isActive}
              collapsed={collapsed}
              dragOverId={dragOverId}
              folders={folders}
              onNavigate={onNavigate}
              onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('listId', list.id); }}
              onDragOver={e => { e.preventDefault(); setDragOverId(list.id); }}
              onDragLeave={() => setDragOverId(null)}
              onDrop={e => handleListDrop(list.id, e)}
            />
          );
        })}
      </div>

      <div style={{ marginTop: 'auto', borderTop: '1px solid #e8e4f0', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <NavItem icon="check_circle" label="Completed" active={false} onClick={() => onOpenModal('completed')} collapsed={collapsed} />
        <NavItem icon="delete" label="Trash" active={false} onClick={() => onOpenModal('trash')} collapsed={collapsed} />
      </div>
    </aside>
  );
}
