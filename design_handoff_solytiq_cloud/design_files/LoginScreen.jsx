// Solytiq Cloud — Login Screen
// Export: window.LoginScreen

const loginStyles = {
  wrap: { minHeight: '100vh', background: 'linear-gradient(135deg, #fdf8ff 0%, #f5f0ff 100%)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, padding: 24 },
  logoWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0 },
  logo: { width: 80, height: 80, borderRadius: 20, objectFit: 'cover', boxShadow: '0 4px 20px rgba(94,77,187,0.18)' },
  card: { width: '100%', maxWidth: 400, background: '#ffffff', border: '1px solid #E5E7EB', borderRadius: 12, padding: '40px 40px 36px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', display: 'flex', flexDirection: 'column', gap: 28 },
  header: { textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 6 },
  title: { fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 30, fontWeight: 700, color: '#1c1b22', letterSpacing: '-0.02em', lineHeight: 1.2 },
  sub: { fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#787584', lineHeight: 1.5 },
  form: { display: 'flex', flexDirection: 'column', gap: 20 },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#484552' },
  input: { fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#1c1b22', background: 'transparent', border: 'none', borderBottom: '1.5px solid #E5E7EB', padding: '8px 0', outline: 'none', width: '100%', transition: 'border-color 200ms' },
  optionsRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: -4 },
  rememberWrap: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' },
  cb: { width: 18, height: 18, borderRadius: 4, border: '1.5px solid #c9c4d5', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms', flexShrink: 0 },
  cbChecked: { background: '#5e4dbb', borderColor: '#5e4dbb' },
  rememberText: { fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#484552' },
  forgotLink: { fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#5e4dbb', textDecoration: 'none', cursor: 'pointer', background: 'none', border: 'none' },
  submitBtn: { width: '100%', background: '#5e4dbb', color: '#fff', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 500, letterSpacing: '0.01em', padding: '11px 0', borderRadius: 8, border: 'none', cursor: 'pointer', transition: 'all 180ms ease-in-out', marginTop: 4 }
};

function LoginScreen({ onSignIn }) {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [remember, setRemember] = React.useState(false);
  const [emailFocus, setEmailFocus] = React.useState(false);
  const [passFocus, setPassFocus] = React.useState(false);
  const [btnHover, setBtnHover] = React.useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (onSignIn) onSignIn();
  };

  return (
    <div style={loginStyles.wrap}>
      <div style={loginStyles.logoWrap}>
        <img src="../../assets/solytiq-todo-logo.png" alt="Solytiq Cloud" style={loginStyles.logo} />
      </div>
      <div style={loginStyles.card}>
        <div style={loginStyles.header}>
          <div style={loginStyles.title}>Welcome Back</div>
          <div style={loginStyles.sub}>Sign in to continue.</div>
        </div>
        <form style={loginStyles.form} onSubmit={handleSubmit}>
          <div style={loginStyles.fieldGroup}>
            <label style={loginStyles.label}>Email or Username</label>
            <input
              type="text" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="Enter your email..."
              style={{ ...loginStyles.input, borderBottomColor: emailFocus ? '#5e4dbb' : '#E5E7EB', borderBottomWidth: emailFocus ? 2 : 1.5 }}
              onFocus={() => setEmailFocus(true)} onBlur={() => setEmailFocus(false)}
            />
          </div>
          <div style={loginStyles.fieldGroup}>
            <label style={loginStyles.label}>Password</label>
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              style={{ ...loginStyles.input, borderBottomColor: passFocus ? '#5e4dbb' : '#E5E7EB', borderBottomWidth: passFocus ? 2 : 1.5 }}
              onFocus={() => setPassFocus(true)} onBlur={() => setPassFocus(false)}
            />
          </div>
          <div style={loginStyles.optionsRow}>
            <div style={loginStyles.rememberWrap} onClick={() => setRemember(r => !r)}>
              <div style={{ ...loginStyles.cb, ...(remember ? loginStyles.cbChecked : {}) }}>
                {remember && <svg width="10" height="8" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
              </div>
              <span style={loginStyles.rememberText}>Remember me</span>
            </div>
            <button type="button" style={loginStyles.forgotLink}>Forgot password?</button>
          </div>
          <button
            type="submit"
            style={{ ...loginStyles.submitBtn, background: btnHover ? '#5044aa' : '#5e4dbb', transform: btnHover ? 'translateY(-1px)' : 'none', boxShadow: btnHover ? '0 4px 12px rgba(94,77,187,0.22)' : 'none' }}
            onMouseEnter={() => setBtnHover(true)}
            onMouseLeave={() => setBtnHover(false)}>
            Sign In
          </button>
        </form>
      </div>
    </div>
  );
}

Object.assign(window, { LoginScreen });
