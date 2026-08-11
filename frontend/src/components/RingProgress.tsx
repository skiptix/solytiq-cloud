import { useState, useRef } from 'react';
import { motion } from '@/components/animate-ui/motion';

// CSS `ease` keyword as an explicit cubic-bezier, so the Motion-driven
// animation below is timing-identical to the `transition: 'stroke-dashoffset
// 300ms ease'` it replaces — no unmeasured change to duration/easing.
const CSS_EASE: [number, number, number, number] = [0.25, 0.1, 0.25, 1];

interface RingProgressProps {
  total: number;
  completed: number;
  color?: string;
}

export default function RingProgress({ total, completed, color = 'var(--color-primary)' }: RingProgressProps) {
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pct = total === 0 ? 0 : completed / total;
  const R = 8;
  const CIRC = 2 * Math.PI * R;
  const offset = CIRC * (1 - pct);
  const done = total > 0 && completed === total;
  const ringColor = done ? 'var(--color-success)' : color;

  return (
    <div
      ref={containerRef}
      style={{ width: 20, height: 20, flexShrink: 0, cursor: 'default' }}
      onMouseEnter={() => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) setTooltipPos({ top: rect.top - 28, left: rect.left + rect.width / 2 });
      }}
      onMouseLeave={() => setTooltipPos(null)}
    >
      <svg width="20" height="20" viewBox="0 0 20 20">
        <circle cx="10" cy="10" r={R} fill="none" stroke="var(--color-border)" strokeWidth="2.5" />
        <motion.circle
          cx="10" cy="10" r={R}
          fill="none"
          stroke={ringColor}
          strokeWidth="2.5"
          strokeDasharray={CIRC}
          strokeLinecap="round"
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 0.3, ease: CSS_EASE }}
          style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }}
        />
      </svg>
      {tooltipPos && (
        <div style={{
          position: 'fixed',
          top: tooltipPos.top,
          left: tooltipPos.left,
          transform: 'translateX(-50%)',
          background: 'var(--color-text-primary)',
          color: 'var(--color-white)',
          borderRadius: 5,
          padding: '3px 8px',
          fontFamily: 'var(--font-body)',
          fontSize: 11,
          fontWeight: 500,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          zIndex: 1000,
        }}>
          {completed}/{total} done
        </div>
      )}
    </div>
  );
}
