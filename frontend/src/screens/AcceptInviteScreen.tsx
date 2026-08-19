import { usePageTitle } from "../hooks/usePageTitle";
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import useAsyncData from '../hooks/useAsyncData';
import { apiCheckInvitation, apiAcceptInvitation } from '../api/client';
import Icon from '../components/Icon';
import MotionIn from '../components/animate-ui/MotionIn';
import MotionButton from '../components/animate-ui/MotionButton';
import { motion } from '../components/animate-ui/motion';
import NotFoundScreen from './NotFoundScreen';

// Same chrome as LoginScreen.tsx — this is the same class of public,
// unauthenticated "before you're a user" page.
const s: Record<string, CSSProperties> = {
  wrap:  { minHeight: '100vh', background: 'linear-gradient(135deg, var(--color-page-bg) 0%, var(--color-purple-pale-12) 100%)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, padding: 24 },
  card:  { width: '100%', maxWidth: 400, background: 'var(--color-white)', border: '1px solid var(--color-border-alt)', borderRadius: 12, padding: '40px 40px 36px', boxShadow: '0 1px 2px rgba(var(--color-black-rgb), 0.05)', display: 'flex', flexDirection: 'column', gap: 22 },
  title: { fontFamily: 'var(--font-heading)', fontSize: 26, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.02em', lineHeight: 1.2 },
  sub:   { fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-secondary)', lineHeight: 1.5 },
  label: { fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)' },
  input: { fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-primary)', background: 'transparent', border: 'none', borderBottomStyle: 'solid', padding: '8px 0', outline: 'none', width: '100%' },
};

const underline = (focused: boolean, invalid?: boolean) => ({
  borderBottomWidth: focused ? 2 : 1.5,
  borderBottomColor: invalid ? 'var(--color-error)' : focused ? 'var(--color-primary)' : 'var(--color-border-alt)',
});

function Chrome({ children }: { children: React.ReactNode }) {
  return (
    <div style={s.wrap}>
      <img src="/solytiq-cloud.png" alt="Solytiq Cloud" style={{ width: 80, height: 80, borderRadius: 20, objectFit: 'cover', boxShadow: '0 4px 20px rgba(var(--color-primary-rgb), 0.18)' }} />
      <MotionIn initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28 }} style={s.card}>
        {children}
      </MotionIn>
    </div>
  );
}

/**
 * The registration screen behind a one-time admin invitation link
 * (`/invite/:token`). Reachable ONLY via that link — there is no other way
 * to navigate here, and no self-service "Register" entry point anywhere
 * else in the app (see CLAUDE.md's Authentication section: the only other
 * account-creation path is the first-run Setup Wizard).
 *
 * SECURITY: an invalid, expired, revoked, or already-accepted token renders
 * the exact same NotFoundScreen as a URL that was never real — see
 * backend/src/userInvitations.ts's header comment for why that's a
 * requirement, not a UX nicety. This screen never renders a distinguishing
 * "this invite was already used" message.
 */
export default function AcceptInviteScreen() {
  usePageTitle('Join Solytiq Cloud');
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const { data: invite, loading, error } = useAsyncData(
    token ?? null,
    () => apiCheckInvitation(token as string),
    null as { email: string } | null
  );

  const [username, setUsername] = useState('');
  const [usernameFocus, setUsernameFocus] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordFocus, setPasswordFocus] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState('');
  const [confirmFocus, setConfirmFocus] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [touched, setTouched] = useState(false);
  const [done, setDone] = useState(false);

  if (!token || error) {
    return <NotFoundScreen />;
  }

  if (loading || !invite) {
    return (
      <Chrome>
        <div style={{ textAlign: 'center' }}>
          <div style={s.title}>Loading…</div>
        </div>
      </Chrome>
    );
  }

  if (done) {
    return (
      <Chrome>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 56, height: 56, borderRadius: 16, background: 'rgba(var(--color-success-rgb), 0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
            <Icon name="check" size={26} color="var(--color-success)" />
          </div>
          <div style={s.title}>You're all set!</div>
          <div style={{ ...s.sub, marginTop: 6 }}>Your account has been created. Sign in to get started.</div>
        </div>
        <MotionButton
          onClick={() => navigate('/login')}
          transition={{ duration: 0.18 }}
          style={{ width: '100%', background: 'var(--color-primary)', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, padding: '12px 0', borderRadius: 10, border: 'none', cursor: 'pointer' }}
        >
          Continue to Login
        </MotionButton>
      </Chrome>
    );
  }

  const passwordTooShort = password.length > 0 && password.length < 8;
  const passwordsMismatch = touched && confirmPassword.length > 0 && password !== confirmPassword;
  const canSubmit = username.trim().length > 0 && password.length >= 8 && password === confirmPassword;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!canSubmit || !token) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      await apiAcceptInvitation(token, { username: username.trim(), password });
      setDone(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setSubmitError(msg.includes('taken') ? 'That username is already taken — please pick another.' : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Chrome>
      <div style={{ textAlign: 'center' }}>
        <div style={s.title}>Join Solytiq Cloud</div>
        <div style={{ ...s.sub, marginTop: 6 }}>
          You've been invited as <strong>{invite.email}</strong>. Choose a username and password to finish setting up your account.
        </div>
      </div>
      <form style={{ display: 'flex', flexDirection: 'column', gap: 18 }} onSubmit={handleSubmit}>
        <MotionIn style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <motion.label htmlFor="invite-username" style={s.label}>Username</motion.label>
          <motion.input
            id="invite-username" type="text" value={username} onChange={e => setUsername(e.target.value)}
            placeholder="Choose a username…" autoFocus autoComplete="username"
            animate={underline(usernameFocus)} transition={{ duration: 0.2 }} style={s.input}
            onFocus={() => setUsernameFocus(true)} onBlur={() => setUsernameFocus(false)}
          />
        </MotionIn>
        <MotionIn style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <motion.label htmlFor="invite-password" style={s.label}>Password</motion.label>
          <MotionIn style={{ position: 'relative' }}>
            <motion.input
              id="invite-password" type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
              placeholder="••••••••" autoComplete="new-password"
              animate={underline(passwordFocus)} transition={{ duration: 0.2 }} style={{ ...s.input, paddingRight: 32 }}
              onFocus={() => setPasswordFocus(true)} onBlur={() => setPasswordFocus(false)}
            />
            <MotionButton type="button" onClick={() => setShowPw(v => !v)} aria-label={showPw ? 'Hide password' : 'Show password'} aria-pressed={showPw}
              style={{ position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-body)', fontSize: 11.5, fontWeight: 600 }}>
              {showPw ? 'Hide' : 'Show'}
            </MotionButton>
          </MotionIn>
          {passwordTooShort && <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>At least 8 characters required</div>}
        </MotionIn>
        <MotionIn style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <motion.label htmlFor="invite-confirm" style={s.label}>Confirm Password</motion.label>
          <motion.input
            id="invite-confirm" type={showPw ? 'text' : 'password'} value={confirmPassword}
            onChange={e => { setConfirmPassword(e.target.value); setTouched(true); }}
            placeholder="••••••••" autoComplete="new-password"
            animate={underline(confirmFocus, passwordsMismatch)} transition={{ duration: 0.2 }} style={s.input}
            onFocus={() => setConfirmFocus(true)} onBlur={() => { setConfirmFocus(false); setTouched(true); }}
          />
          {passwordsMismatch && <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-error)' }}>Passwords do not match</div>}
        </MotionIn>
        {submitError && <div role="alert" style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>{submitError}</div>}
        <MotionButton type="submit" disabled={submitting || !canSubmit}
          transition={{ duration: 0.18 }}
          style={{ width: '100%', background: submitting || !canSubmit ? 'var(--color-border-strong)' : 'var(--color-primary)', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, padding: '12px 0', borderRadius: 10, border: 'none', cursor: submitting || !canSubmit ? 'not-allowed' : 'pointer' }}>
          {submitting ? 'Creating account…' : 'Create Account'}
        </MotionButton>
      </form>
    </Chrome>
  );
}
