import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from '../animate-ui/motion';
import MotionButton from '../animate-ui/MotionButton';

interface Props {
  isOpen: boolean;
  isThinking: boolean;
  onClick: () => void;
  size?: number;
}

export default function AIBubble({ isOpen, isThinking, onClick, size = 52 }: Props) {
  // The idle float is continuous decorative motion; MotionConfig's
  // reducedMotion only covers transform-based animations it drives, and
  // Phase 4 wants this pausable explicitly.
  const reduceMotion = useReducedMotion();
  const bubbleRef = useRef<HTMLButtonElement>(null);
  const [pupil, setPupil] = useState({ x: 0, y: 0 });
  const [blink, setBlink] = useState(false);
  const [hovered, setHovered] = useState(false);

  // Track mouse → pupil direction
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

  // Idle blink every 3–5 s
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

  // Glow shadow layers
  const shadow = isOpen
    ? '0 0 0 5px rgba(var(--color-accent-purple-light-rgb), 0.25), 0 0 22px rgba(var(--color-primary-rgb), 0.5), 0 8px 24px rgba(var(--color-primary-rgb), 0.4)'
    : hovered
    ? '0 0 0 6px rgba(var(--color-accent-purple-light-rgb), 0.22), 0 0 20px rgba(var(--color-primary-rgb), 0.45), 0 6px 20px rgba(var(--color-primary-rgb), 0.35)'
    : '0 4px 16px rgba(var(--color-primary-rgb), 0.28)';

  return (
    <MotionButton
      ref={bubbleRef}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label="AI Assistant"
      // The idle float and the hover/open scale share this element, so they
      // share one target: `scale` resolves from state, `y` only loops while the
      // bubble is idle (and never under reduced motion).
      animate={{
        scale: hovered ? 1.1 : isOpen ? 1.05 : 1,
        y: !isOpen && !isThinking && !reduceMotion ? [0, -3, 0] : 0,
      }}
      transition={{
        scale: { duration: 0.22 },
        y: { duration: 7, ease: 'easeInOut', repeat: Infinity },
      }}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        border: 'none',
        cursor: 'pointer',
        padding: 0,
        background: 'none',
        position: 'relative',
        boxShadow: shadow,
      }}
    >
      <svg viewBox="0 0 52 52" width={size} height={size} style={{ display: 'block' }}>
        <defs>
          <radialGradient id="bubbleGrad" cx="40%" cy="35%" r="65%">
            <stop offset="0%" stopColor="var(--color-accent-purple-light)" />
            <stop offset="100%" stopColor="var(--color-purple-mid-13)" />
          </radialGradient>
          <clipPath id="leftEyeClip">
            <ellipse cx="18" cy="22" rx="7" ry="8" />
          </clipPath>
          <clipPath id="rightEyeClip">
            <ellipse cx="34" cy="22" rx="7" ry="8" />
          </clipPath>
        </defs>

        <circle cx="26" cy="26" r="26" fill="url(#bubbleGrad)" />
        <ellipse cx="20" cy="14" rx="9" ry="5" fill="rgba(var(--color-white-rgb), 0.18)" />

        {/* Left eye */}
        <motion.ellipse
          cx="18" cy="22" rx="7" ry="8" fill="white"
          animate={{ scaleY: eyeScaleY }} transition={{ duration: 0.08 }} style={{ transformOrigin: '18px 22px' }}
        />
        {!blink && <circle cx={18 + pupil.x} cy={22 + pupil.y} r="3.5" fill="var(--color-purple-deep-2)" clipPath="url(#leftEyeClip)" />}
        {!blink && <circle cx={18 + pupil.x + 1.2} cy={22 + pupil.y - 1.2} r="1" fill="rgba(var(--color-white-rgb), 0.7)" clipPath="url(#leftEyeClip)" />}

        {/* Right eye */}
        <motion.ellipse
          cx="34" cy="22" rx="7" ry="8" fill="white"
          animate={{ scaleY: eyeScaleY }} transition={{ duration: 0.08 }} style={{ transformOrigin: '34px 22px' }}
        />
        {!blink && <circle cx={34 + pupil.x} cy={22 + pupil.y} r="3.5" fill="var(--color-purple-deep-2)" clipPath="url(#rightEyeClip)" />}
        {!blink && <circle cx={34 + pupil.x + 1.2} cy={22 + pupil.y - 1.2} r="1" fill="rgba(var(--color-white-rgb), 0.7)" clipPath="url(#rightEyeClip)" />}

        {/* Smile */}
        <path d="M 19 32 Q 26 38 33 32" fill="none" stroke="rgba(var(--color-white-rgb), 0.85)" strokeWidth="2" strokeLinecap="round" />
      </svg>

      {/* Thinking dot */}
      {isThinking && (
        <motion.span animate={{ scale: [1, 1.3, 1], opacity: [1, 0.7, 1] }} transition={{ duration: 1.0, ease: 'easeInOut', repeat: Infinity }} style={{
          position: 'absolute', top: 2, right: 2,
          width: 12, height: 12, borderRadius: '50%',
          background: 'var(--color-success)', border: '2px solid var(--color-white)',
        }} />
      )}

    </MotionButton>
  );
}
