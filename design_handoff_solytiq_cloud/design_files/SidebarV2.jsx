// Solytiq Cloud — Sidebar Component
// Export: window.Sidebar

const sidebarStyles = {
  aside: { width: 256, minWidth: 256, height: '100vh', background: '#f7f2fc', borderRight: '1px solid #E5E7EB', display: 'flex', flexDirection: 'column', padding: '16px 12px', gap: 4, position: 'fixed', left: 0, top: 0, zIndex: 40, overflowY: 'auto' },
  header: { padding: '12px 8px 20px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 },
  logo: { width: 44, height: 44, borderRadius: 11, objectFit: 'cover', marginBottom: 6, boxShadow: '0 1px 2px rgba(0,0,0,0.08)' },
  brandName: { fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 16, fontWeight: 500, color: '#5e4dbb', lineHeight: 1.2 },
  brandSub: { fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#b0acbe', textTransform: 'uppercase', letterSpacing: '0.03em' },
  navGroup: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 },
  navItem: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', transition: 'all 200ms ease-in-out', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 450, color: '#787584', border: 'none', background: 'transparent', width: '100%', textAlign: 'left' },
  divider: { height: 1, background: '#e8e4f0', margin: '6px 8px' },
  addBtn: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13.5, fontWeight: 500, color: '#5e4dbb', background: 'transparent', border: 'none', width: '100%', textAlign: 'left', transition: 'background 200ms ease-in-out' },
  footer: { marginTop: 'auto', borderTop: '1px solid #e8e4f0', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 2 },
};

function NavItem({ icon, label, active, onClick }) {
  const [hovered, setHovered] = React.useState(false);
  const bg = active ? '#F5F3FF' : hovered ? '#f1ecf6' : 'transparent';
  const color = active ? '#5e4dbb' : '#787584';
  return (
    <button
      style={{ ...sidebarStyles.navItem, background: bg, color, fontWeight: active ? 550 : 450 }}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}>
      <Icon name={icon} size={19} color={color} />
      <span>{label}</span>
    </button>
  );
}

function Sidebar({ active = 'dashboard', onNavigate, lists = [], onOpenModal }) {
  const nav = (item, opts) => () => onNavigate && onNavigate(item, opts);
  const [addHover, setAddHover] = React.useState(false);

  return (
    <aside style={sidebarStyles.aside}>
      <div style={sidebarStyles.header}>
        <img src="../../assets/solytiq-todo-logo.png" alt="Solytiq Cloud" style={sidebarStyles.logo} />
        <div style={sidebarStyles.brandName}>Solytiq Cloud</div>
        <div style={sidebarStyles.brandSub}>Local Storage Active</div>
      </div>

      <div style={sidebarStyles.navGroup}>
        <NavItem icon="today"          label="Dashboard" active={active==='today'}     onClick={nav('dashboard')} />
        <NavItem icon="calendar_month" label="Scheduled" active={active==='scheduled'} onClick={nav('dashboard')} />

        <div style={sidebarStyles.divider} />

        <button
          style={{ ...sidebarStyles.addBtn, background: addHover ? '#F5F3FF' : 'transparent' }}
          onMouseEnter={() => setAddHover(true)}
          onMouseLeave={() => setAddHover(false)}
          onClick={nav('dashboard')}>
          <Icon name="add" size={19} color="#5e4dbb" />
          <span>Add List</span>
        </button>

        {lists.map(list => (
          <NavItem key={list.id}
            icon="format_list_bulleted"
            label={`${list.emoji || ''} ${list.name}`}
            active={active === 'list'}
            onClick={nav('list', { listId: list.id })} />
        ))}
      </div>

      <div style={sidebarStyles.footer}>
        <NavItem icon="check_circle" label="Completed" active={false} onClick={() => onOpenModal && onOpenModal('completed')} />
        <NavItem icon="delete"       label="Trash"     active={false} onClick={() => onOpenModal && onOpenModal('trash')} />
      </div>
    </aside>
  );
}

Object.assign(window, { Sidebar });
