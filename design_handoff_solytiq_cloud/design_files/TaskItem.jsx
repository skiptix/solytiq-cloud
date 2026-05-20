// Solytiq Cloud — Task Item + Context Menu + Modals
// Export: window.TaskItem, window.QuickAdd

// ─── Shared styles ─────────────────────────────────────────────
const taskStyles = {
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, transition: 'background 200ms ease-in-out', position: 'relative' },
  rowHover: { background: '#F5F3FF' },
  checkbox: { width: 20, height: 20, minWidth: 20, borderRadius: 5, border: '1.5px solid #c9c4d5', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms ease-in-out', flexShrink: 0 },
  checkboxChecked: { background: '#5e4dbb', borderColor: '#5e4dbb' },
  content: { flex: 1, minWidth: 0 },
  title: { fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#1c1b22', lineHeight: 1.4 },
  titleDone: { opacity: 0.4, textDecoration: 'line-through' },
  note: { fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2 },
  meta: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' },
  time: { fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584', display: 'flex', alignItems: 'center', gap: 3 },
  badge: { display: 'inline-flex', alignItems: 'center', borderRadius: 9999, padding: '1px 8px', fontSize: 10, fontWeight: 600 },
  moreBtn: { display: 'flex', alignItems: 'center', padding: 4, borderRadius: 4, background: 'transparent', border: 'none', cursor: 'pointer', transition: 'opacity 200ms, background 150ms', flexShrink: 0 },
};

const BADGE_COLORS = {
  Work:     { bg: '#f9e287', color: '#6e5e0d' },
  Personal: { bg: '#F5F3FF', color: '#5e4dbb' },
  Urgent:   { bg: '#ffdad6', color: '#ba1a1a' },
  Tip:      { bg: '#eff6ff', color: '#1D4ED8' },
  Default:  { bg: '#F5F3FF', color: '#484552' }
};

const PRIORITIES = ['High', 'Medium', 'Low'];
const PRIORITY_COLORS = { High: '#ea580c', Medium: '#f59e0b', Low: '#787584' };
const TAGS = ['Work', 'Personal', 'Urgent', 'Tip'];

function CheckMark() {
  return (
    <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
      <path d="M1 4.5L4 7.5L10 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// ─── Context Menu ───────────────────────────────────────────────
function ContextMenu({ onEdit, onDelete, onClose }) {
  React.useEffect(() => {
    const handler = () => onClose();
    const t = setTimeout(() => document.addEventListener('click', handler), 0);
    return () => { clearTimeout(t); document.removeEventListener('click', handler); };
  }, []);

  const itemStyle = { display: 'block', width: '100%', textAlign: 'left', padding: '9px 16px', background: 'transparent', border: 'none', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, cursor: 'pointer', transition: 'background 150ms' };

  return (
    <div style={{ position: 'absolute', right: 0, top: 32, zIndex: 200, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.10)', minWidth: 128, overflow: 'hidden', animation: 'menuIn 180ms cubic-bezier(0.34,1.56,0.64,1) both', transformOrigin: 'top right' }}
      onClick={e => e.stopPropagation()}>
      <style>{`
        @keyframes menuIn {
          from { opacity: 0; transform: scale(0.88) translateY(-6px); }
          to   { opacity: 1; transform: scale(1)    translateY(0); }
        }
        @keyframes menuItemIn {
          from { opacity: 0; transform: translateX(6px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        .menu-item-edit   { animation: menuItemIn 160ms 60ms ease both; }
        .menu-item-delete { animation: menuItemIn 160ms 110ms ease both; }
        .menu-item-edit:hover   { background: #F5F3FF !important; }
        .menu-item-delete:hover { background: #fff5f5 !important; }
      `}</style>
      <button className="menu-item-edit" style={{ ...itemStyle, color: '#1c1b22' }} onClick={onEdit}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="edit" size={14} color="#5e4dbb" /> Edit
        </span>
      </button>
      <div style={{ height: 1, background: '#F5F3FF' }} />
      <button className="menu-item-delete" style={{ ...itemStyle, color: '#ba1a1a' }} onClick={onDelete}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="delete" size={14} color="#ba1a1a" /> Delete
        </span>
      </button>
    </div>
  );
}

// ─── Delete Confirmation Modal ──────────────────────────────────
function DeleteConfirmModal({ task, onConfirm, onCancel }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={onCancel}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 380, width: '100%', boxShadow: '0 8px 32px rgba(0,0,0,0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}
        onClick={e => e.stopPropagation()}>
        <style>{`@keyframes modalIn{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:scale(1)}}`}</style>
        <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#ffdad6', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
          <Icon name="delete" size={20} color="#ba1a1a" />
        </div>
        <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22', marginBottom: 8 }}>Delete task?</div>
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', lineHeight: 1.5, marginBottom: 24 }}>
          "<span style={{ color: '#1c1b22', fontWeight: 500 }}>{task.title}</span>" will be permanently removed.
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: '1px solid #E5E7EB', borderRadius: 8, padding: '8px 18px', cursor: 'pointer', transition: 'all 180ms' }}
            onMouseEnter={e => e.currentTarget.style.background='#f7f2fc'}
            onMouseLeave={e => e.currentTarget.style.background='transparent'}>
            Cancel
          </button>
          <button onClick={onConfirm} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: '#ba1a1a', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer', transition: 'all 180ms' }}
            onMouseEnter={e => e.currentTarget.style.background='#a01616'}
            onMouseLeave={e => e.currentTarget.style.background='#ba1a1a'}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Edit Modal ─────────────────────────────────────────────────
// mode: 'edit' (default) → "Edit Task" + "Save Changes"
//       'create'         → "New Task"  + "Add Task"
function EditModal({ task = {}, mode = 'edit', onSave, onClose }) {
  const [title, setTitle] = React.useState(task.title || '');
  const [notes, setNotes] = React.useState(task.note || '');
  const [deadline, setDeadline] = React.useState(task.deadline || '');
  const [priority, setPriority] = React.useState(task.priority || '');
  const [tag, setTag] = React.useState(task.badge || '');
  const [showCal, setShowCal] = React.useState(false);

  const isCreate = mode === 'create';
  const headerTitle = isCreate ? 'New Task' : 'Edit Task';
  const submitLabel = isCreate ? 'Add Task' : 'Save Changes';
  const canSubmit = title.trim().length > 0;

  const fieldLabel = { fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', marginBottom: 5, display: 'block' };
  const fieldInput = { width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#1c1b22', background: 'transparent', border: 'none', borderBottom: '1.5px solid #E5E7EB', padding: '7px 0', outline: 'none', transition: 'border-color 200ms' };

  const handleSave = () => {
    onSave({ title, note: notes, deadline, priority: priority || undefined, badge: tag || undefined });
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 440, boxShadow: '0 8px 32px rgba(0,0,0,0.14)', animation: 'modalIn 280ms cubic-bezier(0.34,1.56,0.64,1) both' }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px 16px', borderBottom: '1px solid #F5F3FF' }}>
          <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 700, color: '#1c1b22' }}>{headerTitle}</span>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#787584', transition: 'background 150ms' }}
            onMouseEnter={e => e.currentTarget.style.background='#f1ecf6'}
            onMouseLeave={e => e.currentTarget.style.background='transparent'}>
            <Icon name="close" size={16} color="#787584" />
          </button>
        </div>

        {/* Form */}
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Title */}
          <div>
            <label style={fieldLabel}>Task Name</label>
            <input value={title} onChange={e => setTitle(e.target.value)} style={fieldInput}
              onFocus={e => e.target.style.borderBottomColor='#5e4dbb'}
              onBlur={e => e.target.style.borderBottomColor='#E5E7EB'} />
          </div>

          {/* Notes */}
          <div>
            <label style={fieldLabel}>Notes</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
              style={{ ...fieldInput, resize: 'none', lineHeight: 1.5 }}
              onFocus={e => e.target.style.borderBottomColor='#5e4dbb'}
              onBlur={e => e.target.style.borderBottomColor='#E5E7EB'} />
          </div>

          {/* Deadline */}
          <div style={{ position: 'relative' }}>
            <label style={fieldLabel}>Deadline</label>
            <button
              onClick={() => setShowCal(c => !c)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'transparent', border: 'none', borderBottom: `1.5px solid ${showCal ? '#5e4dbb' : '#E5E7EB'}`, padding: '8px 0', cursor: 'pointer', transition: 'border-color 200ms', textAlign: 'left' }}>
              <Icon name="calendar_today" size={14} color={deadline ? '#5e4dbb' : '#c9c4d5'} />
              <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: deadline ? '#1c1b22' : '#c9c4d5' }}>
                {deadline ? new Date(deadline + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'Pick a date…'}
              </span>
            </button>
            {showCal && (
              <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 500, animation: 'menuIn 200ms cubic-bezier(0.34,1.56,0.64,1) both', transformOrigin: 'top center' }}>
                <CalendarPicker value={deadline} onChange={d => { setDeadline(d); setShowCal(false); }} />
              </div>
            )}
          </div>

          {/* Priority */}
          <div>
            <label style={fieldLabel}>Priority</label>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              {PRIORITIES.map(p => (
                <button key={p} onClick={() => setPriority(priority === p ? '' : p)}
                  style={{ flex: 1, padding: '7px 0', borderRadius: 8, border: `1.5px solid ${priority === p ? PRIORITY_COLORS[p] : '#E5E7EB'}`, background: priority === p ? `${PRIORITY_COLORS[p]}15` : 'transparent', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: priority === p ? PRIORITY_COLORS[p] : '#787584', cursor: 'pointer', transition: 'all 150ms' }}>
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Tag */}
          <div>
            <label style={fieldLabel}>Tag</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              {TAGS.map(t => {
                const bc = BADGE_COLORS[t] || BADGE_COLORS.Default;
                const active = tag === t;
                return (
                  <button key={t} onClick={() => setTag(active ? '' : t)}
                    style={{ borderRadius: 9999, padding: '4px 12px', border: `1.5px solid ${active ? bc.color : '#E5E7EB'}`, background: active ? bc.bg : 'transparent', fontFamily: 'Inter, sans-serif', fontSize: 11, fontWeight: 600, color: active ? bc.color : '#787584', cursor: 'pointer', transition: 'all 150ms' }}>
                    {t}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '14px 24px 20px', borderTop: '1px solid #F5F3FF' }}>
          <button onClick={onClose} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: '1px solid #E5E7EB', borderRadius: 8, padding: '9px 20px', cursor: 'pointer', transition: 'all 180ms' }}
            onMouseEnter={e => e.currentTarget.style.background='#f7f2fc'}
            onMouseLeave={e => e.currentTarget.style.background='transparent'}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={!canSubmit} style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: canSubmit ? '#5e4dbb' : '#c9c4d5', border: 'none', borderRadius: 8, padding: '9px 20px', cursor: canSubmit ? 'pointer' : 'not-allowed', transition: 'all 180ms' }}
            onMouseEnter={e => { if (canSubmit) e.currentTarget.style.background='#5044aa'; }}
            onMouseLeave={e => { if (canSubmit) e.currentTarget.style.background='#5e4dbb'; }}>
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Task Item ──────────────────────────────────────────────────
function TaskItem({ task, onToggle, onDelete, onUpdate, onRowClick,
                    onDragStart, onDragEnd, onDragOver, onDrop,
                    isDragging, isDragOver }) {
  const [hovered, setHovered] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const [showEditModal, setShowEditModal] = React.useState(false);

  const { title, note, time, priority, badge, checked, deadline } = task;
  const badgeColors = badge ? (BADGE_COLORS[badge] || BADGE_COLORS.Default) : null;
  const priorityColor = PRIORITY_COLORS[priority] || '#787584';
  const showHandle = hovered || menuOpen;

  return (
    <>
      <div
        draggable={!!(onDragStart || onDragOver || onDrop || onDragEnd)}
        onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; onDragStart && onDragStart(task.id); }}
        onDragOver={e => { e.preventDefault(); onDragOver && onDragOver(task.id); }}
        onDrop={e => { e.preventDefault(); onDrop && onDrop(task.id); }}
        onDragEnd={() => onDragEnd && onDragEnd()}
        style={{
          ...taskStyles.row,
          ...(hovered && !isDragging ? taskStyles.rowHover : {}),
          opacity: isDragging ? 0.35 : 1,
          borderTop: isDragOver ? '2px solid #9d8dff' : '2px solid transparent',
          transition: 'background 200ms, opacity 150ms, border-color 120ms',
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}>

        {/* Checkbox */}
        <div style={{ ...taskStyles.checkbox, ...(checked ? taskStyles.checkboxChecked : {}) }}
          onClick={e => { e.stopPropagation(); onToggle && onToggle(task.id); }}>
          {checked && <CheckMark />}
        </div>

        {/* Content */}
        <div style={{ ...taskStyles.content, cursor: onRowClick ? 'pointer' : 'default' }}
          onClick={e => onRowClick && onRowClick(task, e)}>
          <div style={{ ...taskStyles.title, ...(checked ? taskStyles.titleDone : {}) }}>{title}</div>
          {note && <div style={taskStyles.note}>{note}</div>}
          {(time || deadline || priority || badge || task._listName) && (
            <div style={taskStyles.meta}>
              {task._listName && (
                <span style={{ ...taskStyles.badge, background: task._source === 'dash' ? '#F5F3FF' : '#eef0fb', color: task._source === 'dash' ? '#5e4dbb' : '#3d4a8f', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Icon name={task._source === 'dash' ? 'today' : 'format_list_bulleted'} size={10} color={task._source === 'dash' ? '#5e4dbb' : '#3d4a8f'} />
                  {task._listName}
                </span>
              )}
              {(time || deadline) && (
                <span style={taskStyles.time}>
                  <Icon name="calendar_today" size={12} color="#787584" />
                  {deadline || time}
                </span>
              )}
              {(time || deadline) && priority && <span style={{ color: '#c9c4d5', fontSize: 10 }}>·</span>}
              {priority && (
                <span style={{ ...taskStyles.time, color: priorityColor, fontWeight: 600 }}>
                  <Icon name="flag" size={12} color={priorityColor} />{priority}
                </span>
              )}
              {badgeColors && (
                <span style={{ ...taskStyles.badge, background: badgeColors.bg, color: badgeColors.color }}>{badge}</span>
              )}
            </div>
          )}
        </div>

        {/* Drag handle — left of ⋮, invisible until hover */}
        <div style={{
          width: 16, flexShrink: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center',
          opacity: showHandle ? 1 : 0,
          transition: 'opacity 150ms',
          cursor: 'grab'
        }}>
          <Icon name="drag_indicator" size={16} color="#c9c4d5" />
        </div>

        {/* More button + context menu */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            style={{ ...taskStyles.moreBtn, opacity: hovered || menuOpen ? 1 : 0, background: menuOpen ? '#f1ecf6' : 'transparent' }}
            onClick={e => { e.stopPropagation(); setMenuOpen(m => !m); }}>
            <Icon name="more_vert" size={18} color="#787584" />
          </button>
          {menuOpen && (
            <ContextMenu
              onEdit={() => { setMenuOpen(false); setShowEditModal(true); }}
              onDelete={() => { setMenuOpen(false); setShowDeleteConfirm(true); }}
              onClose={() => setMenuOpen(false)} />
          )}
        </div>
      </div>

      {showDeleteConfirm && (
        <DeleteConfirmModal task={task}
          onConfirm={() => { onDelete && onDelete(task.id); setShowDeleteConfirm(false); }}
          onCancel={() => setShowDeleteConfirm(false)} />
      )}
      {showEditModal && (
        <EditModal task={task}
          onSave={updates => { onUpdate && onUpdate(task.id, updates); setShowEditModal(false); }}
          onClose={() => setShowEditModal(false)} />
      )}
    </>
  );
}

// ─── Quick Add ──────────────────────────────────────────────────
// onAdd receives a task object: { title, note, deadline, priority, badge }
function QuickAdd({ placeholder = 'Add a new task for Today...', onAdd }) {
  const [val, setVal] = React.useState('');
  const [focused, setFocused] = React.useState(false);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [pencilHov, setPencilHov] = React.useState(false);

  const hasText = val.trim().length > 0;

  const submit = (data) => {
    const payload = {
      title: (data?.title ?? val).trim(),
      note: data?.note || undefined,
      deadline: data?.deadline || undefined,
      priority: data?.priority || undefined,
      badge: data?.badge || undefined,
    };
    if (!payload.title) return;
    onAdd && onAdd(payload);
    setVal('');
    setAdvancedOpen(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && hasText) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <>
      <div style={{ position: 'relative' }}>
        <div style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', width: 18, height: 18, borderRadius: 4, border: `1.5px solid ${focused ? '#5e4dbb' : '#c9c4d5'}`, transition: 'border-color 200ms', pointerEvents: 'none' }} />
        <input value={val} onChange={e => setVal(e.target.value)}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          style={{ width: '100%', background: '#fff', border: 'none', borderRadius: 10, padding: `13px ${hasText ? 86 : 48}px 13px 42px`, fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#484552', outline: focused ? '2px solid rgba(94,77,187,0.18)' : 'none', outlineOffset: -1, transition: 'outline 200ms, padding 180ms' }} />

        {/* Pencil → advanced edit, appears once user types */}
        {hasText && (
          <button
            onMouseDown={e => e.preventDefault()}
            onClick={() => setAdvancedOpen(true)}
            onMouseEnter={() => setPencilHov(true)}
            onMouseLeave={() => setPencilHov(false)}
            title="Add details"
            aria-label="Open advanced task editor"
            style={{ position: 'absolute', right: 46, top: '50%', transform: 'translateY(-50%)', width: 28, height: 28, borderRadius: 9999, background: pencilHov ? '#F5F3FF' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', cursor: 'pointer', transition: 'all 180ms', animation: 'qaPencilIn 200ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
            <Icon name="edit" size={15} color="#5e4dbb" />
          </button>
        )}
        <style>{`@keyframes qaPencilIn{from{opacity:0;transform:translateY(-50%) scale(.6)}to{opacity:1;transform:translateY(-50%) scale(1)}}`}</style>

        <button
          onMouseDown={e => e.preventDefault()}
          onClick={() => submit()}
          disabled={!hasText}
          title={hasText ? 'Add task' : ''}
          aria-label="Add task"
          style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', width: 28, height: 28, borderRadius: 9999, background: hasText ? '#5e4dbb' : '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', cursor: hasText ? 'pointer' : 'default', transition: 'all 200ms' }}>
          <Icon name="arrow_upward" size={16} color={hasText ? '#fff' : '#5e4dbb'} />
        </button>
      </div>

      {advancedOpen && (
        <EditModal
          mode="create"
          task={{ title: val }}
          onSave={data => submit(data)}
          onClose={() => setAdvancedOpen(false)} />
      )}
    </>
  );
}

Object.assign(window, { TaskItem, QuickAdd, EditModal });
