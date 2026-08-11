import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from '@/components/animate-ui/motion';
import Icon from '../components/Icon';
import useAuthStore from '../store/useAuthStore';
import useAccountsStore from '../store/useAccountsStore';
import { apiLoginAdditional, api2FAVerifyAdditional } from '../api/client';
import { backdropVariants, modalVariants, crossFadeVariants } from '@/components/animate-ui/motionTokens';
import type { AuthUser } from '../types';

interface AddAccountModalProps {
  /** Pre-fill + lock the username when re-authenticating a specific stored
   *  account whose session expired (rather than adding a brand-new one). */
  presetUsername?: string;
  onClose: () => void;
  /** Fired after the new account has been signed in AND made active. */
  onAdded: () => void;
}

/**
 * Sign an ADDITIONAL account in while one is already active.
 *
 * This is a normal credential login against the very same `/auth/login`
 * endpoint the login screen uses — full password check, and the TOTP step when
 * that account has 2FA enabled. Being signed in as someone else grants no
 * shortcut here whatsoever: there is no API that mints a session for another
 * user, so an account can only ever join the switcher by proving its own
 * credentials. A wrong password fails locally without disturbing the session
 * that is already active (see `apiLoginAdditional`).
 */
export default function AddAccountModal({ presetUsername, onClose, onAdded }: AddAccountModalProps) {
  const [step, setStep] = useState<'creds' | 'otp'>('creds');
  const [username, setUsername] = useState(presetUsername ?? '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [pendingToken, setPendingToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const setAuthFromToken = useAuthStore((s) => s.setAuthFromToken);
  const switchToAccount = useAuthStore((s) => s.switchToAccount);
  const activeUserId = useAuthStore((s) => s.userId);
  const userInputRef = useRef<HTMLInputElement>(null);
  const pwInputRef = useRef<HTMLInputElement>(null);
  const otpInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Jump straight to the password when the username is already known.
    (presetUsername ? pwInputRef : userInputRef).current?.focus();
  }, [presetUsername]);

  useEffect(() => {
    if (step === 'otp') otpInputRef.current?.focus();
  }, [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Store the freshly authenticated session and make it the active one. */
  const activate = async (token: string, user: AuthUser) => {
    if (user.id === activeUserId) {
      // Re-authenticating the account we're already using: just refresh its
      // token in place, no store teardown needed.
      setAuthFromToken(token, user);
      onAdded();
      return;
    }
    // Record the new session, then go through the normal switch path so all
    // per-user state is torn down and the token is server-verified exactly as
    // it would be for any other switch.
    useAccountsStore.getState().remember({
      userId: user.id,
      username: user.username,
      fullName: user.fullName || '',
      email: user.email,
      profileImage: user.profileImage ?? null,
      isAdmin: user.isAdmin ?? false,
      token,
      addedAt: Date.now(),
    });
    await switchToAccount(user.id);
    onAdded();
  };

  const handleCreds = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) { setError('Please enter username and password.'); return; }
    setLoading(true);
    setError('');
    try {
      const data = await apiLoginAdditional(username.trim(), password);
      if (data.requires2FA && data.pendingToken) {
        setPendingToken(data.pendingToken);
        setCode('');
        setStep('otp');
      } else if (data.token && data.user) {
        await activate(data.token, data.user as AuthUser);
      } else {
        setError('Could not sign in. Please try again.');
      }
    } catch {
      setError('Invalid username or password.');
    } finally {
      setLoading(false);
    }
  };

  const handleOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.trim().length !== 6) { setError('Enter the 6-digit code.'); return; }
    setLoading(true);
    setError('');
    try {
      const data = await api2FAVerifyAdditional(pendingToken, code.trim());
      await activate(data.token, data.user as AuthUser);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.toLowerCase().includes('expired')) {
        setError('That took too long — please enter the password again.');
        setStep('creds');
        setPassword('');
      } else {
        setError('Invalid code. Please try again.');
        setCode('');
      }
    } finally {
      setLoading(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', fontFamily: 'var(--font-body)', fontSize: 13.5, padding: '10px 14px',
    borderRadius: 10, border: '1.5px solid var(--color-border)', outline: 'none',
    color: 'var(--color-text-primary)', background: 'var(--color-surface-neutral)', boxSizing: 'border-box',
  };
  const labelStyle: React.CSSProperties = {
    fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-tertiary)',
    textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6, display: 'block',
  };

  return createPortal(
    <motion.div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      variants={backdropVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.28)', backdropFilter: 'blur(5px)', zIndex: 1400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
    >
      <motion.div
        onClick={(e) => e.stopPropagation()}
        variants={modalVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        style={{ background: 'var(--color-white)', borderRadius: 20, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(var(--color-black-rgb), 0.18)', overflow: 'hidden' }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '20px 24px 0' }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name={step === 'otp' ? 'lock' : 'person_add'} size={19} color="var(--color-primary)" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 16, fontWeight: 700, color: 'var(--color-text-primary)' }}>
              {step === 'otp' ? 'Two-factor code' : presetUsername ? 'Sign in again' : 'Add account'}
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
              {step === 'otp'
                ? 'Enter the 6-digit code from your authenticator app.'
                : presetUsername
                  ? 'This session expired — sign in to keep switching to it.'
                  : 'Sign in to another account to switch between them.'}
            </div>
          </div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: '50%', border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name="close" size={17} color="var(--color-text-tertiary)" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={step === 'otp' ? handleOtp : handleCreds} style={{ padding: '18px 24px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <AnimatePresence mode="wait" initial={false}>
            {step === 'creds' ? (
              <motion.div key="creds" variants={crossFadeVariants} initial="initial" animate="animate" exit="exit" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <label style={labelStyle}>Username or email</label>
                  <input
                    ref={userInputRef}
                    value={username}
                    onChange={(e) => { setUsername(e.target.value); setError(''); }}
                    readOnly={!!presetUsername}
                    autoComplete="username"
                    style={{ ...inputStyle, opacity: presetUsername ? 0.7 : 1, cursor: presetUsername ? 'default' : 'text' }}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Password</label>
                  <input
                    ref={pwInputRef}
                    type="password"
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setError(''); }}
                    autoComplete="current-password"
                    style={inputStyle}
                  />
                </div>
              </motion.div>
            ) : (
              <motion.div key="otp" variants={crossFadeVariants} initial="initial" animate="animate" exit="exit">
                <label style={labelStyle}>Authentication code</label>
                <input
                  ref={otpInputRef}
                  value={code}
                  onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  style={{ ...inputStyle, letterSpacing: '0.4em', fontSize: 18, textAlign: 'center', fontFamily: 'var(--font-heading)', fontWeight: 700 }}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {error && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', background: 'var(--color-error-bg-alt)', borderRadius: 8, border: '1px solid var(--color-error-bg)' }}>
              <Icon name="error" size={15} color="var(--color-error)" />
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)' }}>{error}</span>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
            <button
              type="button"
              onClick={onClose}
              style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 10, padding: '11px 0', cursor: 'pointer' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: loading ? 'var(--color-border-strong)' : 'var(--color-primary)', border: 'none', borderRadius: 10, padding: '11px 0', cursor: loading ? 'wait' : 'pointer' }}
            >
              {loading ? 'Signing in…' : step === 'otp' ? 'Verify' : 'Sign in'}
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>,
    document.body
  );
}
