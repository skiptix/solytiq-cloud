import { useState } from 'react';

interface RingProgressProps {
  total: number;
  completed: number;
  color?: string;
}

export default function RingProgress({ total, completed, color = '#5e4dbb' }: RingProgressProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const pct = total === 0 ? 0 : completed / total;
  const R = 8;
  const CIRC = 2 * Math.PI * R;
  const offset = CIRC * (1 - pct);
  const done = total > 0 && completed === total;
  const ringColor = done ? '#10B981' : color;

  return (
    <div
      style={{ position: 'relative', width: 20, height: 20, flexShrink: 0, cursor: 'default' }}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <svg width="20" height="20" viewBox="0 0 20 20">
        <circle cx="10" cy="10" r={R} fill="none" stroke="#e8e4f0" strokeWidth="2.5" />
        <circle
          cx="10" cy="10" r={R}
          fill="none"
          stroke={ringColor}
          strokeWidth="2.5"
          strokeDasharray={CIRC}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transform: 'rotate(-90deg)', transformOrigin: 'center', transition: 'stroke-dashoffset 300ms ease' }}
        />
      </svg>
      {showTooltip && (
        <div style={{
          position: 'absolute',
          bottom: 'calc(100% + 4px)',
          left: '50%',
          transform: 'translateX(-50%)',
          background: '#1c1b22',
          color: '#fff',
          borderRadius: 5,
          padding: '3px 8px',
          fontFamily: 'Inter, sans-serif',
          fontSize: 11,
          fontWeight: 500,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          zIndex: 100,
        }}>
          {completed}/{total} done
        </div>
      )}
    </div>
  );
}
