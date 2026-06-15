import { usePageTitle } from "../hooks/usePageTitle";
import { useState, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import useAuthStore from '../store/useAuthStore';
import { apiLogin, api2FAVerify } from '../api/client';
import Icon from '../components/Icon';

const s: Record<string, CSSProperties> = {
  wrap:  { minHeight: '100vh', background: 'linear-gradient(135deg, #fdf8ff 0%, #f5f0ff 100%)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, padding: 24 },
  card:  { width: '100%', maxWidth: 400, background: '#ffffff', border: '1px solid #E5E7EB', borderRadius: 12, padding: '40px 40px 36px', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', display: 'flex', flexDirection: 'column', gap: 28 },
  title: { fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 30, fontWeight: 700, color: '#1c1b22', letterSpacing: '-0.02em', lineHeight: 1.2 },
  sub:   { fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#787584', lineHeight: 1.5 },
  label: { fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 13, fontWeight: 600, color: '#484552' },
  input: { fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#1c1b22', background: 'transparent', border: 'none', padding: '8px 0', outline: 'none', width: '100%', transition: 'border-color 200ms' },
};

export default function LoginScreen() {
  usePageTitle("Login");
  const navigate = useNavigate();
  const location = useLocation();
  const { setAuthFromToken } = useAuthStore();

  // ── credentials step
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [userFocus, setUserFocus] = useState(false);
  const [passFocus, setPassFocus] = useState(false);

  // ── shared
  const [step, setStep] = useState<'creds' | 'otp'>('creds');
  const [pendingToken, setPendingToken] = useState('');
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);
  const [loading, setLoading] = useState(false);

  // ── OTP step — 6 boxes
  const [otp, setOtp] = useState(Array(6).fill(''));
  const r0 = useRef<HTMLInputElement>(null);
  const r1 = useRef<HTMLInputElement>(null);
  const r2 = useRef<HTMLInputElement>(null);
  const r3 = useRef<HTMLInputElement>(null);
  const r4 = useRef<HTMLInputElement>(null);
  const r5 = useRef<HTMLInputElement>(null);
  const otpRefs = [r0, r1, r2, r3, r4, r5];

  const triggerShake = () => {
    setShake(true);
    setTimeout(() => setShake(false), 600);
  };

  const handleOtpChange = (i: number, raw: string) => {
    const digit = raw.replace(/\D/g, '').slice(-1);
    setOtp(prev => { const next = [...prev]; next[i] = digit; return next; });
    if (digit && i < 5) otpRefs[i + 1].current?.focus();
  };

  const handleOtpKey = (i: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace') {
      if (!otp[i] && i > 0) {
        setOtp(prev => { const next = [...prev]; next[i - 1] = ''; return next; });
        otpRefs[i - 1].current?.focus();
      } else {
        setOtp(prev => { const next = [...prev]; next[i] = ''; return next; });
      }
    } else if (e.key === 'Enter') {
      const code = otp.join('');
      if (code.length === 6) handleVerify();
    }
  };

  const handleOtpPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const digits = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6).split('');
    const next = Array(6).fill('');
    digits.forEach((d, i) => { next[i] = d; });
    setOtp(next);
    const focusIdx = Math.min(digits.length, 5);
    otpRefs[focusIdx].current?.focus();
  };

  // ── submit creds
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) { setError('Please enter username and password.'); return; }
    setLoading(true);
    setError('');
    try {
      const data = await apiLogin(username.trim(), password);
      if (data.requires2FA && data.pendingToken) {
        setPendingToken(data.pendingToken);
        setOtp(Array(6).fill(''));
        setStep('otp');
        setTimeout(() => r0.current?.focus(), 80);
      } else if (data.token && data.user) {
        setAuthFromToken(data.token, data.user);
        const from = location.state?.from || '/';
        navigate(from);
      }
    } catch {
      setError('Invalid username or password.');
      triggerShake();
    } finally {
      setLoading(false);
    }
  };

  // ── submit OTP
  const handleVerify = async () => {
    const code = otp.join('');
    if (code.length !== 6) return;
    setLoading(true);
    setError('');
    try {
      const data = await api2FAVerify(pendingToken, code);
      setAuthFromToken(data.token, data.user);
      const from = location.state?.from || '/';
      navigate(from);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.toLowerCase().includes('expired')) {
        setError('Session expired — please log in again.');
        setTimeout(() => { setStep('creds'); setOtp(Array(6).fill('')); setError(''); }, 2000);
      } else {
        setError('Invalid code. Please try again.');
        setOtp(Array(6).fill(''));
        triggerShake();
        setTimeout(() => r0.current?.focus(), 80);
      }
    } finally {
      setLoading(false);
    }
  };

  const otpValue = otp.join('');
  const otpComplete = otpValue.length === 6 && otp.every(d => d !== '');

  return (
    <div style={s.wrap}>
      <img src="/solytiq-cloud.png" alt="Solytiq Cloud" style={{ width: 80, height: 80, borderRadius: 20, objectFit: 'cover', boxShadow: '0 4px 20px rgba(94,77,187,0.18)' }} />

      <div style={{ ...s.card, animation: shake ? 'shake 400ms ease-in-out' : undefined }}>

        {/* ── Step 1: credentials ── */}
        {step === 'creds' && (
          <>
            <div style={{ textAlign: 'center' }}>
              <div style={s.title}>Welcome Back</div>
              <div style={{ ...s.sub, marginTop: 6 }}>Sign in to continue.</div>
            </div>
            <form style={{ display: 'flex', flexDirection: 'column', gap: 20 }} onSubmit={handleSubmit}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={s.label}>Username</label>
                <input type="text" value={username} onChange={e => setUsername(e.target.value)}
                  placeholder="Enter your username…" autoFocus autoComplete="username"
                  style={{ ...s.input, borderBottom: `${userFocus ? 2 : 1.5}px solid ${userFocus ? '#5e4dbb' : '#E5E7EB'}` }}
                  onFocus={() => setUserFocus(true)} onBlur={() => setUserFocus(false)} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={s.label}>Password</label>
                <div style={{ position: 'relative' }}>
                  <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                    placeholder="••••••••" autoComplete="current-password"
                    style={{ ...s.input, borderBottom: `${passFocus ? 2 : 1.5}px solid ${passFocus ? '#5e4dbb' : '#E5E7EB'}`, paddingRight: 32 }}
                    onFocus={() => setPassFocus(true)} onBlur={() => setPassFocus(false)} />
                  <button type="button" onClick={() => setShowPw(v => !v)}
                    style={{ position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#787584', fontFamily: 'Inter, sans-serif', fontSize: 11.5, fontWeight: 600 }}>
                    {showPw ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>
              {error && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a', marginTop: -8 }}>{error}</div>}
              <button type="submit" disabled={loading}
                style={{ width: '100%', background: loading ? '#9d8dff' : '#5e4dbb', color: '#fff', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, padding: '12px 0', borderRadius: 10, border: 'none', cursor: loading ? 'wait' : 'pointer', transition: 'all 180ms', marginTop: 4 }}>
                {loading ? 'Signing in…' : 'Sign In'}
              </button>
            </form>
          </>
        )}

        {/* ── Step 2: OTP ── */}
        {step === 'otp' && (
          <>
            <div style={{ textAlign: 'center' }}>
              <div style={{ width: 56, height: 56, borderRadius: 16, background: 'linear-gradient(135deg, #F5F3FF 0%, #e8e3ff 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                <Icon name="shield_lock" size={26} color="#5e4dbb" />
              </div>
              <div style={s.title}>Two-Factor Auth</div>
              <div style={{ ...s.sub, marginTop: 6 }}>Enter the 6-digit code from your authenticator app.</div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
              {/* 6-box OTP input */}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                {otp.map((digit, i) => (
                  <input
                    key={i}
                    ref={otpRefs[i]}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    value={digit}
                    onChange={e => handleOtpChange(i, e.target.value)}
                    onKeyDown={e => handleOtpKey(i, e)}
                    onPaste={i === 0 ? handleOtpPaste : undefined}
                    style={{
                      width: 46, height: 56, textAlign: 'center',
                      fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 22, fontWeight: 700,
                      color: '#1c1b22', background: digit ? '#F5F3FF' : '#F9FAFB',
                      border: `2px solid ${digit ? '#5e4dbb' : '#E5E7EB'}`,
                      borderRadius: 10, outline: 'none', transition: 'border-color 150ms, background 150ms',
                      caretColor: 'transparent',
                    }}
                  />
                ))}
              </div>

              {error && <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#ba1a1a', textAlign: 'center', marginTop: -8 }}>{error}</div>}

              <button
                onClick={handleVerify}
                disabled={loading || !otpComplete}
                style={{ width: '100%', background: loading || !otpComplete ? '#c9c4d5' : '#5e4dbb', color: '#fff', fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, padding: '12px 0', borderRadius: 10, border: 'none', cursor: loading || !otpComplete ? 'not-allowed' : 'pointer', transition: 'all 180ms' }}>
                {loading ? 'Verifying…' : 'Verify'}
              </button>

              <button
                type="button"
                onClick={() => { setStep('creds'); setError(''); setOtp(Array(6).fill('')); }}
                style={{ background: 'none', border: 'none', fontFamily: 'Inter, sans-serif', fontSize: 13, color: '#787584', cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'transparent', transition: 'color 150ms' }}
                onMouseEnter={e => { e.currentTarget.style.color = '#5e4dbb'; }}
                onMouseLeave={e => { e.currentTarget.style.color = '#787584'; }}
              >
                ← Back to login
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
