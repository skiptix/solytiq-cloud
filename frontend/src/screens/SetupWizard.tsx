import { usePageTitle } from "../hooks/usePageTitle";
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import useAuthStore from '../store/useAuthStore';
import Icon from '../components/Icon';
import { apiRequestSetupToken } from '../api/client';

const w: Record<string, CSSProperties> = {
  wrap: { minHeight: '100vh', background: 'linear-gradient(135deg, var(--color-page-bg) 0%, var(--color-purple-pale-12) 100%)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, padding: 24 },
  card: { width: '100%', maxWidth: 460, background: 'var(--color-white)', border: '1px solid var(--color-border-alt)', borderRadius: 16, padding: '32px 36px 28px', boxShadow: '0 1px 2px rgba(var(--color-black-rgb), 0.05), 0 8px 32px rgba(var(--color-primary-rgb), 0.06)', display: 'flex', flexDirection: 'column', gap: 24 },
  title: { fontFamily: 'var(--font-heading)', fontSize: 24, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.015em', lineHeight: 1.2 },
  // Sprint 03, test:a11y finding: --color-text-tertiary (#787584) on white is
  // 4.49:1, just under WCAG AA's 4.5:1 minimum for normal-size text at
  // 13.5px. --color-text-secondary (#484552, 9.34:1) is an EXISTING Solytiq
  // token, not a new color — swapping which established token this one
  // subtitle line uses is a contrast fix, not a redesign. (This app-wide
  // token is used very broadly for tertiary/secondary copy; a full sweep of
  // every use site is out of Sprint 03's "no visual relaunch" scope — see
  // the Sprint 03 handoff.)
  sub: { fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-secondary)', lineHeight: 1.55 },
  label: { fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-secondary)' },
  input: { fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-primary)', background: 'var(--color-purple-pale-4)', border: '1.5px solid var(--color-purple-pale-31)', borderRadius: 10, padding: '13px 16px', outline: 'none', width: '100%', transition: 'all 180ms' },
  primaryBtn: { width: '100%', fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-primary)', border: 'none', borderRadius: 10, padding: '12px 0', cursor: 'pointer', transition: 'all 180ms', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 },
};

function ProgressDots({ step }: { step: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
      {[0, 1, 2, 3, 4].map(i => (
        <div key={i} style={{ height: 4, borderRadius: 9999, background: step > i ? 'var(--color-accent-purple-light)' : step === i ? 'var(--color-primary)' : 'var(--color-purple-pale-39)', width: step === i ? 32 : 12, transition: 'all 300ms ease' }} />
      ))}
    </div>
  );
}

function PasswordStrength({ password }: { password: string }) {
  const { score, label, color } = (() => {
    let s = 0;
    if (password.length >= 8) s++;
    if (password.length >= 12) s++;
    if (/[A-Z]/.test(password) && /[a-z]/.test(password)) s++;
    if (/\d/.test(password)) s++;
    if (/[^A-Za-z0-9]/.test(password)) s++;
    if (password.length === 0) return { score: 0, label: '', color: 'var(--color-purple-pale-39)' };
    if (s <= 1) return { score: 1, label: 'Weak', color: 'var(--color-error)' };
    if (s <= 3) return { score: 2, label: 'Medium', color: 'var(--color-warning-alt)' };
    return { score: s <= 4 ? 3 : 4, label: s <= 4 ? 'Strong' : 'Very Strong', color: 'var(--color-success)' };
  })();
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {[1,2,3,4].map(i => <div key={i} style={{ flex: 1, height: 4, borderRadius: 9999, background: i <= score ? color : 'var(--color-purple-pale-39)', transition: 'background 220ms' }} />)}
      </div>
      {label && <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color, marginTop: 6, fontWeight: 500 }}>{label}</div>}
    </div>
  );
}

export default function SetupWizard() {
  usePageTitle("Setup");
  const navigate = useNavigate();
  const { register } = useAuthStore();
  const [step, setStep] = useState(0);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tokenRequesting, setTokenRequesting] = useState(false);
  const [tokenRequested, setTokenRequested] = useState(false);

  const usernameValid = /^[A-Za-z0-9_]{3,20}$/.test(username);
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const passwordValid = password.length >= 8;
  const confirmValid = confirm === password && confirm.length > 0;
  const setupTokenValid = setupToken.length >= 8;

  const stepValid =
    step === 0 ? true :
    step === 1 ? usernameValid :
    step === 2 ? emailValid :
    step === 3 ? (passwordValid && confirmValid) :
    setupTokenValid;

  const goNext = async () => {
    if (!stepValid) return;
    setError('');
    if (step === 4) {
      setLoading(true);
      try {
        await register({ username, email, password, setupToken });
        setStep(5);
        setTimeout(() => navigate('/dashboard'), 1600);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Registration failed');
      } finally {
        setLoading(false);
      }
      return;
    }
    setStep(s => s + 1);
  };

  const requestToken = async () => {
    setTokenRequesting(true);
    setTokenRequested(false);
    try {
      await apiRequestSetupToken();
      setTokenRequested(true);
    } catch {
      // Token is shown in backend logs; any error is non-critical here.
    } finally {
      setTokenRequesting(false);
    }
  };

  const fieldGroup = (children: React.ReactNode) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
  );

  const stepContent = () => {
    if (step === 0) return (
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '12px 14px', alignItems: 'center' }}>
        {[['person', 'Pick a username'], ['mail', 'Add your email'], ['lock', 'Choose a secure password']].map(([icon, text]) => (
          <>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={icon} size={16} color="var(--color-primary)" />
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-primary)' }}>{text}</div>
          </>
        ))}
      </div>
    );
    if (step === 1) return fieldGroup(<>
      <label style={w.label}>Username</label>
      <div style={{ position: 'relative' }}>
        <span style={{ position: 'absolute', left: 16, top: '50%', transform: 'translateY(-50%)', fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-quaternary)', pointerEvents: 'none' }}>@</span>
        <input autoFocus value={username} onChange={e => setUsername(e.target.value)} onKeyDown={e => e.key === 'Enter' && goNext()} placeholder="alex_admin"
          style={{ ...w.input, paddingLeft: 40, borderColor: username && !usernameValid ? 'var(--color-error)' : 'var(--color-purple-pale-31)' }} />
      </div>
      <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: username && !usernameValid ? 'var(--color-error)' : 'var(--color-text-tertiary)' }}>3–20 characters · letters, numbers, underscores</div>
    </>);
    if (step === 2) return fieldGroup(<>
      <label style={w.label}>Email</label>
      <input autoFocus type="email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && goNext()} placeholder="you@example.com"
        style={{ ...w.input, borderColor: email && !emailValid ? 'var(--color-error)' : 'var(--color-purple-pale-31)' }} />
      {email && !emailValid && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>Enter a valid email address.</div>}
    </>);
    if (step === 3) return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {fieldGroup(<>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <label style={w.label}>Password</label>
            <button type="button" onClick={() => setShowPw(v => !v)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 600, color: 'var(--color-primary)' }}>{showPw ? 'Hide' : 'Show'}</button>
          </div>
          <input autoFocus type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••"
            style={{ ...w.input, borderColor: password && !passwordValid ? 'var(--color-error)' : 'var(--color-purple-pale-31)' }} />
          <PasswordStrength password={password} />
        </>)}
        {fieldGroup(<>
          <label style={w.label}>Confirm Password</label>
          <input type={showPw ? 'text' : 'password'} value={confirm} onChange={e => setConfirm(e.target.value)} onKeyDown={e => e.key === 'Enter' && goNext()} placeholder="••••••••"
            style={{ ...w.input, borderColor: confirm && !confirmValid ? 'var(--color-error)' : 'var(--color-purple-pale-31)' }} />
          {confirm && !confirmValid && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>Passwords don't match.</div>}
        </>)}
      </div>
    );
    if (step === 4) return fieldGroup(<>
      <label style={w.label}>Setup Token</label>
      <input autoFocus type="password" value={setupToken} onChange={e => setSetupToken(e.target.value)} onKeyDown={e => e.key === 'Enter' && goNext()} placeholder="Paste token from backend logs"
        style={{ ...w.input, borderColor: setupToken && !setupTokenValid ? 'var(--color-error)' : 'var(--color-purple-pale-31)' }} />
      <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: setupToken && !setupTokenValid ? 'var(--color-error)' : 'var(--color-text-tertiary)' }}>
        The token is printed in the backend container logs on startup.
      </div>
      <button
        type="button"
        onClick={requestToken}
        disabled={tokenRequesting}
        style={{ marginTop: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: tokenRequested ? 'var(--color-success)' : 'var(--color-primary)', background: tokenRequested ? 'rgba(var(--color-success-rgb), 0.08)' : 'rgba(var(--color-primary-rgb), 0.07)', border: `1.5px solid ${tokenRequested ? 'rgba(var(--color-success-rgb), 0.3)' : 'rgba(var(--color-primary-rgb), 0.2)'}`, borderRadius: 10, padding: '10px 0', cursor: tokenRequesting ? 'wait' : 'pointer', transition: 'all 180ms' }}
      >
        <Icon name={tokenRequested ? 'check_circle' : 'terminal'} size={15} color={tokenRequested ? 'var(--color-success)' : 'var(--color-primary)'} />
        {tokenRequesting ? 'Requesting…' : tokenRequested ? 'Token printed to backend logs' : 'Show token in backend logs'}
      </button>
    </>);
    if (step === 5) return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, padding: '20px 0' }}>
        <style>{`@keyframes scIn{0%{transform:scale(0);opacity:0}60%{transform:scale(1.1);opacity:1}100%{transform:scale(1);opacity:1}} @keyframes scDraw{from{stroke-dashoffset:40}to{stroke-dashoffset:0}}`}</style>
        <div style={{ width: 80, height: 80, borderRadius: '50%', background: 'rgba(var(--color-success-rgb), 0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'scIn 420ms cubic-bezier(0.34,1.56,0.64,1) both' }}>
          <svg width="36" height="28" viewBox="0 0 36 28">
            <path d="M3 14 L14 25 L33 4" stroke="var(--color-success)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" fill="none"
              strokeDasharray="40" strokeDashoffset="40" style={{ animation: 'scDraw 500ms 280ms cubic-bezier(0.65,0,0.35,1) forwards' }} />
          </svg>
        </div>
      </div>
    );
    return null;
  };

  const titleText = ['Welcome to Solytiq Cloud', 'Pick a username', 'Your email address', 'Set a password', 'Security Verification', `All set, @${username}!`][step];
  const subText = ["Let's set up your admin account. This takes less than a minute.", "This is how you'll be identified inside Solytiq Cloud.", "We'll use this for account recovery and notifications.", 'Keep your admin account secure. Use at least 8 characters.', 'Verify your identity using the initial setup token.', 'Your admin account is ready. Taking you to your dashboard…'][step];

  return (
    <div style={w.wrap}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <img src="/solytiq-cloud.png" alt="Solytiq Cloud" style={{ width: 64, height: 64, borderRadius: 16, objectFit: 'cover', boxShadow: '0 4px 20px rgba(var(--color-primary-rgb), 0.18)' }} />
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-primary)' }}>Solytiq Cloud · Admin Setup</div>
      </div>

      <div style={w.card}>
        <ProgressDots step={step} />
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={w.title}>{titleText}</div>
          <div style={w.sub}>{subText}</div>
        </div>
        {stepContent()}
        {error && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)', textAlign: 'center' }}>{error}</div>}
        {step !== 5 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: step === 0 ? 'center' : 'space-between' }}>
            {step > 0 && (
              <button onClick={() => setStep(s => s - 1)}
                style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'transparent', border: 'none', padding: '10px 6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Icon name="chevron_left" size={14} color="var(--color-text-secondary)" /> Back
              </button>
            )}
            <button onClick={goNext} disabled={!stepValid || loading}
              style={{ ...w.primaryBtn, background: !stepValid || loading ? 'var(--color-border-strong)' : 'var(--color-primary)', cursor: !stepValid || loading ? 'not-allowed' : 'pointer', flex: step === 0 ? '0 1 auto' : 1, padding: step === 0 ? '12px 32px' : '12px 0' }}>
              {loading ? 'Creating account…' : step === 0 ? 'Get Started' : step === 4 ? 'Create Account' : 'Continue'}
              {!loading && stepValid && <Icon name="arrow_forward" size={14} color="var(--color-white)" />}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
