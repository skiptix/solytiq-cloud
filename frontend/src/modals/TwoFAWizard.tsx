import { useState, useRef, useEffect } from 'react';
import Icon from '../components/Icon';
import { api2FASetup, api2FAEnable } from '../api/client';
import ModalIn from '../components/animate-ui/ModalIn';
import MotionButton from '../components/animate-ui/MotionButton';
import MotionIn from '../components/animate-ui/MotionIn';
import { motion } from '../components/animate-ui/motion';
import { EASE_SPRING } from '../components/animate-ui/motionTokens';

interface TwoFAWizardProps {
  onClose: () => void;
  onEnabled: () => void;
}

export default function TwoFAWizard({ onClose, onEnabled }: TwoFAWizardProps) {
  const [step, setStep] = useState<'intro' | 'scan' | 'verify' | 'done'>('intro');
  const [qrCode, setQrCode] = useState('');
  const [secret, setSecret] = useState('');
  const [loadingSetup, setLoadingSetup] = useState(false);
  // Step-up (S3): the account password, collected on the intro step and sent
  // once to POST /2fa/setup — a valid-but-stolen session token alone must not
  // be enough to silently (re)generate a user's TOTP secret.
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [otp, setOtp] = useState(Array(6).fill(''));
  const [otpError, setOtpError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [shake, setShake] = useState(false);

  const r0 = useRef<HTMLInputElement>(null);
  const r1 = useRef<HTMLInputElement>(null);
  const r2 = useRef<HTMLInputElement>(null);
  const r3 = useRef<HTMLInputElement>(null);
  const r4 = useRef<HTMLInputElement>(null);
  const r5 = useRef<HTMLInputElement>(null);
  const otpRefs = [r0, r1, r2, r3, r4, r5];

  const otpComplete = otp.every(d => d !== '');

  // Fetch QR code when transitioning to scan step
  useEffect(() => {
    if (step !== 'scan' || qrCode) return;
    setLoadingSetup(true);
    api2FASetup(password)
      .then(data => { setQrCode(data.qrCode); setSecret(data.secret); })
      .catch(() => setOtpError('Failed to generate QR code. Please try again.'))
      .finally(() => setLoadingSetup(false));
  }, [step, password, qrCode]);

  // Auto-close after success
  useEffect(() => {
    if (step !== 'done') return;
    const t = setTimeout(() => { onEnabled(); onClose(); }, 1600);
    return () => clearTimeout(t);
  }, [step]);

  const triggerShake = () => { setShake(true); setTimeout(() => setShake(false), 500); };

  const handleOtpChange = (i: number, raw: string) => {
    const digit = raw.replace(/\D/g, '').slice(-1);
    setOtp(prev => { const next = [...prev]; next[i] = digit; return next; });
    setOtpError('');
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
    } else if (e.key === 'Enter' && otpComplete) {
      handleVerify();
    }
  };

  const handleOtpPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const digits = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6).split('');
    const next = Array(6).fill('');
    digits.forEach((d, i) => { next[i] = d; });
    setOtp(next);
    otpRefs[Math.min(digits.length, 5)].current?.focus();
  };

  const copySecret = () => {
    navigator.clipboard.writeText(secret).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleVerify = async () => {
    const code = otp.join('');
    if (code.length !== 6) return;
    setVerifying(true);
    setOtpError('');
    try {
      await api2FAEnable(code);
      setStep('done');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      setOtpError(msg.includes('Invalid') ? 'Invalid code — please try again.' : 'Something went wrong. Please try again.');
      setOtp(Array(6).fill(''));
      triggerShake();
      setTimeout(() => r0.current?.focus(), 80);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.22)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      onClick={e => { if (e.target === e.currentTarget && step !== 'done') onClose(); }}
    >
      <ModalIn
        duration={280}
        style={{ background: 'var(--color-white)', borderRadius: 20, width: '100%', maxWidth: 420, boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}
      >

        {/* ── INTRO ── */}
        {step === 'intro' && (
          <div style={{ padding: '36px 32px 32px', display: 'flex', flexDirection: 'column', gap: 0 }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
              <MotionButton onClick={onClose}
                whileHover={{ background: 'var(--color-surface-tint-2)' }}
                transition={{ duration: 0.15 }}
                style={{ width: 32, height: 32, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-quaternary)' }}>
                <Icon name="close" size={18} color="var(--color-text-quaternary)" />
              </MotionButton>
            </div>

            {/* Icon */}
            <div style={{ width: 64, height: 64, borderRadius: 20, background: 'linear-gradient(135deg, var(--color-surface-tint) 0%, var(--color-purple-pale-38) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
              <Icon name="shield_lock" size={30} color="var(--color-primary)" />
            </div>

            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.02em', marginBottom: 8 }}>
              Enable Two-Factor Auth
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-tertiary)', lineHeight: 1.6, marginBottom: 28 }}>
              Add an extra layer of security to your account. Each time you log in, you'll enter a one-time code from your authenticator app in addition to your password.
            </div>

            {/* What you need */}
            <div style={{ background: 'var(--color-surface-gray)', borderRadius: 12, padding: '14px 16px', marginBottom: 28, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: 'var(--color-text-quaternary)', marginBottom: 2 }}>You'll need</div>
              {[
                { icon: 'smartphone', text: 'An authenticator app (Google Authenticator, Authy, 1Password, Bitwarden…)' },
                { icon: 'qr_code_scanner', text: 'A few seconds to scan a QR code' },
              ].map(item => (
                <div key={item.icon} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
                    <Icon name={item.icon} size={14} color="var(--color-primary)" />
                  </div>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5, paddingTop: 5 }}>{item.text}</div>
                </div>
              ))}
            </div>

            <div style={{ position: 'relative', marginBottom: 16 }}>
              <input
                type={passwordVisible ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && password) setStep('scan'); }}
                placeholder="Confirm your password to continue"
                style={{ width: '100%', boxSizing: 'border-box' as const, padding: '11px 32px 11px 12px', borderRadius: 10, border: '1.5px solid var(--color-border-alt)', fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-primary)', background: 'var(--color-surface-gray)', outline: 'none' }}
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setPasswordVisible(v => !v)}
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex' }}
              >
                <Icon name={passwordVisible ? 'visibility_off' : 'visibility'} size={16} color="var(--color-text-quaternary)" />
              </button>
            </div>
            <MotionButton
              onClick={() => setStep('scan')}
              disabled={!password}
              animate={{ background: password ? 'var(--color-primary)' : 'var(--color-border-strong)' }}
              whileHover={password ? { background: 'var(--color-purple-mid-10)' } : undefined}
              transition={{ duration: 0.15 }}
              style={{ width: '100%', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, padding: '13px 0', borderRadius: 12, border: 'none', cursor: password ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
            >
              Get Started
              <Icon name="arrow_forward" size={16} color="var(--color-white)" />
            </MotionButton>
          </div>
        )}

        {/* ── SCAN QR ── */}
        {step === 'scan' && (
          <div style={{ padding: '28px 32px 32px', display: 'flex', flexDirection: 'column', gap: 0 }}>
            {/* Progress dots */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {['scan', 'verify'].map((s, i) => (
                  <motion.div key={s}
                    animate={{ width: i === 0 ? 20 : 8, background: i === 0 ? 'var(--color-primary)' : 'var(--color-border)' }}
                    transition={{ duration: 0.3 }}
                    style={{ height: 8, borderRadius: 4 }} />
                ))}
              </div>
              <MotionButton onClick={onClose}
                whileHover={{ background: 'var(--color-surface-tint-2)' }}
                transition={{ duration: 0.15 }}
                style={{ width: 32, height: 32, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="close" size={18} color="var(--color-text-quaternary)" />
              </MotionButton>
            </div>

            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.01em', marginBottom: 6 }}>
              Scan the QR code
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginBottom: 24 }}>
              Open your authenticator app and scan this code. Or enter the setup key manually.
            </div>

            {/* QR code */}
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
              {loadingSetup ? (
                <div style={{ width: 180, height: 180, background: 'var(--color-surface-gray)', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--color-border-alt)' }}>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-quaternary)' }}>Generating…</div>
                </div>
              ) : qrCode ? (
                <div style={{ padding: 12, background: 'var(--color-white)', border: '1.5px solid var(--color-border)', borderRadius: 14, boxShadow: '0 2px 12px rgba(var(--color-primary-rgb), 0.08)' }}>
                  <img src={qrCode} alt="2FA QR Code" style={{ width: 164, height: 164, display: 'block', borderRadius: 4 }} />
                </div>
              ) : (
                <div style={{ width: 180, height: 180, background: 'var(--color-error-bg-alt)', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--color-error-bg)' }}>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-error)', textAlign: 'center', padding: '0 12px' }}>Failed to load QR code</div>
                </div>
              )}
            </div>

            {/* Manual key */}
            {secret && (
              <div style={{ background: 'var(--color-surface-gray)', border: '1px solid var(--color-border-alt)', borderRadius: 10, padding: '10px 12px', marginBottom: 24, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.06em', color: 'var(--color-text-quaternary)', marginBottom: 3 }}>Setup key</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-text-primary)', letterSpacing: '0.1em', wordBreak: 'break-all' as const }}>
                    {secret.match(/.{1,4}/g)?.join(' ')}
                  </div>
                </div>
                <MotionButton
                  onClick={copySecret}
                  title="Copy setup key"
                  animate={{ background: copied ? 'rgba(var(--color-success-rgb), 0.1)' : 'transparent' }}
                  whileHover={!copied ? { background: 'var(--color-surface-tint)' } : undefined}
                  transition={{ duration: 0.15 }}
                  style={{ flexShrink: 0, width: 32, height: 32, borderRadius: 8, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  <Icon name={copied ? 'check' : 'content_copy'} size={15} color={copied ? 'var(--color-success)' : 'var(--color-text-tertiary)'} />
                </MotionButton>
              </div>
            )}

            <MotionButton
              onClick={() => { setStep('verify'); setTimeout(() => r0.current?.focus(), 80); }}
              disabled={loadingSetup || !qrCode}
              animate={{ background: loadingSetup || !qrCode ? 'var(--color-border-strong)' : 'var(--color-primary)' }}
              whileHover={!loadingSetup && qrCode ? { background: 'var(--color-purple-mid-10)' } : undefined}
              transition={{ duration: 0.15 }}
              style={{ width: '100%', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, padding: '13px 0', borderRadius: 12, border: 'none', cursor: loadingSetup || !qrCode ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
            >
              I've scanned it
              <Icon name="arrow_forward" size={16} color="var(--color-white)" />
            </MotionButton>
          </div>
        )}

        {/* ── VERIFY ── */}
        {step === 'verify' && (
          <div style={{ padding: '28px 32px 32px', display: 'flex', flexDirection: 'column', gap: 0 }}>
            {/* Progress dots */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {['scan', 'verify'].map((s, i) => (
                  <motion.div key={s}
                    animate={{ width: i === 1 ? 20 : 8, background: i === 1 ? 'var(--color-primary)' : 'var(--color-border)' }}
                    transition={{ duration: 0.3 }}
                    style={{ height: 8, borderRadius: 4 }} />
                ))}
              </div>
              <MotionButton onClick={onClose}
                whileHover={{ background: 'var(--color-surface-tint-2)' }}
                transition={{ duration: 0.15 }}
                style={{ width: 32, height: 32, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="close" size={18} color="var(--color-text-quaternary)" />
              </MotionButton>
            </div>

            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.01em', marginBottom: 6 }}>
              Confirm setup
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginBottom: 28 }}>
              Enter the 6-digit code from your authenticator app to confirm setup.
            </div>

            {/* 6-box OTP */}
            <motion.div
              animate={shake ? { x: [0, -8, 8, -6, 6, -3, 3, 0] } : { x: 0 }}
              transition={{ duration: 0.4, ease: 'easeInOut' }}
              style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 8 }}>
              {otp.map((digit, i) => (
                <motion.input
                  key={i}
                  ref={otpRefs[i]}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={digit}
                  onChange={e => handleOtpChange(i, e.target.value)}
                  onKeyDown={e => handleOtpKey(i, e)}
                  onPaste={i === 0 ? handleOtpPaste : undefined}
                  animate={{
                    background: digit ? 'var(--color-surface-tint)' : 'var(--color-surface-gray)',
                    borderColor: otpError ? 'var(--color-error-bg)' : digit ? 'var(--color-primary)' : 'var(--color-border-alt)',
                  }}
                  transition={{ duration: 0.15 }}
                  style={{
                    width: 46, height: 56, textAlign: 'center',
                    fontFamily: 'var(--font-heading)', fontSize: 22, fontWeight: 700,
                    color: 'var(--color-text-primary)',
                    borderWidth: 2, borderStyle: 'solid',
                    borderRadius: 10, outline: 'none',
                    caretColor: 'transparent',
                  }}
                />
              ))}
            </motion.div>

            {otpError && (
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)', textAlign: 'center', marginBottom: 16, marginTop: 4 }}>{otpError}</div>
            )}
            {!otpError && <div style={{ height: 20, marginBottom: 16 }} />}

            <div style={{ display: 'flex', gap: 10 }}>
              <MotionButton
                onClick={() => { setStep('scan'); setOtp(Array(6).fill('')); setOtpError(''); }}
                whileHover={{ background: 'var(--color-surface-tint-2)' }}
                transition={{ duration: 0.15 }}
                style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)', background: 'var(--color-surface-gray)', border: '1.5px solid var(--color-border-alt)', borderRadius: 12, padding: '12px 0', cursor: 'pointer' }}
              >
                ← Back
              </MotionButton>
              <MotionButton
                onClick={handleVerify}
                disabled={verifying || !otpComplete}
                animate={{ background: verifying || !otpComplete ? 'var(--color-border-strong)' : 'var(--color-primary)' }}
                whileHover={!verifying && otpComplete ? { background: 'var(--color-purple-mid-10)' } : undefined}
                transition={{ duration: 0.15 }}
                style={{ flex: 2, color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, padding: '12px 0', borderRadius: 12, border: 'none', cursor: verifying || !otpComplete ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                {verifying ? 'Activating…' : (
                  <><Icon name="shield_lock" size={15} color="var(--color-white)" />Activate 2FA</>
                )}
              </MotionButton>
            </div>
          </div>
        )}

        {/* ── DONE ── */}
        {step === 'done' && (
          <div style={{ padding: '48px 32px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
            <MotionIn
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4, ease: EASE_SPRING }}
              style={{ width: 68, height: 68, borderRadius: '50%', background: 'rgba(var(--color-success-rgb), 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="check_circle" size={36} color="var(--color-success)" />
            </MotionIn>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', textAlign: 'center' }}>2FA Enabled!</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-tertiary)', textAlign: 'center', lineHeight: 1.5 }}>
              Your account is now protected with two-factor authentication.
            </div>
          </div>
        )}
      </ModalIn>
    </div>
  );
}
