import { useEffect, useRef, useState } from 'react';

interface Props {
  isOpen: boolean;
  isThinking: boolean;
  onClick: () => void;
}

export default function AIBubble({ isOpen, isThinking, onClick }: Props) {
  const bubbleRef = useRef<HTMLButtonElement>(null);
  // Pupil offset from eye center (max ±3px)
  const [pupil, setPupil] = useState({ x: 0, y: 0 });
  const [blink, setBlink] = useState(false);
  const [hovered, setHovered] = useState(false);

  // Track mouse and compute pupil direction
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const el = bubbleRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const dist = Math.hypot(dx, dy);
      const t = Math.min(1, dist / 300);
      const max = 2.8;
      setPupil({ x: (dx / (dist || 1)) * max * t, y: (dy / (dist || 1)) * max * t });
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  // Idle blink every 3–5 seconds
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const scheduleBlink = () => {
      const delay = 3000 + Math.random() * 2000;
      timer = setTimeout(() => {
        setBlink(true);
        setTimeout(() => setBlink(false), 180);
        scheduleBlink();
      }, delay);
    };
    scheduleBlink();
    return () => clearTimeout(timer);
  }, []);

  const eyeScaleY = blink ? 0.05 : 1;

  return (
    <button
      ref={bubbleRef}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label="AI Assistant"
      style={{
        width: 52,
        height: 52,
        borderRadius: '50%',
        border: 'none',
        cursor: 'pointer',
        padding: 0,
        background: 'none',
        position: 'relative',
        transition: 'transform 200ms cubic-bezier(0.34,1.56,0.64,1), box-shadow 200ms',
        transform: hovered ? 'scale(1.1)' : isOpen ? 'scale(1.05)' : 'scale(1)',
        boxShadow: isOpen
          ? '0 0 0 3px rgba(94,77,187,0.35), 0 8px 24px rgba(94,77,187,0.45)'
          : hovered
          ? '0 6px 20px rgba(94,77,187,0.4)'
          : '0 4px 16px rgba(94,77,187,0.3)',
        animation: !isOpen && !isThinking ? 'aiBubbleFloat 4s ease-in-out infinite' : undefined,
      }}
    >
      <svg viewBox="0 0 52 52" width="52" height="52" style={{ display: 'block' }}>
        <defs>
          <radialGradient id="bubbleGrad" cx="40%" cy="35%" r="65%">
            <stop offset="0%" stopColor="#9d8dff" />
            <stop offset="100%" stopColor="#4a39aa" />
          </radialGradient>
          <clipPath id="leftEyeClip">
            <ellipse cx="18" cy="22" rx="7" ry="8" />
          </clipPath>
          <clipPath id="rightEyeClip">
            <ellipse cx="34" cy="22" rx="7" ry="8" />
          </clipPath>
        </defs>

        {/* Bubble body */}
        <circle cx="26" cy="26" r="26" fill="url(#bubbleGrad)" />

        {/* Subtle shine */}
        <ellipse cx="20" cy="14" rx="9" ry="5" fill="rgba(255,255,255,0.18)" />

        {/* Left eye white */}
        <ellipse
          cx="18"
          cy="22"
          rx="7"
          ry="8"
          fill="white"
          style={{ transformOrigin: '18px 22px', transform: `scaleY(${eyeScaleY})`, transition: 'transform 80ms' }}
        />
        {/* Left pupil */}
        {!blink && (
          <circle
            cx={18 + pupil.x}
            cy={22 + pupil.y}
            r="3.5"
            fill="#2a1f6e"
            clipPath="url(#leftEyeClip)"
          />
        )}
        {/* Left pupil highlight */}
        {!blink && (
          <circle
            cx={18 + pupil.x + 1.2}
            cy={22 + pupil.y - 1.2}
            r="1"
            fill="rgba(255,255,255,0.7)"
            clipPath="url(#leftEyeClip)"
          />
        )}

        {/* Right eye white */}
        <ellipse
          cx="34"
          cy="22"
          rx="7"
          ry="8"
          fill="white"
          style={{ transformOrigin: '34px 22px', transform: `scaleY(${eyeScaleY})`, transition: 'transform 80ms' }}
        />
        {/* Right pupil */}
        {!blink && (
          <circle
            cx={34 + pupil.x}
            cy={22 + pupil.y}
            r="3.5"
            fill="#2a1f6e"
            clipPath="url(#rightEyeClip)"
          />
        )}
        {/* Right pupil highlight */}
        {!blink && (
          <circle
            cx={34 + pupil.x + 1.2}
            cy={22 + pupil.y - 1.2}
            r="1"
            fill="rgba(255,255,255,0.7)"
            clipPath="url(#rightEyeClip)"
          />
        )}

        {/* Smile */}
        <path
          d="M 19 32 Q 26 38 33 32"
          fill="none"
          stroke="rgba(255,255,255,0.85)"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>

      {/* Thinking / activity indicator dot */}
      {isThinking && (
        <span
          style={{
            position: 'absolute',
            top: 2,
            right: 2,
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: '#10B981',
            border: '2px solid #fff',
            animation: 'aiPulse 1s ease-in-out infinite',
          }}
        />
      )}
    </button>
  );
}
