// Solytiq Cloud — First-Launch Admin Setup Wizard
// 4 steps: Welcome → Username → Email → Password → Success
// Export: window.SetupWizard

const wizStyles = {
  wrap: { minHeight: '100vh', background: 'linear-gradient(135deg, #fdf8ff 0%, #f5f0ff 100%)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, padding: 24 },
  logoWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 },
  logo: { width: 64, height: 64, borderRadius: 16, objectFit: 'cover', boxShadow: '0 4px 20px rgba(94,77,187,0.18)' },
  brand: { fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#5e4dbb', letterSpacing: '0.01em' },
  card: { width: '100%', maxWidth: 460, background: '#ffffff', border: '1px solid #E5E7EB', borderRadius: 16, padding: '32px 36px 28px', boxShadow: '0 1px 2px rgba(0,0,0,0.05), 0 8px 32px rgba(94,77,187,0.06)', display: 'flex', flexDirection: 'column', gap: 24 },

  progressTrack: { display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' },
  progressDot: { height: 4, borderRadius: 9999, background: '#ebe6f0', transition: 'all 300ms ease' },
  progressDotActive:   { background: '#5e4dbb', width: 32 },
  progressDotDone:     { background: '#9d8dff', width: 12 },
  progressDotPending:  { background: '#ebe6f0', width: 12 },

  header: { display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'center' },
  title: { fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 24, fontWeight: 700, color: '#1c1b22', letterSpacing: '-0.015em', lineHeight: 1.2 },
  sub: { fontFamily: 'Inter, sans-serif', fontSize: 13.5, color: '#787584', lineHeight: 1.55 },

  form: { display: 'flex', flexDirection: 'column', gap: 18 },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 12.5, fontWeight: 600, color: '#484552' },
  input: { fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#1c1b22', background: '#fafaff', border: '1.5px solid #ececf3', borderRadius: 10, padding: '13px 22px', outline: 'none', width: '100%', transition: 'all 180ms' },
  inputFocus: { borderColor: '#5e4dbb', background: '#fff' },
  inputError: { borderColor: '#ba1a1a', background: '#fff5f5' },
  inputWithPrefix: { paddingLeft: 44 },
  prefix: { position: 'absolute', left: 22, top: '50%', transform: 'translateY(-50%)', fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#b0acbe', pointerEvents: 'none' },
  hint:  { fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#787584', marginTop: 2 },
  error: { fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 },

  footer: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 4 },
  backBtn:    { fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 500, color: '#484552', background: 'transparent', border: 'none', padding: '10px 6px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, transition: 'color 180ms' },
  primaryBtn: { flex: 1, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#fff', background: '#5e4dbb', border: 'none', borderRadius: 10, padding: '12px 0', cursor: 'pointer', transition: 'all 180ms', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 },
  primaryBtnDisabled: { background: '#c9c4d5', cursor: 'not-allowed' },
};

const TOTAL_STEPS = 5; // 0 welcome, 1 username, 2 email, 3 password, 4 success

function ProgressDots({ step }) {
  // 4 dots represent the 4 real steps (excluding the success state)
  return (
    <div style={wizStyles.progressTrack}>
      {[0, 1, 2, 3].map(i => {
        const s = step === 4 ? 4 : step;
        const dotStyle = s === i
          ? { ...wizStyles.progressDot, ...wizStyles.progressDotActive }
          : s > i
            ? { ...wizStyles.progressDot, ...wizStyles.progressDotDone }
            : { ...wizStyles.progressDot, ...wizStyles.progressDotPending };
        return <div key={i} style={dotStyle} />;
      })}
    </div>
  );
}

function WizInput({ value, onChange, onEnter, type = 'text', placeholder, prefix, autoFocus, error }) {
  const [focus, setFocus] = React.useState(false);
  return (
    <div style={{ position: 'relative' }}>
      {prefix && <span style={wizStyles.prefix}>{prefix}</span>}
      <input
        type={type}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onKeyDown={e => { if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); } }}
        style={{
          ...wizStyles.input,
          ...(prefix ? wizStyles.inputWithPrefix : {}),
          ...(focus ? wizStyles.inputFocus : {}),
          ...(error ? wizStyles.inputError : {}),
        }} />
    </div>
  );
}

function PasswordStrength({ password }) {
  const { score, label, color } = React.useMemo(() => {
    let s = 0;
    if (password.length >= 8) s++;
    if (password.length >= 12) s++;
    if (/[A-Z]/.test(password) && /[a-z]/.test(password)) s++;
    if (/\d/.test(password)) s++;
    if (/[^A-Za-z0-9]/.test(password)) s++;
    if (password.length === 0) return { score: 0, label: '', color: '#ebe6f0' };
    if (s <= 1) return { score: 1, label: 'Weak',     color: '#ba1a1a' };
    if (s <= 3) return { score: 2, label: 'Medium',   color: '#f59e0b' };
    if (s <= 4) return { score: 3, label: 'Strong',   color: '#10B981' };
    return { score: 4, label: 'Very Strong', color: '#10B981' };
  }, [password]);
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {[1, 2, 3, 4].map(i => (
          <div key={i} style={{ flex: 1, height: 4, borderRadius: 9999, background: i <= score ? color : '#ebe6f0', transition: 'background 220ms' }} />
        ))}
      </div>
      {label && (
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11.5, color, marginTop: 6, fontWeight: 500 }}>{label}</div>
      )}
    </div>
  );
}

function SuccessCheck() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, padding: '20px 0' }}>
      <style>{`
        @keyframes scIn  { 0%{transform:scale(0);opacity:0} 60%{transform:scale(1.1);opacity:1} 100%{transform:scale(1);opacity:1} }
        @keyframes scDraw { from { stroke-dashoffset: 24 } to { stroke-dashoffset: 0 } }
      `}</style>
      <div style={{ width: 80, height: 80, borderRadius: '50%', background: 'rgba(16,185,129,0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'scIn 420ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
        <svg width="36" height="28" viewBox="0 0 36 28">
          <path d="M3 14 L14 25 L33 4" stroke="#10B981" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" fill="none"
            strokeDasharray="40" strokeDashoffset="40" style={{ animation: 'scDraw 500ms 280ms cubic-bezier(0.65,0,0.35,1) forwards' }} />
        </svg>
      </div>
    </div>
  );
}

function SetupWizard({ onComplete }) {
  const [step, setStep] = React.useState(0);
  const [username, setUsername] = React.useState('');
  const [email,    setEmail]    = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirm,  setConfirm]  = React.useState('');
  const [showPw,   setShowPw]   = React.useState(false);
  const [touched,  setTouched]  = React.useState({});
  const [primaryHov, setPrimaryHov] = React.useState(false);
  const [backHov, setBackHov] = React.useState(false);

  // Validation
  const usernameValid = /^[A-Za-z0-9_]{3,20}$/.test(username);
  const emailValid    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const passwordValid = password.length >= 8;
  const confirmValid  = confirm === password && confirm.length > 0;

  const stepValid = step === 0 ? true
                 : step === 1 ? usernameValid
                 : step === 2 ? emailValid
                 : step === 3 ? passwordValid && confirmValid
                 : true;

  const goNext = () => {
    if (!stepValid) return;
    if (step === 3) {
      // Submit
      setStep(4);
      setTimeout(() => {
        onComplete && onComplete({ username, email, password });
      }, 1600);
      return;
    }
    setStep(s => s + 1);
  };

  const goBack = () => { if (step > 0 && step < 4) setStep(s => s - 1); };

  React.useEffect(() => {
    // Reset touched on step change
    setTouched({});
  }, [step]);

  // Step content
  let titleText, subText, body;

  if (step === 0) {
    titleText = 'Welcome to Solytiq Cloud';
    subText = "Let's set up your admin account. This is a one-time setup — it'll take less than a minute.";
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '8px 0' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '12px 14px', alignItems: 'center', width: '100%' }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="person" size={16} color="#5e4dbb" />
          </div>
          <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13.5, color: '#1c1b22' }}>Pick a username</div>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="mail" size={16} color="#5e4dbb" />
          </div>
          <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13.5, color: '#1c1b22' }}>Add your email</div>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="lock" size={16} color="#5e4dbb" />
          </div>
          <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 13.5, color: '#1c1b22' }}>Choose a secure password</div>
        </div>
      </div>
    );
  } else if (step === 1) {
    titleText = 'Pick a username';
    subText = "This is how you'll be identified inside Solytiq Cloud.";
    const showErr = touched.username && !usernameValid && username.length > 0;
    body = (
      <div style={wizStyles.fieldGroup}>
        <label style={wizStyles.label}>Username</label>
        <WizInput
          autoFocus
          value={username}
          onChange={v => { setUsername(v); setTouched(t => ({ ...t, username: true })); }}
          onEnter={goNext}
          placeholder="alex_admin"
          prefix="@"
          error={showErr} />
        {showErr ? (
          <div style={wizStyles.error}>
            <Icon name="warning" size={11} color="#ba1a1a" />
            3–20 characters, letters, numbers, and underscores only.
          </div>
        ) : (
          <div style={wizStyles.hint}>3–20 characters · letters, numbers, underscores</div>
        )}
      </div>
    );
  } else if (step === 2) {
    titleText = 'Your email address';
    subText = "We'll use this for account recovery and important notifications.";
    const showErr = touched.email && !emailValid && email.length > 0;
    body = (
      <div style={wizStyles.fieldGroup}>
        <label style={wizStyles.label}>Email</label>
        <WizInput
          autoFocus
          type="email"
          value={email}
          onChange={v => { setEmail(v); setTouched(t => ({ ...t, email: true })); }}
          onEnter={goNext}
          placeholder="you@example.com"
          error={showErr} />
        {showErr && (
          <div style={wizStyles.error}>
            <Icon name="warning" size={11} color="#ba1a1a" />
            Enter a valid email address.
          </div>
        )}
      </div>
    );
  } else if (step === 3) {
    titleText = 'Set a password';
    subText = 'Keep your admin account secure. Use at least 8 characters.';
    const pwErr = touched.password && password.length > 0 && !passwordValid;
    const cfErr = touched.confirm  && confirm.length  > 0 && !confirmValid;
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={wizStyles.fieldGroup}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <label style={wizStyles.label}>Password</label>
            <button type="button" onClick={() => setShowPw(s => !s)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 11.5, fontWeight: 600, color: '#5e4dbb', padding: 0, display: 'flex', alignItems: 'center', gap: 3 }}>
              <Icon name={showPw ? 'visibility_off' : 'visibility'} size={13} color="#5e4dbb" />
              {showPw ? 'Hide' : 'Show'}
            </button>
          </div>
          <WizInput
            autoFocus
            type={showPw ? 'text' : 'password'}
            value={password}
            onChange={v => { setPassword(v); setTouched(t => ({ ...t, password: true })); }}
            placeholder="••••••••"
            error={pwErr} />
          <PasswordStrength password={password} />
        </div>
        <div style={wizStyles.fieldGroup}>
          <label style={wizStyles.label}>Confirm Password</label>
          <WizInput
            type={showPw ? 'text' : 'password'}
            value={confirm}
            onChange={v => { setConfirm(v); setTouched(t => ({ ...t, confirm: true })); }}
            onEnter={goNext}
            placeholder="••••••••"
            error={cfErr} />
          {cfErr && (
            <div style={wizStyles.error}>
              <Icon name="warning" size={11} color="#ba1a1a" />
              Passwords don't match.
            </div>
          )}
        </div>
      </div>
    );
  } else if (step === 4) {
    titleText = `All set, @${username}!`;
    subText = 'Your admin account is ready. Taking you to your dashboard…';
    body = <SuccessCheck />;
  }

  const primaryLabel = step === 0 ? 'Get Started'
                     : step === 3 ? 'Create Account'
                     : step === 4 ? '' : 'Continue';

  return (
    <div style={wizStyles.wrap}>
      <div style={wizStyles.logoWrap}>
        <img src="../../assets/solytiq-todo-logo.png" alt="Solytiq Cloud" style={wizStyles.logo} />
        <div style={wizStyles.brand}>Solytiq Cloud · Admin Setup</div>
      </div>
      <div style={wizStyles.card}>
        <ProgressDots step={step} />

        <div style={wizStyles.header}>
          <div style={wizStyles.title}>{titleText}</div>
          <div style={wizStyles.sub}>{subText}</div>
        </div>

        {body}

        {step !== 4 && (
          <div style={{ ...wizStyles.footer, justifyContent: step === 0 ? 'center' : 'space-between' }}>
            {step > 0 && (
              <button onClick={goBack}
                onMouseEnter={() => setBackHov(true)} onMouseLeave={() => setBackHov(false)}
                style={{ ...wizStyles.backBtn, color: backHov ? '#5e4dbb' : '#484552' }}>
                <Icon name="chevron_left" size={14} color={backHov ? '#5e4dbb' : '#484552'} />
                Back
              </button>
            )}
            <button
              onClick={goNext}
              disabled={!stepValid}
              onMouseEnter={() => setPrimaryHov(true)} onMouseLeave={() => setPrimaryHov(false)}
              style={{
                ...wizStyles.primaryBtn,
                ...(!stepValid ? wizStyles.primaryBtnDisabled : {}),
                background: !stepValid ? '#c9c4d5' : (primaryHov ? '#5044aa' : '#5e4dbb'),
                boxShadow: stepValid && primaryHov ? '0 4px 14px rgba(94,77,187,0.28)' : 'none',
                transform: stepValid && primaryHov ? 'translateY(-1px)' : 'none',
                flex: step === 0 ? '0 1 auto' : 1,
                padding: step === 0 ? '12px 32px' : '12px 0',
              }}>
              {primaryLabel}
              {stepValid && <Icon name="arrow_forward" size={14} color="#fff" />}
            </button>
          </div>
        )}
      </div>

      <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 11.5, color: '#b0acbe', maxWidth: 460, textAlign: 'center' }}>
        Your data is stored locally on this device. You can edit your profile anytime from Settings.
      </div>
    </div>
  );
}

Object.assign(window, { SetupWizard });
