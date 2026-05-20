import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import useAuthStore from '../store/useAuthStore';

const s: Record<string, CSSProperties> = {
  wrap: { minHeight: '100vh', background: 'linear-gradient(135deg, #fdf8ff 0%, #f5f0ff 100%)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, padding: 24 },
  card: { width: '100%', maxWidth: 400, background: '#ffffff', border: '1px solid #E5E7EB', borderRadius: 12, padding: '40px 40px 36px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', display: 'flex', flexDirection: 'column', gap: 28 },
  title: { fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 30, fontWeight: 700, color: '#1c1b22', letterSpacing: '-0.02em', lineHeight: 1.2 },
  sub: { fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#787584', lineHeight: 1.5 },
  label: { fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#484552' },
  input: { fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#1c1b22', background: 'transparent', border: 'none', padding: '8px 0', outline: 'none', width: '100%', transition: 'border-color 200ms' },
};

export default function LoginScreen() {
  const navigate = useNavigate();
  const { signIn } = useAuthStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [userFocus, setUserFocus] = useState(false);
  const [passFocus, setPassFocus] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) { setError('Please enter username and password.'); return; }
    setLoading(true);
    setError('');
    const ok = await signIn(username.trim(), password);
    setLoading(false);
    if (ok) {
      navigate('/dashboard');
    } else {
      setError('Invalid username or password.');
      setShake(true);
      setTimeout(() => setShake(false), 600);
    }
  };

  return (
    <div style={s.wrap}>
      <img src="/solytiq-todo-logo.png" alt="Solytiq Cloud" style={{ width: 80, height: 80, borderRadius: 20, objectFit: 'cover', boxShadow: '0 4px 20px rgba(94,77,187,0.18)' }} />
      <div style={{ ...s.card, animation: shake ? 'shake 400ms ease-in-out' : undefined }}>
        <div style={{ textAlign: 'center' }}>
          <div style={s.title}>Welcome Back</div>
          <div style={{ ...s.sub, marginTop: 6 }}>Sign in to continue.</div>
        </div>
        <form style={{ display: 'flex', flexDirection: 'column', gap: 20 }} onSubmit={handleSubmit}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={s.label}>Username</label>
            <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="Enter your username…"
              autoFocus autoComplete="username"
              style={{ ...s.input, borderBottom: `${userFocus ? 2 : 1.5}px solid ${userFocus ? '#5e4dbb' : '#E5E7EB'}` }}
              onFocus={() => setUserFocus(true)} onBlur={() => setUserFocus(false)} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={s.label}>Password</label>
            <div style={{ position: 'relative' }}>
              <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••"
                autoComplete="current-password"
                style={{ ...s.input, borderBottom: `${passFocus ? 2 : 1.5}px solid ${passFocus ? '#5e4dbb' : '#E5E7EB'}`, paddingRight: 32 }}
                onFocus={() => setPassFocus(true)} onBlur={() => setPassFocus(false)} />
              <button type="button" onClick={() => setShowPw(v => !v)}
                style={{ position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#787584', fontFamily: 'Inter, sans-serif', fontSize: 11.5, fontWeight: 600 }}>
                {showPw ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
          {error && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a', marginTop: -8 }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -8 }}>
            <button type="button" style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#787584', background: 'none', border: 'none', cursor: 'pointer' }}>Forgot password?</button>
          </div>
          <button type="submit" disabled={loading}
            style={{ width: '100%', background: loading ? '#9d8dff' : '#5e4dbb', color: '#fff', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, padding: '12px 0', borderRadius: 10, border: 'none', cursor: loading ? 'wait' : 'pointer', transition: 'all 180ms', marginTop: 4 }}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
