import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import { markdownToPlainText } from '../utils/markdownRender';
import MotionIn from './animate-ui/MotionIn';
import MotionButton from './animate-ui/MotionButton';
import { fmtDate } from '../utils/shareFormat';

// Shapes returned by GET /api/share/list/:token(/content) — read-only, public.
export interface SharedTask {
  id: string;
  title: string;
  checked: boolean;
  note: string | null;
  noteMarkdown?: boolean;
  deadline: string | null;
  time: string | null;
  priority: string | null;
  badge: string | null;
  linkedListType: 'sublist' | 'link' | null;
  linkedShareToken: string | null;
  linkedProgress: { total: number; completed: number } | null;
  createdAt: string;
  completedAt: string | null;
}

export interface SharedSection {
  id: string;
  label: string;
  emoji: string | null;
  tasks: SharedTask[];
}


// ── Shared task row — used by both the List and Kanban read-only views ─────────
export function SharedTaskRow({ task, accent, onClick }: { task: SharedTask; accent: string; onClick: (task: SharedTask) => void }) {
  const isLinked = !!task.linkedListType;
  const lp = task.linkedProgress;
  const linkedComplete = !!(lp && lp.total > 0 && lp.completed === lp.total);
  const navigable = !!task.linkedShareToken;
  const done = task.checked || linkedComplete;
  return (
    <MotionIn
      onClick={() => onClick(task)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, cursor: 'pointer' }}
      whileHover={{ background: 'var(--color-surface-tint)' }}
      transition={{ duration: 0.15 }}
    >
      {isLinked ? (
        <div style={{ width: 20, height: 20, minWidth: 20, borderRadius: '50%', border: `2px solid ${accent}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, position: 'relative' }}>
          {linkedComplete
            ? <Icon name="check" size={12} color={accent} />
            : <span style={{ fontFamily: 'var(--font-heading)', fontSize: 8, fontWeight: 700, color: accent }}>{lp ? `${lp.completed}/${lp.total}` : ''}</span>}
        </div>
      ) : (
        <div style={{ width: 20, height: 20, minWidth: 20, borderRadius: 5, border: '1.5px solid', borderColor: task.checked ? accent : 'var(--color-border-strong)', background: task.checked ? accent : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {task.checked && <Icon name="check" size={13} color="var(--color-white)" />}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: isLinked ? accent : 'var(--color-text-primary)', lineHeight: 1.4, opacity: done ? 0.45 : 1, textDecoration: done ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
          {task.badge && <span style={{ fontFamily: 'var(--font-heading)', fontSize: 10, fontWeight: 700, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', padding: '2px 7px', borderRadius: 9999, flexShrink: 0 }}>{task.badge}</span>}
        </div>
        {task.note && (() => {
          const plain = markdownToPlainText(task.note);
          return (
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {plain.length > 40 ? `${plain.slice(0, 40).trimEnd()}…` : plain}
            </div>
          );
        })()}
      </div>
      {task.deadline && <span style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-quaternary)', flexShrink: 0 }}>{fmtDate(task.deadline)}</span>}
      {navigable && <Icon name="chevron_right" size={18} color="var(--color-text-quaternary)" />}
      {isLinked && !navigable && <Icon name="lock" size={14} color="var(--color-blue-tint-3)" />}
    </MotionIn>
  );
}

// ── Kanban — sections as read-only columns ──────────────────────────────────────
export function SharedKanbanView({ sections, accent, onTaskClick }: {
  sections: SharedSection[];
  accent: string;
  onTaskClick: (task: SharedTask) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 14, overflowX: 'auto', paddingBottom: 4 }}>
      {sections.map(section => (
        <div key={section.id} style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 260, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 4px' }}>
            {section.emoji && <span style={{ fontSize: 13 }}>{section.emoji}</span>}
            <span style={{ fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--color-gray-deep-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{section.label}</span>
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', flexShrink: 0 }}>{section.tasks.length}</span>
          </div>
          <div style={{ background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 12, padding: 4, minHeight: 60 }}>
            {section.tasks.length === 0 ? (
              <div style={{ padding: '16px', fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-quaternary)', textAlign: 'center' }}>No items.</div>
            ) : (
              section.tasks.map(task => <SharedTaskRow key={task.id} task={task} accent={accent} onClick={onTaskClick} />)
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Timeline — read-only Gantt-style layout, adapted from TaskTimelineView ─────
type Zoom = 'day' | 'week' | 'month';
type TimelineRow =
  | { kind: 'section'; id: string; label: string; emoji: string | null }
  | { kind: 'task'; id: string; task: SharedTask };

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function daysBetween(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS);
}
function dayFromTimestamp(iso: string): Date {
  return startOfDay(new Date(iso));
}
function dayFromDateOnly(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}
function formatDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  return `${hh}:${mi} - ${dd}.${mo}.${d.getFullYear()}`;
}

const ZOOM_PX_PER_DAY: Record<Zoom, { desktop: number; mobile: number }> = {
  day:   { desktop: 40, mobile: 30 },
  week:  { desktop: 14, mobile: 10 },
  month: { desktop: 5,  mobile: 3.5 },
};

interface Tick { date: Date; days: number; label: string; isToday: boolean; isWeekend?: boolean }

function buildMonthChunks(start: Date, totalDays: number): { date: Date; days: number }[] {
  const chunks: { date: Date; days: number }[] = [];
  let cursor = start;
  let remaining = totalDays;
  while (remaining > 0) {
    const nextMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    const days = Math.min(remaining, daysBetween(cursor, nextMonth));
    chunks.push({ date: cursor, days });
    cursor = addDays(cursor, days);
    remaining -= days;
  }
  return chunks;
}

function buildMajorTicks(start: Date, totalDays: number, zoom: Zoom): Tick[] {
  if (zoom === 'month') {
    const ticks: Tick[] = [];
    let cursor = start;
    let remaining = totalDays;
    while (remaining > 0) {
      const nextYear = new Date(cursor.getFullYear() + 1, 0, 1);
      const days = Math.min(remaining, daysBetween(cursor, nextYear));
      ticks.push({ date: cursor, days, label: String(cursor.getFullYear()), isToday: false });
      cursor = addDays(cursor, days);
      remaining -= days;
    }
    return ticks;
  }
  return buildMonthChunks(start, totalDays).map(({ date, days }) => ({
    date, days, isToday: false,
    label: date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
  }));
}

function buildMinorTicks(start: Date, totalDays: number, zoom: Zoom, today: Date): Tick[] {
  if (zoom === 'day') {
    const ticks: Tick[] = [];
    for (let i = 0; i < totalDays; i++) {
      const date = addDays(start, i);
      const day = date.getDay();
      ticks.push({
        date, days: 1, isToday: daysBetween(today, date) === 0,
        isWeekend: day === 0 || day === 6,
        label: String(date.getDate()),
      });
    }
    return ticks;
  }
  if (zoom === 'week') {
    const ticks: Tick[] = [];
    for (let i = 0; i < totalDays; i += 7) {
      const date = addDays(start, i);
      const days = Math.min(7, totalDays - i);
      const offset = daysBetween(date, today);
      ticks.push({
        date, days, isToday: offset >= 0 && offset < days,
        label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      });
    }
    return ticks;
  }
  return buildMonthChunks(start, totalDays).map(({ date, days }) => {
    const offset = daysBetween(date, today);
    return { date, days, isToday: offset >= 0 && offset < days, label: date.toLocaleDateString('en-US', { month: 'short' }) };
  });
}

export function SharedTaskTimelineView({ sections, accent, isMobile, onTaskClick }: {
  sections: SharedSection[];
  accent: string;
  isMobile: boolean;
  onTaskClick: (task: SharedTask) => void;
}) {
  const [zoom, setZoom] = useState<Zoom>('day');
  const [containerWidth, setContainerWidth] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const barColor = accent;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width;
      if (w) setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows: TimelineRow[] = useMemo(() => sections.flatMap(s => [
    { kind: 'section', id: s.id, label: s.label, emoji: s.emoji } as const,
    ...s.tasks.map(t => ({ kind: 'task', id: `t_${t.id}`, task: t } as const)),
  ]), [sections]);

  const allTasks = useMemo(() => sections.flatMap(s => s.tasks), [sections]);

  const today = startOfDay(new Date());

  const range = useMemo(() => {
    if (allTasks.length === 0) return null;
    let min = today;
    let max = today;
    for (const t of allTasks) {
      const created = t.createdAt ? dayFromTimestamp(t.createdAt) : today;
      if (created < min) min = created;
      const end = t.checked ? dayFromTimestamp(t.completedAt ?? t.createdAt ?? new Date().toISOString()) : today;
      if (end > max) max = end;
      if (t.deadline) {
        const dl = dayFromDateOnly(t.deadline);
        if (dl < min) min = dl;
        if (dl > max) max = dl;
      }
    }
    const start = addDays(min, -2);
    const end = addDays(max, 6);
    return { start, totalDays: Math.max(1, daysBetween(start, end)) };
  }, [allTasks, today]);

  const basePxPerDay = ZOOM_PX_PER_DAY[zoom][isMobile ? 'mobile' : 'desktop'];
  const pxPerDay = range && containerWidth > 0
    ? Math.max(basePxPerDay, containerWidth / range.totalDays)
    : basePxPerDay;
  const totalWidth = range ? range.totalDays * pxPerDay : 0;
  const todayOffsetPx = range ? daysBetween(range.start, today) * pxPerDay : 0;

  const majorTicks = useMemo(() => range ? buildMajorTicks(range.start, range.totalDays, zoom) : [], [range, zoom]);
  const minorTicks = useMemo(() => range ? buildMinorTicks(range.start, range.totalDays, zoom, today) : [], [range, zoom, today]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !range) return;
    el.scrollLeft = Math.max(0, todayOffsetPx - el.clientWidth * 0.3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, range?.totalDays]);

  const jumpToToday = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ left: Math.max(0, todayOffsetPx - el.clientWidth * 0.3), behavior: 'smooth' });
  };

  const LEFT_COL_WIDTH = isMobile ? 130 : 220;
  const ROW_HEIGHT = isMobile ? 34 : 38;
  const SECTION_HEADER_HEIGHT = 30;
  const MAJOR_H = 22;
  const MINOR_H = 26;
  const RULER_H = MAJOR_H + MINOR_H;
  const BAR_HEIGHT = isMobile ? 12 : 15;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={jumpToToday}
          style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', background: 'var(--color-surface-tint)', border: 'none', borderRadius: 8, padding: '7px 12px', cursor: 'pointer' }}>
          <Icon name="today" size={14} color="var(--color-primary)" />
          Today
        </button>
        <div style={{ display: 'inline-flex', background: 'var(--color-surface-tint)', borderRadius: 10, padding: 3, gap: 2 }}>
          {(['day', 'week', 'month'] as const).map(z => (
            <MotionButton key={z} onClick={() => setZoom(z)}
              style={{
                fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, textTransform: 'capitalize',
                border: 'none', borderRadius: 8, padding: '7px 13px', cursor: 'pointer',
              }}
              animate={{
                color: zoom === z ? 'var(--color-primary)' : 'var(--color-text-tertiary)',
                background: zoom === z ? 'var(--color-white)' : 'rgba(0,0,0,0)',
                boxShadow: zoom === z ? '0 1px 4px rgba(var(--color-primary-rgb), 0.18)' : '0 1px 4px rgba(var(--color-primary-rgb), 0)',
              }}
              transition={{ duration: 0.15 }}>
              {z}
            </MotionButton>
          ))}
        </div>
      </div>

      {!range ? (
        <div style={{ textAlign: 'center', padding: '48px 16px', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)', background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 12 }}>
          No tasks yet.
        </div>
      ) : (
        <div style={{ display: 'flex', border: '1px solid var(--color-border-alt)', borderRadius: 12, background: 'var(--color-surface-gray)', overflow: 'hidden' }}>
          <div style={{ width: LEFT_COL_WIDTH, flexShrink: 0, borderRight: '1px solid var(--color-border-alt)', background: 'var(--color-white)' }}>
            <div style={{ height: RULER_H, borderBottom: '1px solid var(--color-border-alt)' }} />
            {rows.map(row => row.kind === 'section' ? (
              <div key={row.id} style={{
                height: SECTION_HEADER_HEIGHT, display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px',
                background: 'var(--color-purple-pale-3)', borderBottom: '1px solid var(--color-surface-tint-2)',
              }}>
                {row.emoji && <span style={{ fontSize: 12 }}>{row.emoji}</span>}
                <span style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-gray-deep-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {row.label}
                </span>
              </div>
            ) : (
              <div key={row.id} onClick={() => onTaskClick(row.task)} style={{
                height: ROW_HEIGHT, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', cursor: 'pointer',
                borderBottom: '1px solid var(--color-surface-tint-2)',
              }}>
                <div style={{
                  width: 16, height: 16, minWidth: 16, borderRadius: 4, border: '1.5px solid',
                  borderColor: row.task.checked ? barColor : 'var(--color-border-strong)', background: row.task.checked ? barColor : 'transparent',
                  flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {row.task.checked && <Icon name="check" size={11} color="var(--color-white)" />}
                </div>
                <span style={{
                  fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-primary)',
                  opacity: row.task.checked ? 0.45 : 1, textDecoration: row.task.checked ? 'line-through' : 'none',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {row.task.title}
                </span>
              </div>
            ))}
          </div>

          <div ref={scrollRef} style={{ flex: 1, overflowX: 'auto', overflowY: 'hidden' }}>
            <div style={{ width: totalWidth, minWidth: '100%', position: 'relative' }}>
              <div style={{ borderBottom: '1px solid var(--color-border-alt)', background: 'var(--color-white)' }}>
                <div style={{ display: 'flex', height: MAJOR_H, borderBottom: '1px solid var(--color-surface-tint-2)' }}>
                  {majorTicks.map((t, i) => (
                    <div key={i} style={{
                      width: t.days * pxPerDay, flexShrink: 0, display: 'flex', alignItems: 'center', paddingLeft: 8,
                      fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 700, color: 'var(--color-text-tertiary)',
                      borderRight: '1px solid var(--color-surface-tint-2)', overflow: 'hidden', whiteSpace: 'nowrap',
                    }}>
                      {t.label}
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', height: MINOR_H }}>
                  {minorTicks.map((t, i) => (
                    <div key={i} style={{
                      width: t.days * pxPerDay, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: t.isToday ? 700 : 500,
                      color: t.isToday ? 'var(--color-primary)' : (t.isWeekend ? 'var(--color-text-quaternary)' : 'var(--color-text-tertiary)'),
                      background: t.isToday ? 'var(--color-surface-tint)' : (t.isWeekend ? 'var(--color-purple-pale-16)' : 'transparent'),
                      borderRight: '1px solid var(--color-surface-tint-2)',
                    }}>
                      {t.label}
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ position: 'absolute', left: todayOffsetPx, top: 0, bottom: 0, borderLeft: '2px dashed var(--color-accent-purple-light)', zIndex: 2, pointerEvents: 'none' }} />

              {rows.map(row => row.kind === 'section' ? (
                <div key={row.id} style={{ height: SECTION_HEADER_HEIGHT, borderBottom: '1px solid var(--color-surface-tint-2)', background: 'var(--color-purple-pale-3)' }} />
              ) : (
                (() => {
                  const t = row.task;
                  const createdDay = t.createdAt ? dayFromTimestamp(t.createdAt) : today;
                  const endDay = t.checked ? dayFromTimestamp(t.completedAt ?? t.createdAt ?? new Date().toISOString()) : today;
                  const startOffset = Math.max(0, daysBetween(range.start, createdDay));
                  const endOffset = Math.max(startOffset, daysBetween(range.start, endDay)) + 1;
                  const barLeft = startOffset * pxPerDay;
                  const barWidth = Math.max(pxPerDay * 0.5, (endOffset - startOffset) * pxPerDay - 2);

                  let deadlineLeft: number | null = null;
                  let deadlineOverdue = false;
                  if (t.deadline) {
                    const dlDay = dayFromDateOnly(t.deadline);
                    deadlineLeft = daysBetween(range.start, dlDay) * pxPerDay + pxPerDay / 2;
                    deadlineOverdue = !t.checked && dlDay < today;
                  }

                  const tooltip = [
                    t.title,
                    `Created: ${formatDateTime(t.createdAt)}`,
                    t.checked ? `Completed: ${formatDateTime(t.completedAt)}` : null,
                  ].filter(Boolean).join('\n');

                  return (
                    <div key={row.id} style={{ height: ROW_HEIGHT, position: 'relative', borderBottom: '1px solid var(--color-surface-tint-2)' }}>
                      <div
                        onClick={() => onTaskClick(t)}
                        title={tooltip}
                        style={{
                          position: 'absolute', left: barLeft, width: barWidth, top: '50%', transform: 'translateY(-50%)',
                          height: BAR_HEIGHT, borderRadius: BAR_HEIGHT / 2, cursor: 'pointer',
                          background: t.checked ? `${barColor}80` : barColor,
                          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 4,
                          boxShadow: '0 1px 3px rgba(var(--color-black-rgb), 0.12)',
                        }}>
                        {t.checked && <Icon name="check" size={11} color="var(--color-white)" />}
                      </div>
                      {deadlineLeft !== null && (
                        <div
                          title={`Deadline: ${t.deadline}`}
                          style={{
                            position: 'absolute', left: deadlineLeft - 6, top: '50%', transform: 'translateY(-50%)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', width: 12, height: 12, zIndex: 1,
                          }}>
                          <Icon name="flag" size={13} color={deadlineOverdue ? 'var(--color-error)' : 'var(--color-text-secondary)'} />
                        </div>
                      )}
                    </div>
                  );
                })()
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
