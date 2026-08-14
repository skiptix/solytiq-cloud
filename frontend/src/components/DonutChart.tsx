/**
 * A small two-segment progress donut: Completed vs Open.
 *
 * Colours are the app's status/brand tokens (Completed = success green, Open =
 * primary purple) — validated for CVD separation. A 2px surface gap separates
 * the two arcs. There is no persistent legend; identity is carried by the SVG
 * `<title>` (screen readers), the always-visible centre percentage, and a hover
 * tooltip that breaks the ring down into its Completed / Open counts.
 */
import { useId, useState } from 'react';
import MotionIn from './animate-ui/MotionIn';
import { motion } from './animate-ui/motion';

interface DonutChartProps {
  title: string;
  subtitle?: string;
  completed: number;
  open: number;
  /** Outer diameter in px. */
  size?: number;
}

const COMPLETED_COLOR = 'var(--color-success)';
const OPEN_COLOR = 'var(--color-primary)';
const TRACK_COLOR = 'var(--color-purple-pale-39)';

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

/** SVG arc path between two angles (degrees, clockwise from 12 o'clock). */
function arcPath(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const start = polar(cx, cy, r, endAngle);
  const end = polar(cx, cy, r, startAngle);
  const large = endAngle - startAngle <= 180 ? 0 : 1;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 0 ${end.x} ${end.y}`;
}

export default function DonutChart({ title, subtitle, completed, open, size = 128 }: DonutChartProps) {
  const [hov, setHov] = useState(false);
  const total = completed + open;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  const stroke = 13;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const titleId = useId();

  // Angular gap (≈2px of arc) rendered on each side of a segment boundary, only
  // when both segments actually exist.
  const gapDeg = total > 0 && completed > 0 && open > 0 ? (2 / (2 * Math.PI * r)) * 360 : 0;
  const completedEnd = total > 0 ? (completed / total) * 360 : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', minWidth: 0 }}>
      <div style={{ alignSelf: 'stretch', display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)' }}>{title}</span>
        <div style={{ flex: 1 }} />
        {subtitle && <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', whiteSpace: 'nowrap' }}>{subtitle}</span>}
      </div>

      <div
        onMouseEnter={() => setHov(true)}
        onMouseLeave={() => setHov(false)}
        style={{ position: 'relative', width: size, height: size, cursor: 'default' }}
      >
        <motion.svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-labelledby={titleId}
          transition={{ duration: 0.26 }} style={{ display: 'block', transformOrigin: 'center', transform: hov ? 'scale(1.05)' : 'scale(1)', filter: hov ? 'drop-shadow(0 8px 18px rgba(var(--color-primary-rgb), 0.20))' : 'none' }}>
          <title id={titleId}>{`${title}: ${completed} of ${total} completed (${pct}%), ${open} open`}</title>
          {/* Track */}
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={TRACK_COLOR} strokeWidth={stroke} />
          {total === 0 ? null : completed === total ? (
            <circle cx={cx} cy={cy} r={r} fill="none" stroke={COMPLETED_COLOR} strokeWidth={stroke} />
          ) : completed === 0 ? (
            <circle cx={cx} cy={cy} r={r} fill="none" stroke={OPEN_COLOR} strokeWidth={stroke} />
          ) : (
            <>
              <path d={arcPath(cx, cy, r, gapDeg / 2, completedEnd - gapDeg / 2)} fill="none" stroke={COMPLETED_COLOR} strokeWidth={stroke} strokeLinecap="butt" />
              <path d={arcPath(cx, cy, r, completedEnd + gapDeg / 2, 360 - gapDeg / 2)} fill="none" stroke={OPEN_COLOR} strokeWidth={stroke} strokeLinecap="butt" />
            </>
          )}
          {/* Centre figure */}
          <text x={cx} y={cy - 2} textAnchor="middle" dominantBaseline="middle"
            style={{ fontFamily: 'var(--font-heading)', fontSize: 26, fontWeight: 700, fill: 'var(--color-text-primary)', letterSpacing: '-0.02em' }}>
            {total > 0 ? `${pct}%` : '—'}
          </text>
          <text x={cx} y={cy + 18} textAnchor="middle" dominantBaseline="middle"
            style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, fontWeight: 600, fill: 'var(--color-text-quaternary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {total > 0 ? 'done' : 'no tasks'}
          </text>
        </motion.svg>

        {/* Hover tooltip — the breakdown, so counts + identity are one interaction away. */}
        {total > 0 && (
          <MotionIn transition={{ duration: 0.16 }} style={{ position: 'absolute', left: '50%', top: -10, transform: 'translate(-50%, -100%)', opacity: hov ? 1 : 0, pointerEvents: 'none', background: 'var(--color-text-primary)', borderRadius: 9, padding: '8px 11px', boxShadow: '0 6px 22px rgba(var(--color-black-rgb), 0.24)', display: 'flex', flexDirection: 'column', gap: 5, whiteSpace: 'nowrap', zIndex: 5 }}>
            <TooltipRow color={COMPLETED_COLOR} value={completed} label="Completed" />
            <TooltipRow color={OPEN_COLOR} value={open} label="Open" />
          </MotionIn>
        )}
      </div>
    </div>
  );
}

function TooltipRow({ color, value, label }: { color: string; value: number; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
      <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 700, color: 'var(--color-white)', lineHeight: 1 }}>{value}</span>
      <span style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'rgba(var(--color-white-rgb), 0.75)' }}>{label}</span>
    </div>
  );
}
