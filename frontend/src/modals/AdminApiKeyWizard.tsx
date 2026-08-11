import { useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../components/Icon';
import { apiCreateAdminReadApiKey, type AdminApiScope, type AdminReadApiKey } from '../api/client';
import { ADMIN_API_FEATURES } from './adminApiFeatures';
import Spinner from '@/components/animate-ui/Spinner';

interface Props {
  onClose: () => void;
  onCreated: (key: AdminReadApiKey) => void;
}

export default function AdminApiKeyWizard({ onClose, onCreated }: Props) {
  const [step, setStep] = useState<0 | 1>(0);
  const [name, setName] = useState('Reporting integration');
  const [scopes, setScopes] = useState<Set<AdminApiScope>>(new Set(['read']));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState(false);
  const [closing, setClosing] = useState(false);

  const handleClose = () => { setClosing(true); setTimeout(onClose, 190); };

  const toggle = (scope: AdminApiScope) => {
    setScopes(prev => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope); else next.add(scope);
      return next;
    });
  };

  const handleGenerate = async () => {
    if (!name.trim() || scopes.size === 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiCreateAdminReadApiKey(name.trim(), [...scopes]);
      setSecret(res.secret);
      onCreated(res.key);
      setStep(1);
    } catch {
      setError('Failed to generate key. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const copySecret = () => {
    navigator.clipboard.writeText(secret).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const panelAnim = closing ? 'settingsModalOut 190ms ease-in both' : 'settingsModalIn 360ms cubic-bezier(0.22,1,0.36,1) both';
  const backdropAnim = closing ? 'backdropOut 190ms ease both' : 'backdropIn 220ms ease both';

  return createPortal(
    <div
      onClick={e => { if (e.target === e.currentTarget) handleClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.28)', backdropFilter: 'blur(5px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)', animation: backdropAnim }}>
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--color-white)', borderRadius: 20, width: '100%', maxWidth: 520, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(var(--color-black-rgb), 0.18)', animation: panelAnim, overflow: 'hidden', position: 'relative' }}>

        {/* Step indicator */}
        <div style={{ padding: '20px 24px 0', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {[0, 1].map(i => (
            <div key={i} style={{ height: 3, flex: 1, borderRadius: 9999, background: step > i ? 'var(--color-primary)' : step === i ? 'var(--color-accent-purple-light)' : 'var(--color-border)', transition: 'background 300ms' }} />
          ))}
        </div>

        {/* ── Step 0: name + permissions ── */}
        {step === 0 && (
          <div style={{ padding: '20px 24px 24px', overflowY: 'auto', animation: 'wizardStepIn 220ms cubic-bezier(0.22,1,0.36,1) both' }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 4 }}>New API key</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', marginBottom: 20 }}>Name the key and choose exactly which features it may use. Grant only what the integration needs.</div>

            <input
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Integration name…"
              maxLength={100}
              style={{ width: '100%', fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 600, padding: '10px 14px', borderRadius: 10, border: '1.5px solid var(--color-border)', outline: 'none', color: 'var(--color-text-primary)', background: 'var(--color-surface-neutral)', boxSizing: 'border-box', marginBottom: 20 }}
            />

            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Permissions</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {ADMIN_API_FEATURES.map(f => {
                const on = scopes.has(f.scope);
                return (
                  <button
                    key={f.scope}
                    onClick={() => toggle(f.scope)}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left', padding: '11px 14px', borderRadius: 12, border: `1.5px solid ${on ? 'var(--color-primary)' : 'var(--color-border)'}`, background: on ? 'var(--color-surface-tint-alt)' : 'var(--color-surface-neutral)', cursor: 'pointer', transition: 'all 150ms' }}>
                    <div style={{ width: 34, height: 34, borderRadius: 9, background: on ? 'var(--color-primary)' : 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 150ms' }}>
                      <Icon name={f.icon} size={18} color={on ? 'var(--color-white)' : 'var(--color-primary)'} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>{f.label}</div>
                      <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 1 }}>{f.desc}</div>
                    </div>
                    <div style={{ width: 22, height: 22, borderRadius: '50%', border: `2px solid ${on ? 'var(--color-primary)' : 'var(--color-purple-tint-4)'}`, background: on ? 'var(--color-primary)' : 'var(--color-white)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 150ms' }}>
                      {on && <Icon name="check" size={14} color="var(--color-white)" />}
                    </div>
                  </button>
                );
              })}
            </div>

            {error && <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-error)', marginTop: 12 }}>{error}</div>}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 22 }}>
              <button onClick={handleClose} style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)', background: 'var(--color-surface-tint-2)', border: 'none', borderRadius: 10, padding: '10px 20px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleGenerate} disabled={saving || !name.trim() || scopes.size === 0}
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: 'var(--color-white)', background: (!name.trim() || scopes.size === 0) ? 'var(--color-accent-purple-soft-alt)' : 'var(--color-primary)', border: 'none', borderRadius: 10, padding: '10px 22px', cursor: (saving || !name.trim() || scopes.size === 0) ? 'default' : 'pointer', transition: 'background 150ms' }}>
                {saving
                  ? <><Spinner size={14} thickness={2} trackColor="rgba(var(--color-white-rgb), 0.3)" indicatorColor="var(--color-white)" durationMs={600} /> Generating…</>
                  : <><Icon name="key" size={15} color="var(--color-white)" /> Generate key</>
                }
              </button>
            </div>
          </div>
        )}

        {/* ── Step 1: secret reveal ── */}
        {step === 1 && (
          <div style={{ padding: '28px 24px 24px', animation: 'wizardStepIn 280ms cubic-bezier(0.22,1,0.36,1) both' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
              <Icon name="key" size={26} color="var(--color-primary)" />
            </div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', textAlign: 'center', marginBottom: 6 }}>Key created</div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', textAlign: 'center', marginBottom: 20 }}>Copy this secret now — it is shown only once and stored only as a hash.</div>

            <div style={{ background: 'var(--color-surface-tint)', border: '1px solid var(--color-border)', borderRadius: 12, padding: 14 }}>
              <code style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--color-text-primary)', overflowWrap: 'anywhere' }}>{secret}</code>
              <button onClick={copySecret}
                style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-heading)', fontSize: 12, fontWeight: 700, color: 'var(--color-white)', background: 'var(--color-primary)', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer' }}>
                <Icon name={copied ? 'check' : 'content_copy'} size={14} color="var(--color-white)" /> {copied ? 'Copied' : 'Copy secret'}
              </button>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 22 }}>
              <button onClick={handleClose} style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-white)', background: 'var(--color-primary)', border: 'none', borderRadius: 10, padding: '11px 28px', cursor: 'pointer' }}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
