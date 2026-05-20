// Solytiq Cloud — Backyard 2026 List Screen
// Uses window.AppContext for shared state
// Export: window.ListScreen, window.INITIAL_LIST_SECTIONS

const INITIAL_LIST_SECTIONS = [
  {
    id: 'rad', emoji: '🚴', label: 'Rad & Antrieb',
    tasks: [
      { id: 101, title: 'Fahrrad Vollwartung (Kette, Bremsen, Schaltung)', checked: false },
      { id: 102, title: 'Reifendruck prüfen und anpassen', checked: true },
      { id: 103, title: 'Ersatzschlauch & Flickzeug einpacken', checked: false },
      { id: 104, title: 'Licht vorne & hinten testen', checked: false },
    ]
  },
  {
    id: 'kleidung', emoji: '👕', label: 'Kleidung & Ausrüstung',
    tasks: [
      { id: 201, title: 'Trikot × 3 (kurz + lang)', checked: false },
      { id: 202, title: 'Radhose (gepolstert) × 2', checked: false },
      { id: 203, title: 'Regenjacke (wasserdicht, leicht)', checked: true },
      { id: 204, title: 'Helm mit frischen Polstern', checked: false },
    ]
  },
  {
    id: 'ernaehrung', emoji: '🍌', label: 'Ernährung & Verpflegung',
    tasks: [
      { id: 301, title: 'Energieriegel × 20 (gemischt)', checked: false },
      { id: 302, title: 'Elektrolyt-Tabs (2 Röhrchen)', checked: false },
      { id: 303, title: 'Trinkflaschen × 2 befüllen', checked: false },
    ]
  },
];

const listStyles = {
  page: { flex: 1, height: '100%', overflowY: 'auto' },
  inner: { maxWidth: 680, margin: '0 auto', padding: '32px 24px 64px', width: '100%', display: 'flex', flexDirection: 'column', gap: 28 },
  hero: { display: 'flex', flexDirection: 'column', gap: 16, padding: '24px 24px 20px', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 16 },
  heroTop: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  heroLeft: { display: 'flex', flexDirection: 'column', gap: 4 },
  heroTitle: { fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 22, fontWeight: 700, color: '#1c1b22', letterSpacing: '-0.01em' },
  heroSub: { fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584' },
  heroPct: { fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 40, fontWeight: 700, color: '#5e4dbb', lineHeight: 1, letterSpacing: '-0.02em' },
  progressTrack: { height: 6, background: '#ebe6f0', borderRadius: 9999, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 9999, transition: 'width 600ms ease-in-out' },
  progressMeta: { display: 'flex', justifyContent: 'space-between', fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584' },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0 8px' },
  sectionLabel: { fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: '#5e5e5e' },
  sectionDivider: { flex: 1, height: 1, background: '#E5E7EB' },
};

function ListScreen({ listId = 'backyard-2026' }) {
  const { lists, setLists, addToTrash } = React.useContext(window.AppContext);
  const list = lists.find(l => l.id === listId) || lists[0];
  const sections = list ? list.sections : [];

  const [draggedId, setDraggedId] = React.useState(null);
  const [dragOverId, setDragOverId] = React.useState(null);

  const updateSections = (fn) => {
    setLists(prev => prev.map(l => l.id === list.id ? { ...l, sections: fn(l.sections) } : l));
  };

  const toggle = (taskId) => updateSections(secs => secs.map(s => ({
    ...s, tasks: s.tasks.map(t => t.id === taskId ? { ...t, checked: !t.checked } : t)
  })));

  const deleteTask = (taskId) => {
    let found;
    for (const sec of sections) { found = sec.tasks.find(t => t.id === taskId); if (found) break; }
    if (found) addToTrash(found, { src: 'list', listId: list.id, listName: list.name });
    updateSections(secs => secs.map(s => ({ ...s, tasks: s.tasks.filter(t => t.id !== taskId) })));
  };

  const updateTask = (taskId, updates) => updateSections(secs => secs.map(s => ({
    ...s, tasks: s.tasks.map(t => t.id === taskId ? { ...t, ...updates } : t)
  })));

  const handleDrop = (targetId) => {
    if (!draggedId || draggedId === targetId) return;
    updateSections(prev => {
      let srcSec, srcTask;
      for (const sec of prev) {
        const i = sec.tasks.findIndex(t => t.id === draggedId);
        if (i !== -1) { srcSec = sec.id; srcTask = sec.tasks[i]; break; }
      }
      let tgtSec, tgtIdx;
      for (const sec of prev) {
        const i = sec.tasks.findIndex(t => t.id === targetId);
        if (i !== -1) { tgtSec = sec.id; tgtIdx = i; break; }
      }
      if (!srcTask) return prev;
      return prev.map(sec => {
        let tasks = [...sec.tasks];
        if (sec.id === srcSec) tasks = tasks.filter(t => t.id !== draggedId);
        if (sec.id === tgtSec) {
          const insertIdx = sec.id === srcSec ? tasks.findIndex(t => t.id === targetId) : tgtIdx;
          tasks.splice(Math.max(0, insertIdx), 0, srcTask);
        }
        return { ...sec, tasks };
      });
    });
    setDraggedId(null); setDragOverId(null);
  };

  const allTasks = sections.flatMap(s => s.tasks);
  const total = allTasks.length;
  const done  = allTasks.filter(t => t.checked).length;
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
  const fillColor = pct === 100 ? '#10B981' : '#5e4dbb';

  if (!list) return <div style={{ padding: 32, color: '#787584' }}>List not found.</div>;

  return (
    <div style={listStyles.page}>
      <div style={listStyles.inner}>
        {/* Hero */}
        <div style={listStyles.hero}>
          <div style={listStyles.heroTop}>
            <div style={listStyles.heroLeft}>
              <div style={listStyles.heroTitle}>{list.name}</div>
              <div style={listStyles.heroSub}>{list.subtitle || ''} · {done} von {total} erledigt</div>
            </div>
            <div style={listStyles.heroPct}>{pct}%</div>
          </div>
          <div style={listStyles.progressTrack}>
            <div style={{ ...listStyles.progressFill, width: `${pct}%`, background: fillColor }} />
          </div>
          <div style={listStyles.progressMeta}>
            <span>{done} abgeschlossen</span>
            <span>{total - done} verbleibend</span>
          </div>
        </div>

        {/* Sections */}
        {sections.map(sec => (
          <section key={sec.id}>
            <div style={listStyles.sectionHeader}>
              <span style={{ fontSize: 16 }}>{sec.emoji}</span>
              <span style={listStyles.sectionLabel}>{sec.label}</span>
              <div style={listStyles.sectionDivider} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {sec.tasks.map(task => (
                <TaskItem key={task.id} task={task}
                  onToggle={toggle} onDelete={deleteTask} onUpdate={updateTask}
                  onDragStart={id => setDraggedId(id)}
                  onDragOver={id => setDragOverId(id)}
                  onDrop={handleDrop}
                  onDragEnd={() => { setDraggedId(null); setDragOverId(null); }}
                  isDragging={draggedId === task.id}
                  isDragOver={dragOverId === task.id && draggedId !== task.id} />
              ))}
            </div>
          </section>
        ))}

        <QuickAdd
          placeholder="Neuen Eintrag hinzufügen..."
          onAdd={data => {
            const newTask = { id: Date.now(), checked: false, ...data };
            updateSections(secs => {
              if (secs.length === 0) return secs;
              return secs.map((s, i) => i === 0 ? { ...s, tasks: [...s.tasks, newTask] } : s);
            });
          }} />
      </div>
    </div>
  );
}

Object.assign(window, { ListScreen, INITIAL_LIST_SECTIONS });
