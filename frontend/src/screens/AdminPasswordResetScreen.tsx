import { usePageTitle } from '../hooks/usePageTitle';
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiAdminPasswordResetRequest, apiAdminPasswordResetConfirm } from '../api/client';
import Icon from '../components/Icon';
import { motion } from '../components/animate-ui/motion';
import { EASE_SPRING } from '../components/animate-ui/motionTokens';
import MotionButton from '../components/animate-ui/MotionButton';
import MotionIn from '../components/animate-ui/MotionIn';

const s: Record<string, CSSProperties> = {
  wrap:  { minHeight: '100vh', background: 'linear-gradient(135deg, var(--color-page-bg) 0%, var(--color-purple-pale-12) 100%)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, padding: 24 },
  card:  { width: '100%', maxWidth: 420, background: 'var(--color-white)', border: '1px solid var(--color-border-alt)', borderRadius: 16, padding: '36px 40px 32px', boxShadow: '0 1px 2px rgba(var(--color-black-rgb), 0.05), 0 8px 32px rgba(var(--color-primary-rgb), 0.06)', display: 'flex', flexDirection: 'column', gap: 24 },
  title: { fontFamily: 'var(--font-heading)', fontSize: 24, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.015em', lineHeight: 1.2 },
  sub:   { fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--color-text-tertiary)', lineHeight: 1.55 },
  label: { fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-secondary)' },
  input: { fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-primary)', background: 'var(--color-purple-pale-4)', border: '1.5px solid var(--color-purple-pale-31)', borderRadius: 10, padding: '13px 16px', outline: 'none', width: '100%', boxSizing: 'border-box' },
  primaryBtn: { width: '100%', fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-primary)', border: 'none', borderRadius: 10, padding: '12px 0', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 },
};

function PasswordStrength({ password }: { password: string }) {
  const { score, label, color } = (() => {
    let sc = 0;
    if (password.length >= 8) sc++;
    if (password.length >= 12) sc++;
    if (/[A-Z]/.test(password) && /[a-z]/.test(password)) sc++;
    if (/\d/.test(password)) sc++;
    if (/[^A-Za-z0-9]/.test(password)) sc++;
    if (password.length === 0) return { score: 0, label: '', color: 'var(--color-purple-pale-39)' };
    if (sc <= 1) return { score: 1, label: 'Weak', color: 'var(--color-error)' };
    if (sc <= 3) return { score: 2, label: 'Medium', color: 'var(--color-warning-alt)' };
    return { score: sc <= 4 ? 3 : 4, label: sc <= 4 ? 'Strong' : 'Very Strong', color: 'var(--color-success)' };
  })();
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {[1,2,3,4].map(i => <MotionIn key={i} transition={{ duration: 0.22 }} style={{ flex: 1, height: 4, borderRadius: 9999, background: i <= score ? color : 'var(--color-purple-pale-39)', }} />)}
      </div>
      {label && <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color, marginTop: 6, fontWeight: 500 }}>{label}</div>}
    </div>
  );
}

type Step = 'request' | 'confirm' | 'done';

export default function AdminPasswordResetScreen() {
  usePageTitle('Reset Admin Password');
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('request');
  const [requesting, setRequesting] = useState(false);
  const [codeSent, setCodeSent] = useState(false);

  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const codeClean = code.replace(/-/g, '').toUpperCase();
  const codeValid = codeClean.length === 8 && /^[0-9A-F]{8}$/.test(codeClean);
  const passwordValid = password.length >= 8;
  const confirmValid = confirm === password && confirm.length > 0;
  const canSubmit = codeValid && passwordValid && confirmValid;

  const handleRequest = async () => {
    setRequesting(true);
    setError('');
    try {
      await apiAdminPasswordResetRequest();
      setCodeSent(true);
      setStep('confirm');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate reset code');
    } finally {
      setRequesting(false);
    }
  };

  const handleResend = async () => {
    setRequesting(true);
    setError('');
    try {
      await apiAdminPasswordResetRequest();
      setCodeSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to regenerate code');
    } finally {
      setRequesting(false);
    }
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError('');
    try {
      await apiAdminPasswordResetConfirm(codeClean, password);
      setStep('done');
      setTimeout(() => navigate('/login'), 2200);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed — check the code and try again');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={s.wrap}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <img src="/solytiq-cloud.png" alt="Solytiq Cloud" style={{ width: 64, height: 64, borderRadius: 16, objectFit: 'cover', boxShadow: '0 4px 20px rgba(var(--color-primary-rgb), 0.18)' }} />
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-primary)' }}>Solytiq Cloud · Admin Recovery</div>
      </div>

      <div style={s.card}>

        {/* ── Step: request code ── */}
        {step === 'request' && (
          <>
            <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
              <div style={{ width: 56, height: 56, borderRadius: 16, background: 'linear-gradient(135deg, var(--color-surface-tint) 0%, var(--color-purple-pale-30) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="lock_reset" size={26} color="var(--color-primary)" />
              </div>
              <div>
                <div style={s.title}>Reset Admin Password</div>
                <div style={{ ...s.sub, marginTop: 8 }}>
                  A one-time reset code will be printed to the backend server logs.<br />
                  You'll need access to those logs to continue.
                </div>
              </div>
            </div>

            <div style={{ background: 'var(--color-purple-pale-5)', border: '1.5px solid var(--color-purple-pale-30)', borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                ['terminal', 'Code is printed to backend/Docker logs'],
                ['schedule', 'Valid for 15 minutes after generation'],
                ['person', "Resets the first admin account's password"],
              ].map(([icon, text]) => (
                <div key={text} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Icon name={icon} size={15} color="var(--color-primary)" />
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-secondary)' }}>{text}</span>
                </div>
              ))}
            </div>

            {error && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)', textAlign: 'center' }}>{error}</div>}

            <MotionButton
              onClick={handleRequest}
              disabled={requesting}
              animate={{ background: requesting ? 'var(--color-accent-purple-light)' : 'var(--color-primary)' }} transition={{ duration: 0.18 }} style={{ ...s.primaryBtn, cursor: requesting ? 'wait' : 'pointer' }}
            >
              <Icon name="terminal" size={16} color="var(--color-white)" />
              {requesting ? 'Generating…' : 'Generate Reset Code'}
            </MotionButton>

            <MotionButton
              type="button"
              onClick={() => navigate('/login')}
              style={{ background: 'none', border: 'none', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', cursor: 'pointer', textAlign: 'center' }}
              whileHover={{ color: 'var(--color-primary)' }}
              transition={{ duration: 0.15 }}
            >
              ← Back to login
            </MotionButton>
          </>
        )}

        {/* ── Step: enter code + new password ── */}
        {step === 'confirm' && (
          <>
            <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
              <div style={{ width: 56, height: 56, borderRadius: 16, background: 'linear-gradient(135deg, var(--color-surface-tint) 0%, var(--color-purple-pale-30) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="key" size={26} color="var(--color-primary)" />
              </div>
              <div>
                <div style={s.title}>Enter Reset Code</div>
                <div style={{ ...s.sub, marginTop: 8 }}>
                  Check your backend logs for the 8-character code,<br />then set a new password below.
                </div>
              </div>
            </div>

            {/* "Code printed" confirmation pill */}
            {codeSent && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(var(--color-success-rgb), 0.08)', border: '1.5px solid rgba(var(--color-success-rgb), 0.25)', borderRadius: 10, padding: '10px 14px' }}>
                <Icon name="check_circle" size={16} color="var(--color-success)" />
                <span style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-success)', fontWeight: 500 }}>Reset code printed to backend logs</span>
              </div>
            )}

            <form onSubmit={handleConfirm} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Reset code field */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <label style={s.label}>Reset Code</label>
                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={requesting}
                    style={{ background: 'none', border: 'none', fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 600, color: 'var(--color-primary)', cursor: requesting ? 'wait' : 'pointer', padding: 0 }}
                  >
                    {requesting ? 'Regenerating…' : 'Regenerate'}
                  </button>
                </div>
                <motion.input
                  autoFocus
                  type="text"
                  value={code}
                  onChange={e => { setCode(e.target.value.toUpperCase()); setError(''); }}
                  placeholder="XXXX-XXXX"
                  maxLength={9}
                  animate={{ borderColor: code && !codeValid ? 'var(--color-error)' : 'var(--color-purple-pale-31)' }} transition={{ duration: 0.18 }} style={{ ...s.input, fontFamily: 'var(--font-heading)', fontSize: 18, fontWeight: 700, letterSpacing: '0.12em', textAlign: 'center'  }}
                />
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                  8-character code from backend logs (e.g. A3F2-B1C8)
                </div>
              </div>

              {/* New password */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <label style={s.label}>New Password</label>
                  <button type="button" onClick={() => setShowPw(v => !v)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 600, color: 'var(--color-primary)', padding: 0 }}>{showPw ? 'Hide' : 'Show'}</button>
                </div>
                <motion.input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => { setPassword(e.target.value); setError(''); }}
                  placeholder="••••••••"
                  animate={{ borderColor: password && !passwordValid ? 'var(--color-error)' : 'var(--color-purple-pale-31)' }} transition={{ duration: 0.18 }} style={{ ...s.input  }}
                />
                <PasswordStrength password={password} />
              </div>

              {/* Confirm password */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={s.label}>Confirm Password</label>
                <motion.input
                  type={showPw ? 'text' : 'password'}
                  value={confirm}
                  onChange={e => { setConfirm(e.target.value); setError(''); }}
                  placeholder="••••••••"
                  animate={{ borderColor: confirm && !confirmValid ? 'var(--color-error)' : 'var(--color-purple-pale-31)' }} transition={{ duration: 0.18 }} style={{ ...s.input  }}
                />
                {confirm && !confirmValid && (
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>Passwords don't match.</div>
                )}
              </div>

              {error && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>{error}</div>}

              <MotionButton
                type="submit"
                disabled={!canSubmit || loading}
                animate={{ background: !canSubmit || loading ? 'var(--color-border-strong)' : 'var(--color-primary)' }} transition={{ duration: 0.18 }} style={{ ...s.primaryBtn, cursor: !canSubmit || loading ? 'not-allowed' : 'pointer', marginTop: 4 }}
              >
                {loading ? 'Resetting…' : 'Reset Password'}
                {!loading && canSubmit && <Icon name="arrow_forward" size={14} color="var(--color-white)" />}
              </MotionButton>
            </form>

            <MotionButton
              type="button"
              onClick={() => { setStep('request'); setCodeSent(false); setError(''); }}
              style={{ background: 'none', border: 'none', fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', cursor: 'pointer', textAlign: 'center' }}
              whileHover={{ color: 'var(--color-primary)' }}
              transition={{ duration: 0.15 }}
            >
              ← Back
            </MotionButton>
          </>
        )}

        {/* ── Step: done ── */}
        {step === 'done' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, padding: '12px 0' }}>
            <MotionIn style={{ width: 80, height: 80, borderRadius: '50%', background: 'rgba(var(--color-success-rgb), 0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: [0, 1.1, 1], opacity: [0, 1, 1] }}
              transition={{ duration: 0.4, times: [0, 0.6, 1], ease: EASE_SPRING }}>
              <svg width="36" height="28" viewBox="0 0 36 28">
                <motion.path d="M3 14 L14 25 L33 4" stroke="var(--color-success)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" fill="none"
                  initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.5, delay: 0.28, ease: [0.65, 0, 0.35, 1] }} />
              </svg>
            </MotionIn>
            <div style={{ textAlign: 'center' }}>
              <div style={{ ...s.title, fontSize: 22 }}>Password Reset!</div>
              <div style={{ ...s.sub, marginTop: 8 }}>Your admin password has been updated.<br />Taking you to login…</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
