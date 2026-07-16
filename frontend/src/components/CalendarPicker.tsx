import { useState } from 'react';
import Icon from './Icon';

interface CalendarPickerProps {
  value?: string;
  onChange: (date: string) => void;
  onClear?: () => void;
}

// Monday-first (weeks start on Monday across the app).
const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  if (isNaN(y) || isNaN(d.getMonth()) || isNaN(d.getDate())) return '';
  return `${y}-${m}-${day}`;
}

export default function CalendarPicker({ value, onChange, onClear }: CalendarPickerProps) {
  const today = new Date(); today.setHours(0,0,0,0);
  const parsedValue = value ? new Date(value.slice(0, 10) + 'T12:00:00') : null;
  const initDate = (parsedValue && !isNaN(parsedValue.getTime())) ? parsedValue : today;
  const [view, setView] = useState({ year: initDate.getFullYear(), month: initDate.getMonth() });

  function prevMonth() {
    setView(v => v.month === 0 ? { year: v.year - 1, month: 11 } : { year: v.year, month: v.month - 1 });
  }
  function nextMonth() {
    setView(v => v.month === 11 ? { year: v.year + 1, month: 0 } : { year: v.year, month: v.month + 1 });
  }

  // Monday-first: 0 = Mon … 6 = Sun, so the leading blanks land correctly.
  const firstDay = (new Date(view.year, view.month, 1).getDay() + 6) % 7;
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
    <div style={{ background: 'var(--color-white)', border: '1px solid var(--color-border-alt)', borderRadius: 12, boxShadow: '0 8px 32px rgba(var(--color-black-rgb), 0.14)', padding: '14px 16px', width: Math.min(288, window.innerWidth - 32), transformOrigin: 'top center', animation: 'menuIn 180ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <button onClick={prevMonth} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 4, borderRadius: 6 }}>
          <Icon name="chevron_left" size={18} color="var(--color-text-tertiary)" />
        </button>
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>
          {MONTHS[view.month]} {view.year}
        </span>
        <button onClick={nextMonth} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 4, borderRadius: 6 }}>
          <Icon name="chevron_right" size={18} color="var(--color-text-tertiary)" />
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 6 }}>
        {DAYS.map(d => (
          <div key={d} style={{ textAlign: 'center', fontFamily: 'var(--font-heading)', fontSize: 10, fontWeight: 700, color: 'var(--color-text-quaternary)', padding: '4px 0' }}>{d}</div>
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
                height: 32, borderRadius: 8, border: isToday && !isSelected ? '1.5px solid var(--color-purple-tint-1)' : 'none',
                background: isSelected ? 'var(--color-primary)' : isToday ? 'var(--color-purple-pale-5)' : 'transparent',
                fontFamily: 'var(--font-body)', fontSize: 12.5, fontWeight: isSelected || isToday ? 600 : 400,
                color: isSelected ? 'var(--color-white)' : !cell.current ? 'var(--color-purple-tint-2)' : isPast ? 'var(--color-text-quaternary)' : 'var(--color-text-primary)',
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
          style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 600, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', border: 'none', borderRadius: 7, padding: '6px 0', cursor: 'pointer' }}>
          Today
        </button>
        {value && onClear && (
          <button onClick={onClear}
            style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 600, color: 'var(--color-text-tertiary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 7, padding: '6px 0', cursor: 'pointer' }}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
