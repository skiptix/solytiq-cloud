/**
 * A small two-segment progress donut: Completed vs Open.
 *
 * Colours are the app's status/brand tokens (Completed = success green, Open =
 * primary purple) — validated for CVD separation. Identity is never colour-alone:
 * a legend with counts is always rendered and the centre carries the headline
 * figure, satisfying the "visible labels" relief the palette check flags for the
 * green-on-surface contrast. A 2px surface gap separates the two arcs.
 */
import { useId } from 'react';

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)' }}>{title}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-labelledby={titleId} style={{ flexShrink: 0 }}>
          <title id={titleId}>{`${title}: ${completed} of ${total} completed (${pct}%)`}</title>
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
        </svg>

        {/* Legend + counts — identity is never colour-alone. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <LegendRow color={COMPLETED_COLOR} label="Completed" value={completed} />
          <LegendRow color={OPEN_COLOR} label="Open" value={open} />
          {subtitle && (
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', marginTop: 2 }}>{subtitle}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function LegendRow({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, background: color, flexShrink: 0 }} />
      <span style={{ fontFamily: 'var(--font-heading)', fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', lineHeight: 1 }}>{value}</span>
      <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </div>
  );
}
