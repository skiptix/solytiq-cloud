import { useEffect, useRef } from 'react';
import Icon from './Icon';

interface TimePickerProps {
  /** "HH:MM" (24-hour), or undefined when unset. */
  value?: string;
  onChange: (time: string) => void;
  onClear?: () => void;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Parse "HH:MM" → { hour, minute }, or nulls when unset/invalid. */
function parse(value?: string): { hour: number | null; minute: number | null } {
  if (!value) return { hour: null, minute: null };
  const m = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!m) return { hour: null, minute: null };
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return {
    hour: hour >= 0 && hour <= 23 ? hour : null,
    minute: minute >= 0 && minute <= 59 ? minute : null,
  };
}

// Matches CalendarPicker: same card chrome, two scrollable wheels for hour/minute.
export default function TimePicker({ value, onChange, onClear }: TimePickerProps) {
  const { hour, minute } = parse(value);
  const hourRef = useRef<HTMLButtonElement>(null);
  const minuteRef = useRef<HTMLButtonElement>(null);

  // Center the selected hour/minute when the picker opens.
  useEffect(() => {
    hourRef.current?.scrollIntoView({ block: 'center' });
    minuteRef.current?.scrollIntoView({ block: 'center' });
  }, []);

  const emit = (h: number | null, mi: number | null) => {
    onChange(`${pad(h ?? 0)}:${pad(mi ?? 0)}`);
  };

  const label = hour != null || minute != null ? `${pad(hour ?? 0)}:${pad(minute ?? 0)}` : '--:--';

  const renderColumn = (
    items: number[],
    selected: number | null,
    kind: 'hour' | 'minute',
    btnRef: React.RefObject<HTMLButtonElement | null>,
  ) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ textAlign: 'center', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 10, fontWeight: 700, color: '#b0acbe', padding: '0 0 6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {kind === 'hour' ? 'Hour' : 'Min'}
      </div>
      <div style={{ height: 196, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, padding: '0 4px', scrollbarWidth: 'thin' }}>
        {items.map(n => {
          const isSelected = selected === n;
          return (
            <button
              key={n}
              ref={isSelected ? btnRef : undefined}
              onClick={() => (kind === 'hour' ? emit(n, minute) : emit(hour, n))}
              style={{
                flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                height: 32, borderRadius: 8, border: 'none',
                background: isSelected ? '#5e4dbb' : 'transparent',
                fontFamily: 'Inter, sans-serif', fontSize: 13, fontWeight: isSelected ? 600 : 400,
                color: isSelected ? '#fff' : '#1c1b22',
                cursor: 'pointer', transition: 'background 120ms',
              }}
              onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = '#faf8ff'; }}
              onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}>
              {pad(n)}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.14)', padding: '14px 16px', width: 220, transformOrigin: 'top center', animation: 'menuIn 180ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 12 }}>
        <Icon name="schedule" size={16} color="#5e4dbb" />
        <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 700, color: '#1c1b22', letterSpacing: '0.02em', fontVariantNumeric: 'tabular-nums' }}>
          {label}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'stretch', gap: 4 }}>
        {renderColumn(HOURS, hour, 'hour', hourRef)}
        <div style={{ width: 1, background: '#f0ecf8', alignSelf: 'stretch', marginTop: 20 }} />
        {renderColumn(MINUTES, minute, 'minute', minuteRef)}
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <button
          onClick={() => { const d = new Date(); emit(d.getHours(), d.getMinutes()); }}
          style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', border: 'none', borderRadius: 7, padding: '6px 0', cursor: 'pointer' }}>
          Now
        </button>
        {value && onClear && (
          <button
            onClick={onClear}
            style={{ flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#787584', background: '#f1ecf6', border: 'none', borderRadius: 7, padding: '6px 0', cursor: 'pointer' }}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
