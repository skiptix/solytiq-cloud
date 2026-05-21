import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import useAuthStore from '../store/useAuthStore';
import { apiNuke } from '../api/client';

const STEPS = [
  { at: 0,  label: 'Preparing wipe…' },
  { at: 18, label: 'Deleting tasks and lists…' },
  { at: 42, label: 'Removing all users…' },
  { at: 68, label: 'Finalizing database reset…' },
  { at: 92, label: 'Almost done…' },
];

const R = 68;
const CIRC = 2 * Math.PI * R;

export default function NukeScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signOut } = useAuthStore();
  const password = (location.state as { password?: string } | null)?.password ?? '';

  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const apiDoneRef = useRef(false);
  const doneHandled = useRef(false);

  useEffect(() => {
    if (!password) { navigate('/settings', { replace: true }); }
  }, []);

  useEffect(() => {
    if (!password) return;
    apiNuke(password)
      .then(() => { apiDoneRef.current = true; })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : '';
        setError(msg.toLowerCase().includes('invalid') ? 'Incorrect password.' : 'Nuke failed. Please try again.');
      });
  }, []);

  // Simulate progress up to 92%, easing as it approaches the cap
  useEffect(() => {
    if (error) return;
    const id = setInterval(() => {
      setProgress(prev => {
        const cap = apiDoneRef.current ? 100 : 92;
        if (prev >= cap) return prev;
        const gap = cap - prev;
        const step = apiDoneRef.current ? 3 : Math.max(0.25, gap * 0.035);
        return Math.min(cap, prev + step);
      });
    }, 50);
    return () => clearInterval(id);
  }, [error]);

  // Watch for 100% then sign out and redirect
  useEffect(() => {
    if (progress >= 100 && !doneHandled.current) {
      doneHandled.current = true;
      setTimeout(() => { signOut(); navigate('/setup', { replace: true }); }, 600);
    }
  }, [progress]);

  // Derive message from current progress
  const currentStep = [...STEPS].reverse().find(s => progress >= s.at) ?? STEPS[0];
  const pct = Math.min(100, Math.round(progress));
  const offset = CIRC * (1 - pct / 100);

  if (!password) return null;

  if (error) {
    return (
      <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg, #fdf8ff 0%, #f5f0ff 100%)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, padding: 24 }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#ffdad6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width={28} height={28} viewBox="0 0 24 24" fill="#ba1a1a"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"/></svg>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 20, fontWeight: 700, color: '#1c1b22', marginBottom: 8 }}>Something went wrong</div>
          <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#787584' }}>{error}</div>
        </div>
        <button
          onClick={() => navigate('/settings', { replace: true })}
          style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#5e4dbb', background: '#F5F3FF', border: 'none', borderRadius: 10, padding: '12px 28px', cursor: 'pointer' }}
        >
          Back to Settings
        </button>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg, #fff8f8 0%, #fff0f0 100%)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 0, padding: 24 }}>

      {/* Ring */}
      <div style={{ position: 'relative', width: 180, height: 180, marginBottom: 32 }}>
        <svg width={180} height={180} viewBox="0 0 180 180" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx={90} cy={90} r={R} fill="none" stroke="#ffdad6" strokeWidth={10} />
          <circle
            cx={90} cy={90} r={R} fill="none"
            stroke={pct === 100 ? '#10B981' : '#ba1a1a'}
            strokeWidth={10}
            strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 80ms linear, stroke 400ms ease' }}
          />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
          <span style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 32, fontWeight: 800, color: pct === 100 ? '#10B981' : '#ba1a1a', letterSpacing: '-0.03em', transition: 'color 400ms ease' }}>
            {pct}%
          </span>
        </div>
      </div>

      {/* Title */}
      <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 22, fontWeight: 700, color: '#1c1b22', letterSpacing: '-0.015em', marginBottom: 10 }}>
        {pct === 100 ? 'Wipe complete' : 'Nuking everything…'}
      </div>

      {/* Status message */}
      <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#787584', marginBottom: 40, minHeight: 20, transition: 'opacity 200ms' }}>
        {pct === 100 ? 'Redirecting to setup…' : currentStep.label}
      </div>

      {/* Step list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 320 }}>
        {STEPS.map((s, i) => {
          const done = progress > (STEPS[i + 1]?.at ?? 101);
          const active = currentStep === s;
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                background: done ? '#ba1a1a' : active ? '#ffdad6' : '#f1ecf6',
                border: `2px solid ${done ? '#ba1a1a' : active ? '#ba1a1a' : '#e8e4f0'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 300ms ease',
              }}>
                {done && (
                  <svg width={11} height={11} viewBox="0 0 12 12" fill="none">
                    <path d="M2 6l3 3 5-5" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
              <span style={{
                fontFamily: 'Inter, sans-serif', fontSize: 13,
                color: done ? '#1c1b22' : active ? '#ba1a1a' : '#b0acbe',
                fontWeight: active ? 600 : 400,
                transition: 'color 300ms ease',
              }}>
                {s.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
