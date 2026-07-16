import { usePageTitle } from "../hooks/usePageTitle";
import { useState, useEffect } from 'react';
import { useMobile } from '../hooks/useBreakpoint';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import type { Task, List } from '../types';
import useAppStore from '../store/useAppStore';
import UpcomingTimelineWidget from '../components/UpcomingTimelineWidget';
import Icon from '../components/Icon';

// ── Date helpers ────────────────────────────────────────────────
function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const todayStr = () => toIso(new Date());
function nextWeekStr(): string { const t = new Date(); t.setDate(t.getDate() + 7); return toIso(t); }
function isDueToday(t: Task) { return t.deadline === todayStr(); }
function isDueThisWeek(t: Task) { const d = t.deadline; return d ? d > todayStr() && d <= nextWeekStr() : false; }
function friendlyDate(iso?: string) {
  if (!iso) return '';
  const td = todayStr();
  if (iso === td) return 'Today';
  const d = new Date(iso.slice(0, 10) + 'T12:00:00');
  const tom = new Date(); tom.setDate(tom.getDate() + 1);
  if (iso === toIso(tom)) return 'Tomorrow';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// ── Animated progress bar ───────────────────────────────────────
function AnimatedBar({ pct, color, height = 8, delay = 150 }: { pct: number; color: string; height?: number; delay?: number }) {
  const [w, setW] = useState(0);
  useEffect(() => { const t = setTimeout(() => setW(pct), delay); return () => clearTimeout(t); }, [pct, delay]);
  return (
    <div style={{ background: 'var(--color-divider)', borderRadius: 9999, height, overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${w}%`, background: color, borderRadius: 9999, transition: 'width 900ms cubic-bezier(0.34,1.56,0.64,1)' }} />
    </div>
  );
}

// ── Stat card ───────────────────────────────────────────────────
function StatCard({ num, label, sub, icon, iconBg, iconColor, accent }: { num: number; label: string; sub: string; icon: string; iconBg: string; iconColor: string; accent?: string }) {
  const [hov, setHov] = useState(false);
  return (
    <div onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ background: 'var(--color-surface-gray)', border: `1px solid ${hov ? 'var(--color-purple-tint-2)' : 'var(--color-border-alt)'}`, borderRadius: 12, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10, transition: 'all 180ms', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ width: 34, height: 34, borderRadius: 10, background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={icon} size={17} color={iconColor} />
        </div>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, fontWeight: 600, color: accent ?? 'var(--color-text-tertiary)', background: accent ? `${accent}14` : 'var(--color-surface-tint-2)', borderRadius: 9999, padding: '2px 8px', textTransform: 'uppercase' as const, letterSpacing: '0.04em' }}>{sub}</span>
      </div>
      <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, color: 'var(--color-text-primary)', fontSize: 30, lineHeight: 1, letterSpacing: '-0.02em' }}>{num}</span>
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)' }}>{label}</div>
    </div>
  );
}

// ── Mini task row ───────────────────────────────────────────────
function MiniTask({ task, onGo }: { task: Task; onGo: () => void }) {
  const [hov, setHov] = useState(false);
  const PCOLS: Record<string, string> = { High: 'var(--color-orange)', Medium: 'var(--color-warning-alt)', Low: 'var(--color-text-tertiary)' };
  return (
    <div onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)} onClick={onGo}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, background: hov ? 'var(--color-surface-tint)' : 'transparent', cursor: 'pointer', transition: 'background 150ms' }}>
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--color-border-strong)', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</div>
        {task._listName && <div style={{ fontFamily: 'var(--font-body)', fontSize: 10.5, color: 'var(--color-text-tertiary)', marginTop: 1 }}>in {task._listName}</div>}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
        {task.priority && <span style={{ fontSize: 10, fontWeight: 600, fontFamily: 'var(--font-body)', color: PCOLS[task.priority] }}>{task.priority}</span>}
        <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)' }}>{friendlyDate(task.deadline)}</span>
      </div>
    </div>
  );
}

// ── Task panel (today / week) ───────────────────────────────────
function TaskPanel({ title, icon, accent, accentBg, tasks, emptyText, onGo }: {
  title: string; icon: string; accent: string; accentBg: string; tasks: Task[]; emptyText: string; onGo: (listId: string) => void;
}) {
  const visible = tasks.slice(0, 6);
  const more = tasks.length - visible.length;
  return (
    <div style={{ background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 14, padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 4px 6px' }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: accentBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={icon} size={15} color={accent} />
        </div>
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)' }}>{title}</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 700, color: accent, background: accentBg, borderRadius: 9999, padding: '2px 9px' }}>{tasks.length}</span>
      </div>
      {tasks.length === 0
        ? <div style={{ padding: '24px 12px', textAlign: 'center', fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>{emptyText}</div>
        : <>
            {visible.map(t => <MiniTask key={`${t._listId}-${t.id}`} task={t} onGo={() => t._listId && onGo(t._listId)} />)}
            {more > 0 && <div style={{ padding: '6px 10px', fontFamily: 'var(--font-heading)', fontSize: 12, color: 'var(--color-text-quaternary)', textAlign: 'center' }}>+{more} more</div>}
          </>
      }
    </div>
  );
}

// ── List card ───────────────────────────────────────────────────
function ListCard({ list, onClick, index, folderColor }: { list: List; onClick: () => void; index: number; folderColor: string }) {
  const [hov, setHov] = useState(false);
  const tasks = list.sections.flatMap(s => s.tasks);
  const total = tasks.length;
  const done = tasks.filter(t => t.checked).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const color = list.color ?? folderColor;
  const [barW, setBarW] = useState(0);
  useEffect(() => { const t = setTimeout(() => setBarW(pct), 350 + index * 70); return () => clearTimeout(t); }, [pct, index]);

  return (
    <div
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      onClick={onClick} role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && onClick()}
      aria-label={`Open ${list.name} list`}
      style={{
        background: hov ? (list.colorBg ?? `${color}12`) : 'var(--color-surface-gray)',
        border: `1px solid ${hov ? color + '55' : 'var(--color-border-alt)'}`,
        borderRadius: 14, padding: '18px 16px', cursor: 'pointer',
        transition: 'all 220ms cubic-bezier(0.34,1.56,0.64,1)',
        transform: hov ? 'translateY(-3px)' : 'none',
        boxShadow: hov ? `0 8px 24px ${color}1a` : 'none',
        animation: `cardIn 380ms cubic-bezier(0.34,1.56,0.64,1) ${index * 60}ms both`,
        display: 'flex', flexDirection: 'column', gap: 12, outline: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flexShrink: 0, paddingTop: 2 }}>
          {list.emoji
            ? <span style={{ fontSize: 22, lineHeight: 1 }}>{list.emoji}</span>
            : <div style={{ width: 32, height: 32, borderRadius: 8, background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="format_list_bulleted" size={16} color={color} />
              </div>
          }
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{list.name}</div>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 3 }}>{done}/{total} done</div>
        </div>
        <Icon name={list.isPublic !== false ? 'public' : 'lock'} size={12} color="var(--color-border-strong)" />
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 700, color }}>{pct}%</span>
          <span style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)' }}>{total - done} left</span>
        </div>
        <div style={{ background: 'var(--color-divider)', borderRadius: 9999, height: 5, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${barW}%`, background: color, borderRadius: 9999, transition: 'width 900ms cubic-bezier(0.34,1.56,0.64,1)' }} />
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: hov ? color : 'var(--color-text-quaternary)', display: 'flex', alignItems: 'center', gap: 4, transition: 'color 200ms' }}>
          Open list <Icon name="arrow_forward" size={13} color={hov ? color : 'var(--color-text-quaternary)'} />
        </span>
      </div>
    </div>
  );
}

// ── Folder Dashboard Screen ─────────────────────────────────────
export default function FolderDashboardScreen() {
  const { folderId } = useParams<{ folderId: string }>();
  const navigate = useNavigate();
  const { folders, lists, listsLoading } = useAppStore();
  const isMobile = useMobile();

  // On a page refresh the workspace data is fetched asynchronously, so `folders`
  // is empty for the first render(s). Wait for at least one load cycle to settle
  // before deciding the folder doesn't exist — otherwise we'd redirect to the
  // dashboard and the folder would appear to "disappear". `listsLoading` isn't
  // true yet on the very first render (the loader runs in a parent effect), so
  // we also give a short grace window.
  const [graceElapsed, setGraceElapsed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGraceElapsed(true), 2000);
    return () => clearTimeout(t);
  }, []);

  const folder = folders.find(f => f.id === folderId);

  let pageTitle = 'Loading folder...';
  if (!folder && !listsLoading && graceElapsed) {
    pageTitle = 'Folder not found';
  } else if (folder) {
    const prefix = folder.emoji ? `${folder.emoji} ` : '';
    pageTitle = `${prefix}${folder.name}`;
  }
  usePageTitle(pageTitle);

  if (!folder) {
    if (listsLoading || !graceElapsed) {
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 32, height: 32, border: '3px solid var(--color-border)', borderTopColor: 'var(--color-primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
        </div>
      );
    }
    return <Navigate to="/dashboard" replace />;
  }

  const ac = folder.color ?? 'var(--color-primary)';
  const acBg = `${ac}15`;

  const folderLists = lists
    .filter(l => l.folderId === folderId)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const allTasks = folderLists.flatMap(l =>
    l.sections.flatMap(s => s.tasks.map(t => ({ ...t, _source: 'list' as const, _listId: l.id, _listName: l.name })))
  );

  const total = allTasks.length;
  const done = allTasks.filter(t => t.checked).length;
  const open = total - done;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const todayTasks = allTasks.filter(t => isDueToday(t) && !t.checked);
  const weekTasks = allTasks.filter(t => isDueThisWeek(t) && !t.checked);

  return (
    <div style={{ flex: 1, height: '100%', overflowY: 'auto' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: isMobile ? '20px 16px 80px' : '32px 32px 48px', display: 'flex', flexDirection: 'column', gap: 24, width: '100%' }}>

        {/* ── Header ─────────────────────────────────────────── */}
        <header style={{ animation: 'folderDashIn 420ms ease both' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
            {folder.emoji
              ? <span style={{ fontSize: 40, lineHeight: 1, filter: 'drop-shadow(0 2px 8px rgba(var(--color-black-rgb), 0.10))' }}>{folder.emoji}</span>
              : <div style={{ width: 52, height: 52, borderRadius: 14, background: acBg, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 4px 14px ${ac}22` }}>
                  <Icon name="folder" size={28} color={ac} />
                </div>
            }
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <h1 style={{ fontFamily: 'var(--font-heading)', fontSize: 28, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.02em', lineHeight: 1.15 }}>
                  {folder.name}
                </h1>
                <span style={{
                  fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 600,
                  color: folder.isPublic !== false ? 'var(--color-green-deep-3)' : 'var(--color-text-tertiary)',
                  background: folder.isPublic !== false ? 'rgba(var(--color-green-deep-3-rgb), 0.09)' : 'var(--color-surface-tint-2)',
                  borderRadius: 9999, padding: '3px 10px',
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                }}>
                  <Icon name={folder.isPublic !== false ? 'public' : 'lock'} size={11} color={folder.isPublic !== false ? 'var(--color-green-deep-3)' : 'var(--color-text-tertiary)'} />
                  {folder.isPublic !== false ? 'Public' : 'Private'}
                </span>
              </div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-tertiary)', marginTop: 5 }}>
                {folderLists.length} to-do{folderLists.length !== 1 ? 's' : ''} · {total} task{total !== 1 ? 's' : ''}
              </div>
            </div>
          </div>

          {/* Overall progress card */}
          <div style={{ background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 14, padding: '20px 22px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
              <div>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 3 }}>Overall Progress</div>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>{done} of {total} tasks complete</div>
              </div>
              <div>
                <span style={{ fontFamily: 'var(--font-heading)', fontSize: 34, fontWeight: 700, color: ac, letterSpacing: '-0.03em', lineHeight: 1 }}>{pct}</span>
                <span style={{ fontFamily: 'var(--font-heading)', fontSize: 18, fontWeight: 600, color: ac }}>%</span>
              </div>
            </div>
            <AnimatedBar pct={pct} color={ac} height={10} />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-success)', fontWeight: 600 }}>✓ {done} done</span>
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-quaternary)' }}>{open} remaining</span>
            </div>
          </div>
        </header>

        {/* ── Upcoming timeline events (scoped to this folder) ─── */}
        <UpcomingTimelineWidget folderId={folderId} accent={ac} />

        {/* ── Stat cards ─────────────────────────────────────── */}
        <section style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 12, animation: 'folderDashIn 420ms 80ms ease both' }}>
          <StatCard num={open} label="Open Tasks" sub="remaining" icon="inventory_2" iconBg="var(--color-surface-tint)" iconColor="var(--color-primary)" />
          <StatCard num={done} label="Completed" sub={total > 0 ? `${pct}%` : 'none yet'} icon="check_circle" iconBg="rgba(var(--color-success-rgb), 0.10)" iconColor="var(--color-success)" accent="var(--color-success)" />
          <StatCard num={todayTasks.length} label="Due Today" sub="urgent" icon="today" iconBg="rgba(var(--color-orange-rgb), 0.10)" iconColor="var(--color-orange)" accent="var(--color-orange)" />
          <StatCard num={folderLists.length} label="To-Dos" sub="in folder" icon="folder_open" iconBg={acBg} iconColor={ac} accent={ac} />
        </section>

        {/* ── Task panels ─────────────────────────────────────── */}
        <section style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16, animation: 'folderDashIn 420ms 160ms ease both' }}>
          <TaskPanel
            title="Due Today" icon="today" accent="var(--color-orange)" accentBg="rgba(var(--color-orange-rgb), 0.08)"
            tasks={todayTasks} emptyText="Nothing due today — you're on track!"
            onGo={id => navigate(`/list/${id}`)}
          />
          <TaskPanel
            title="This Week" icon="calendar_month" accent={ac} accentBg={acBg}
            tasks={weekTasks} emptyText="No tasks scheduled for this week."
            onGo={id => navigate(`/list/${id}`)}
          />
        </section>

        {/* ── Lists grid ─────────────────────────────────────── */}
        <section style={{ animation: 'folderDashIn 420ms 240ms ease both' }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="folder_open" size={18} color={ac} />
            To-Dos in {folder.name}
          </div>
          {folderLists.length === 0 ? (
            <div style={{ background: 'var(--color-surface-gray)', border: '1px dashed var(--color-border-alt)', borderRadius: 14, padding: '56px 24px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
              <Icon name="playlist_add" size={36} color="var(--color-text-quaternary)" />
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 600, color: 'var(--color-text-quaternary)' }}>No to-dos yet</div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>Move or add a to-do to this folder from the sidebar</div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
              {folderLists.map((list, i) => (
                <ListCard key={list.id} list={list} onClick={() => navigate(`/list/${list.id}`)} index={i} folderColor={ac} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
