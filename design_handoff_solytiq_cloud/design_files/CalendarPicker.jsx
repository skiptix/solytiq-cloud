// Solytiq Cloud — Calendar Date Picker
// Export: window.CalendarPicker

function CalendarPicker({ value, onChange, onClose }) {
  const today = new Date();
  const selected = value ? new Date(value + 'T12:00:00') : null;
  const [view, setView] = React.useState(() => selected ? new Date(selected.getFullYear(), selected.getMonth(), 1) : new Date(today.getFullYear(), today.getMonth(), 1));

  const year  = view.getFullYear();
  const month = view.getMonth();

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const DAYS   = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  const firstWeekday  = new Date(year, month, 1).getDay();
  const daysInMonth   = new Date(year, month + 1, 0).getDate();
  const daysInPrev    = new Date(year, month, 0).getDate();

  // Build 6×7 grid: leading overflow from prev month, current, trailing from next
  const cells = [];
  for (let i = firstWeekday - 1; i >= 0; i--) cells.push({ d: daysInPrev - i, overflow: 'prev' });
  for (let d = 1; d <= daysInMonth; d++)         cells.push({ d, overflow: null });
  while (cells.length % 7 !== 0)                 cells.push({ d: cells.length - daysInMonth - firstWeekday + 1, overflow: 'next' });

  const isSelected = (d, ov) => !ov && selected && selected.getFullYear() === year && selected.getMonth() === month && selected.getDate() === d;
  const isToday    = (d, ov) => !ov && today.getFullYear() === year && today.getMonth() === month && today.getDate() === d;

  const select = (d, ov) => {
    if (ov) return;
    const iso = `${year}-${String(month + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    onChange(iso);
  };

  const nav = (delta) => setView(new Date(year, month + delta, 1));

  const navBtn = { background: 'none', border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#787584', transition: 'background 150ms' };

  return (
    <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: '14px 16px', boxShadow: '0 4px 20px rgba(0,0,0,0.10)', width: '100%', userSelect: 'none' }}>

      {/* Month nav */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <button style={navBtn}
          onMouseEnter={e => e.currentTarget.style.background='#f1ecf6'}
          onMouseLeave={e => e.currentTarget.style.background='none'}
          onClick={() => nav(-1)}>
          <Icon name="chevron_right" size={16} color="#787584" style={{ transform: 'rotate(180deg)' }} />
        </button>

        <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22' }}>
          {MONTHS[month]} {year}
        </span>

        <button style={navBtn}
          onMouseEnter={e => e.currentTarget.style.background='#f1ecf6'}
          onMouseLeave={e => e.currentTarget.style.background='none'}
          onClick={() => nav(1)}>
          <Icon name="chevron_right" size={16} color="#787584" />
        </button>
      </div>

      {/* Day-of-week headers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', marginBottom: 6 }}>
        {DAYS.map(d => (
          <div key={d} style={{ textAlign: 'center', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10, fontWeight: 700, color: '#b0acbe', letterSpacing: '0.04em', paddingBottom: 4 }}>
            {d}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {cells.map((cell, i) => {
          const sel = isSelected(cell.d, cell.overflow);
          const tod = isToday(cell.d, cell.overflow);
          const over = !!cell.overflow;
          return (
            <button key={i} onClick={() => select(cell.d, cell.overflow)}
              style={{
                height: 32, width: '100%', border: 'none',
                borderRadius: 8,
                background: sel ? '#5e4dbb' : 'transparent',
                color: over ? '#d0cce0' : sel ? '#fff' : tod ? '#5e4dbb' : '#1c1b22',
                fontFamily: 'Inter, sans-serif',
                fontSize: 12,
                fontWeight: sel ? 600 : tod ? 600 : 400,
                cursor: over ? 'default' : 'pointer',
                outline: tod && !sel ? '1.5px solid #c8bfff' : 'none',
                outlineOffset: -1,
                transition: 'background 120ms, color 120ms',
                boxSizing: 'border-box',
              }}
              onMouseEnter={e => { if (!sel && !over) e.currentTarget.style.background='#F5F3FF'; }}
              onMouseLeave={e => { if (!sel && !over) e.currentTarget.style.background='transparent'; }}>
              {cell.d}
            </button>
          );
        })}
      </div>

      {/* Footer actions */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, paddingTop: 10, borderTop: '1px solid #f1ecf6' }}>
        <button onClick={() => onChange('')}
          style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0' }}>
          Clear
        </button>
        <button onClick={() => { select(today.getDate(), null); }}
          style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 600, color: '#5e4dbb', background: 'none', border: 'none', cursor: 'pointer' }}>
          Today
        </button>
      </div>
    </div>
  );
}

Object.assign(window, { CalendarPicker });
