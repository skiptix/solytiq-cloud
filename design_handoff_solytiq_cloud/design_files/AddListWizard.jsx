// Solytiq Cloud — Add List Wizard
// Export: window.AddListWizard

const WIZ_EMOJIS = ['📋','🚴','🏃','🏠','💼','🎯','✈️','🎒','🛒','🍽️','📚','💪','🌱','🎵','💡','🔧','❤️','⭐','🏆','🌍'];
const WIZ_COLORS = [
  { label: 'Lavender', value: '#9d8dff', bg: '#F5F3FF' },
  { label: 'Emerald',  value: '#10B981', bg: '#f0fdf4' },
  { label: 'Amber',    value: '#f59e0b', bg: '#fffbeb' },
  { label: 'Rose',     value: '#f43f5e', bg: '#fff1f2' },
  { label: 'Sky',      value: '#0ea5e9', bg: '#f0f9ff' },
  { label: 'Violet',   value: '#8b5cf6', bg: '#f5f3ff' },
];
const WIZ_STEPS = ['Name & Look', 'Sections', 'Review'];

// ─── Step indicator ───────────────────────────────────────────────
function WizStep({ n, label, active, done }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11, fontWeight: 700, transition: 'all 200ms', background: done ? '#10B981' : active ? '#5e4dbb' : '#f1ecf6', color: (done || active) ? '#fff' : '#b0acbe' }}>
        {done ? '✓' : n}
      </div>
      <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: active ? 600 : 400, color: active ? '#5e4dbb' : done ? '#10B981' : '#b0acbe', transition: 'color 200ms' }}>{label}</span>
    </div>
  );
}

// ─── Section row — own component so useRef is valid ───────────────
function WizSectionRow({ sec, idx, accentColor, onUpdate, onRemove, canRemove, onPickerRequest }) {
  const openPicker = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    onPickerRequest(sec.id, { top: r.bottom + 6, left: r.left });
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <button onClick={openPicker}
          style={{ width: 36, height: 36, borderRadius: 10, border: '1.5px solid #E5E7EB', background: '#fdf8ff', fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {sec.emoji}
        </button>
      </div>

      <input
        value={sec.label}
        onChange={e => onUpdate(sec.id, 'label', e.target.value)}
        placeholder={'Section ' + (idx + 1) + ' name...'}
        style={{ flex: 1, fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#1c1b22', background: 'transparent', border: 'none', borderBottom: '1.5px solid #E5E7EB', padding: '8px 0', outline: 'none', transition: 'border-color 200ms' }}
        onFocus={e => e.target.style.borderBottomColor = accentColor}
        onBlur={e => e.target.style.borderBottomColor = '#E5E7EB'}
      />

      {canRemove && (
        <button onClick={() => onRemove(sec.id)}
          style={{ width: 28, height: 28, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 150ms' }}
          onMouseEnter={e => e.currentTarget.style.background='#fff5f5'}
          onMouseLeave={e => e.currentTarget.style.background='transparent'}>
          <Icon name="close" size={14} color="#c9c4d5" />
        </button>
      )}
    </div>
  );
}

// ─── Main Wizard ──────────────────────────────────────────────────
function AddListWizard({ onClose, onCreateList }) {
  const [step, setStep]       = React.useState(0);
  const [title, setTitle]     = React.useState('');
  const [emoji, setEmoji]     = React.useState('📋');
  const [color, setColor]     = React.useState(WIZ_COLORS[0]);
  const [subtitle, setSubtitle] = React.useState('');
  const [sections, setSections] = React.useState([{ id: 1, emoji: '📌', label: '', _open: false }]);
  const [emojiOpen, setEmojiOpen] = React.useState(false);
  const [pickerState, setPickerState] = React.useState(null);

  const handlePickerRequest = (sectionId, pos) => {
    setPickerState(s => (s && s.sectionId === sectionId) ? null : { sectionId, pos });
  };
  const closePicker = (e) => { if (e) e.stopPropagation(); setPickerState(null); };
  const pickEmoji = (em) => { if (pickerState) updateSection(pickerState.sectionId, 'emoji', em); setPickerState(null); };

  const canNext = title.trim().length > 0;

  const goTo = (n) => setStep(n);

  const addSection = () => setSections(s => [...s, { id: Date.now(), emoji: '📌', label: '', _open: false }]);
  const removeSection = (id) => setSections(s => s.filter(x => x.id !== id));
  const updateSection = (id, field, val) => setSections(s => s.map(x => x.id === id ? Object.assign({}, x, { [field]: val }) : x));

  const handleCreate = () => {
    const valid = sections.filter(s => s.label.trim());
    onCreateList({
      id: 'list-' + Date.now(),
      name: title.trim() || 'New List',
      emoji: emoji,
      color: color.value,
      colorBg: color.bg,
      subtitle: subtitle.trim(),
      sections: valid.length > 0
        ? valid.map(s => ({ id: String(s.id), emoji: s.emoji, label: s.label.trim(), tasks: [] }))
        : [{ id: 'default', emoji: '📌', label: 'Tasks', tasks: [] }],
    });
    onClose();
  };

  const inputSt = { width: '100%', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#1c1b22', background: 'transparent', border: 'none', borderBottom: '1.5px solid #E5E7EB', padding: '8px 0', outline: 'none', transition: 'border-color 200ms' };
  const labelSt = { fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: '#484552', marginBottom: 6, display: 'block' };

  return (
    <React.Fragment>
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.22)', backdropFilter: 'blur(6px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <style>{`@keyframes wizIn{from{opacity:0;transform:scale(.94) translateY(8px)}to{opacity:1;transform:scale(1) translateY(0)}}`}</style>

      <div
        onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 480, background: '#fff', borderRadius: 18, boxShadow: '0 16px 56px rgba(0,0,0,0.16)', animation: 'wizIn 300ms cubic-bezier(0.34,1.56,0.64,1) both', overflow: 'hidden' }}>

        {/* Accent bar */}
        <div style={{ height: 5, background: color.value, transition: 'background 300ms' }} />

        {/* Header */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #f7f4fc' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22' }}>New List</span>
            <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              onMouseEnter={e => e.currentTarget.style.background='#f1ecf6'}
              onMouseLeave={e => e.currentTarget.style.background='transparent'}>
              <Icon name="close" size={15} color="#787584" />
            </button>
          </div>

          {/* Step indicators */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {WIZ_STEPS.map((lbl, i) => (
              <React.Fragment key={i}>
                <WizStep n={i + 1} label={lbl} active={step === i} done={step > i} />
                {i < WIZ_STEPS.length - 1 && (
                  <div style={{ flex: 1, height: 2, borderRadius: 2, background: step > i ? '#10B981' : '#f1ecf6', transition: 'background 300ms', maxWidth: 32 }} />
                )}
              </React.Fragment>
            ))}
          </div>
        </div>

        {/* Content */}
        <div style={{ padding: '24px 24px 0', minHeight: 300 }}>

          {/* ── Step 0: Name & Look ── */}
          {step === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <button onClick={() => setEmojiOpen(o => !o)}
                    style={{ width: 52, height: 52, borderRadius: 14, border: '2px solid ' + (emojiOpen ? color.value : '#E5E7EB'), background: color.bg, fontSize: 24, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms' }}>
                    {emoji}
                  </button>
                  {emojiOpen && (
                    <div onClick={e => e.stopPropagation()}
                      style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 100, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 10, boxShadow: '0 4px 20px rgba(0,0,0,0.1)', display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 4 }}>
                      {WIZ_EMOJIS.map(e => (
                        <button key={e} onClick={() => { setEmoji(e); setEmojiOpen(false); }}
                          style={{ width: 34, height: 34, borderRadius: 8, border: 'none', background: emoji === e ? color.bg : 'transparent', fontSize: 18, cursor: 'pointer', transition: 'background 100ms' }}
                          onMouseEnter={ev => ev.currentTarget.style.background=color.bg}
                          onMouseLeave={ev => ev.currentTarget.style.background=emoji===e ? color.bg : 'transparent'}>
                          {e}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ flex: 1 }}>
                  <label style={labelSt}>List Name *</label>
                  <input autoFocus value={title} onChange={e => setTitle(e.target.value)}
                    placeholder="e.g. Backyard 2026, Groceries..."
                    style={inputSt}
                    onFocus={e => e.target.style.borderBottomColor=color.value}
                    onBlur={e => e.target.style.borderBottomColor='#E5E7EB'}
                    onKeyDown={e => e.key === 'Enter' && canNext && goTo(1)} />
                </div>
              </div>

              <div>
                <label style={labelSt}>
                  Subtitle <span style={{ color: '#b0acbe', fontWeight: 400 }}>(optional)</span>
                </label>
                <input value={subtitle} onChange={e => setSubtitle(e.target.value)}
                  placeholder="e.g. Hamburg's Backyard Ultra..."
                  style={inputSt}
                  onFocus={e => e.target.style.borderBottomColor=color.value}
                  onBlur={e => e.target.style.borderBottomColor='#E5E7EB'} />
              </div>

              <div>
                <label style={labelSt}>Accent Color</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {WIZ_COLORS.map(c => (
                    <button key={c.value} onClick={() => setColor(c)} title={c.label}
                      style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer', padding: 3, outline: color.value === c.value ? ('3px solid ' + c.value) : 'none', outlineOffset: 2, transition: 'all 150ms' }}>
                      <div style={{ width: '100%', height: '100%', borderRadius: '50%', background: c.value }} />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── Step 1: Sections ── */}
          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', marginBottom: 4 }}>
                Sections group your tasks. You can always edit these later.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 260, overflowY: 'auto' }}>
                {sections.map((sec, i) => (
                  <WizSectionRow key={sec.id} sec={sec} idx={i} accentColor={color.value}
                    onUpdate={updateSection} onRemove={removeSection} canRemove={sections.length > 1} onPickerRequest={handlePickerRequest} />
                ))}
              </div>
              <button onClick={addSection}
                style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: '1.5px dashed ' + color.value, borderRadius: 9, padding: '8px 14px', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 600, color: color.value, cursor: 'pointer', transition: 'all 150ms', alignSelf: 'flex-start' }}
                onMouseEnter={e => e.currentTarget.style.background=color.bg}
                onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                <Icon name="add" size={14} color={color.value} /> Add Section
              </button>
            </div>
          )}

          {/* ── Step 2: Review ── */}
          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div style={{ background: color.bg, border: '1.5px solid ' + color.value + '40', borderRadius: 14, padding: '16px 18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <span style={{ fontSize: 28 }}>{emoji}</span>
                  <div>
                    <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 17, fontWeight: 700, color: '#1c1b22' }}>{title || 'New List'}</div>
                    {subtitle && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11, color: '#787584', marginTop: 2 }}>{subtitle}</div>}
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {sections.filter(s => s.label.trim()).length > 0
                    ? sections.filter(s => s.label.trim()).map(s => (
                        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 13 }}>{s.emoji}</span>
                          <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#5e5e5e' }}>{s.label}</span>
                        </div>
                      ))
                    : <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe', fontStyle: 'italic' }}>Default section will be created</div>
                  }
                </div>
              </div>
              <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', textAlign: 'center', lineHeight: 1.6 }}>
                Your list will appear in the sidebar. You can add tasks right away!
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 24px' }}>
          <button onClick={step === 0 ? onClose : () => goTo(step - 1)}
            style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#787584', background: 'transparent', border: '1px solid #E5E7EB', borderRadius: 9, padding: '9px 20px', cursor: 'pointer', transition: 'all 180ms' }}
            onMouseEnter={e => e.currentTarget.style.background='#f7f2fc'}
            onMouseLeave={e => e.currentTarget.style.background='transparent'}>
            {step === 0 ? 'Cancel' : 'Back'}
          </button>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {step === 1 && (
              <button onClick={() => goTo(2)}
                style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, color: '#b0acbe', background: 'transparent', border: 'none', cursor: 'pointer', padding: '9px 10px' }}>
                Skip
              </button>
            )}
            <button
              onClick={step === 2 ? handleCreate : () => canNext && goTo(step + 1)}
              disabled={step === 0 && !canNext}
              style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#fff', background: (step === 0 && !canNext) ? '#c8bfff' : color.value, border: 'none', borderRadius: 9, padding: '9px 22px', cursor: (step === 0 && !canNext) ? 'not-allowed' : 'pointer', transition: 'all 180ms', opacity: 1 }}
              onMouseEnter={e => { if (step !== 0 || canNext) e.currentTarget.style.opacity='0.85'; }}
              onMouseLeave={e => e.currentTarget.style.opacity='1'}>
              {step === 2 ? 'Create List' : 'Continue'}
            </button>
          </div>
        </div>

      </div>
    </div>

      {pickerState && (
        <div onClick={closePicker}
          style={{ position: 'fixed', top: pickerState.pos.top, left: pickerState.pos.left, zIndex: 9999, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, padding: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.14)', display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 3 }}>
          {WIZ_EMOJIS.map(e => (
            <button key={e} onClick={ev => { ev.stopPropagation(); pickEmoji(e); }}
              style={{ width: 30, height: 30, borderRadius: 6, border: 'none', background: 'transparent', fontSize: 16, cursor: 'pointer' }}
              onMouseEnter={ev => ev.currentTarget.style.background='#f1ecf6'}
              onMouseLeave={ev => ev.currentTarget.style.background='transparent'}>
              {e}
            </button>
          ))}
        </div>
      )}
    </React.Fragment>
  );
}

Object.assign(window, { AddListWizard });
