import { useState, useCallback, useRef, useEffect } from 'react';
import type { List } from '../types';
import Icon from './Icon';
import useAppStore from '../store/useAppStore';

const MINI = 60;

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

interface ListItemRowProps {
  list: List;
  isActive: boolean;
  collapsed: boolean;
  dragOverId: string | null;
  onNavigate: (path: string) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}
function ListItemRow({ list, isActive, collapsed, dragOverId, onNavigate, onDragStart, onDragOver, onDragLeave, onDrop }: ListItemRowProps) {
  const [hov, setHov] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [showAccessibility, setShowAccessibility] = useState(false);
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

  return (
    <>
      <div draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        style={{ display: 'flex', alignItems: 'center', borderRadius: 8, borderTop: dragOverId === list.id ? '2px solid #9d8dff' : '2px solid transparent', transition: 'border-color 120ms' }}>

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
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 20, height: 20, borderRadius: 4, border: 'none',
                background: menuOpen ? '#ebe6f0' : 'transparent',
                cursor: 'pointer', padding: 0,
                opacity: hov || menuOpen ? 1 : 0,
                transition: 'opacity 150ms, background 120ms',
              }}
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
          style={{
            position: 'fixed', top: menuPos.top, left: menuPos.left,
            zIndex: 400, background: '#fff', borderRadius: 10,
            boxShadow: '0 4px 20px rgba(0,0,0,0.13)', border: '1px solid #e8e4f0',
            minWidth: 170, padding: '4px 0',
          }}>
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
  const [handleHov, setHandleHov] = useState(false);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const handleListDrop = useCallback((toId: string, e: React.DragEvent) => {
    e.preventDefault();
    const fromId = e.dataTransfer.getData('listId');
    if (fromId && fromId !== toId) onReorderLists(fromId, toId);
    setDragOverId(null);
  }, [onReorderLists]);

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

        <button title={collapsed ? 'Add List' : undefined}
          onMouseEnter={() => setAddHov(true)} onMouseLeave={() => setAddHov(false)}
          onClick={() => onOpenModal('add-list')}
          style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 10, padding: collapsed ? '8px 0' : '8px 10px', justifyContent: collapsed ? 'center' : 'flex-start', borderRadius: 8, cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 500, color: '#5e4dbb', background: addHov ? '#F5F3FF' : 'transparent', border: 'none', width: '100%', transition: 'background 200ms' }}>
          <Icon name="add" size={19} color="#5e4dbb" />
          {!collapsed && <span>Add List</span>}
        </button>

        {lists.map((list) => {
          const isActive = active === 'list' && activeListId === list.id;
          return (
            <ListItemRow
              key={list.id}
              list={list}
              isActive={isActive}
              collapsed={collapsed}
              dragOverId={dragOverId}
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
