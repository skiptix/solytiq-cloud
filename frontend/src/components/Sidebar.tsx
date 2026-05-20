import { useState, useCallback } from 'react';
import type { List } from '../types';
import Icon from './Icon';

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
  return (
    <div key={list.id} draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ display: 'flex', alignItems: 'center', borderRadius: 8, borderTop: dragOverId === list.id ? '2px solid #9d8dff' : '2px solid transparent', transition: 'border-color 120ms' }}>
      <button title={collapsed ? list.name : undefined}
        onClick={() => onNavigate(`/list/${list.id}`)}
        style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 10, padding: collapsed ? '8px 0' : '8px 10px', justifyContent: collapsed ? 'center' : 'flex-start', flex: 1, background: hov ? (list.colorBg ?? '#f1ecf6') : 'transparent', color: isActive ? (list.color ?? '#5e4dbb') : '#484552', fontWeight: isActive ? 600 : 450, borderRadius: 8, transition: 'all 150ms', cursor: 'pointer', border: 'none', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, textAlign: 'left', width: '100%' }}>
        {list.emoji
          ? <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>{list.emoji}</span>
          : <Icon name="format_list_bulleted" size={19} color={isActive ? (list.color ?? '#5e4dbb') : '#787584'} />
        }
        {!collapsed && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{list.name}</span>}
      </button>
      {!collapsed && (
        <div style={{ opacity: hov ? 1 : 0, transition: 'opacity 150ms', cursor: 'grab', padding: '0 6px', display: 'flex', alignItems: 'center' }}>
          <Icon name="drag_indicator" size={15} color="#c9c4d5" />
        </div>
      )}
    </div>
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
        <img src="/assets/solytiq-todo-logo.svg" alt="Solytiq" style={{ width: 44, height: 44, borderRadius: 11, objectFit: 'cover', marginBottom: 6, flexShrink: 0 }} />
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
