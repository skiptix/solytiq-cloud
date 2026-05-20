import { useState } from 'react';
import Icon from './Icon';

interface CalendarPickerProps {
  value?: string;
  onChange: (date: string) => void;
  onClear?: () => void;
}

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function CalendarPicker({ value, onChange, onClear }: CalendarPickerProps) {
  const today = new Date(); today.setHours(0,0,0,0);
  const initDate = value ? new Date(value + 'T12:00:00') : today;
  const [view, setView] = useState({ year: initDate.getFullYear(), month: initDate.getMonth() });

  function prevMonth() {
    setView(v => v.month === 0 ? { year: v.year - 1, month: 11 } : { year: v.year, month: v.month - 1 });
  }
  function nextMonth() {
    setView(v => v.month === 11 ? { year: v.year + 1, month: 0 } : { year: v.year, month: v.month + 1 });
  }

  const firstDay = new Date(view.year, view.month, 1).getDay();
  const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
  const daysInPrev = new Date(view.year, view.month, 0).getDate();
  const cells: Array<{ date: Date; current: boolean }> = [];
  for (let i = firstDay - 1; i >= 0; i--) {
    cells.push({ date: new Date(view.year, view.month - 1, daysInPrev - i), current: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(view.year, view.month, d), current: true });
  }
  while (cells.length < 42) {
    cells.push({ date: new Date(view.year, view.month + 1, cells.length - daysInMonth - firstDay + 1), current: false });
  }

  return (
    <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.14)', padding: '14px 16px', width: 288 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <button onClick={prevMonth} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 4, borderRadius: 6 }}>
          <Icon name="chevron_left" size={18} color="#787584" />
        </button>
        <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#1c1b22' }}>
          {MONTHS[view.month]} {view.year}
        </span>
        <button onClick={nextMonth} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 4, borderRadius: 6 }}>
          <Icon name="chevron_right" size={18} color="#787584" />
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 6 }}>
        {DAYS.map(d => (
          <div key={d} style={{ textAlign: 'center', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10, fontWeight: 700, color: '#b0acbe', padding: '4px 0' }}>{d}</div>
        ))}
        {cells.map((cell, i) => {
          const iso = toIso(cell.date);
          const isToday = iso === toIso(today);
          const isSelected = iso === value;
          const isPast = cell.date < today;
          return (
            <button key={i} onClick={() => { if (cell.current) onChange(iso); }}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                height: 32, borderRadius: 8, border: isToday && !isSelected ? '1.5px solid #c8bfff' : 'none',
                background: isSelected ? '#5e4dbb' : isToday ? '#faf8ff' : 'transparent',
                fontFamily: 'Inter, sans-serif', fontSize: 12.5, fontWeight: isSelected || isToday ? 600 : 400,
                color: isSelected ? '#fff' : !cell.current ? '#d8d0eb' : isPast ? '#b0acbe' : '#1c1b22',
                cursor: cell.current ? 'pointer' : 'default',
                transition: 'all 120ms',
              }}>
              {cell.date.getDate()}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button onClick={() => onChange(toIso(today))}
          style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', border: 'none', borderRadius: 7, padding: '6px 0', cursor: 'pointer' }}>
          Today
        </button>
        {value && onClear && (
          <button onClick={onClear}
            style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#787584', background: '#f1ecf6', border: 'none', borderRadius: 7, padding: '6px 0', cursor: 'pointer' }}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
