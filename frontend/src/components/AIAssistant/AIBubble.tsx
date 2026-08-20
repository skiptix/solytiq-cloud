import { useState } from 'react';
import { motion, useReducedMotion } from '../animate-ui/motion';
import MotionButton from '../animate-ui/MotionButton';
import Icon from '../Icon';

interface Props {
  isOpen: boolean;
  isThinking: boolean;
  onClick: () => void;
  /** A background-blurred blocking dialog (TaskDialog, the milestone editor,
   *  a top-level App.tsx modal, …) is open somewhere. The badge stays
   *  visible — it just goes inert and blurs itself to match, rather than
   *  disappearing, so it reads as "busy" instead of vanishing. */
  blocked?: boolean;
}

/**
 * The always-visible trigger for Sol — a compact pill BADGE (mark + name),
 * not the earlier full mascot-face circle. A face reads fine at 52px but not
 * in a pill this short, and a badge is what both mobile and desktop now
 * share (see index.tsx, which centers this at the bottom of the screen on
 * both) — one shape, one design, everywhere Sol shows up before you've
 * opened the chat.
 */
export default function AIBubble({ isOpen, isThinking, onClick, blocked }: Props) {
  // Continuous decorative motion — paused explicitly under reduced motion,
  // same convention as the rest of this feature (AIChatOverlay's
  // ThinkingDots, message entrances, ...).
  const reduceMotion = useReducedMotion();
  const [hovered, setHovered] = useState(false);

  const glow = blocked
    ? 'none'
    : isOpen
    ? '0 0 0 5px rgba(var(--color-accent-purple-light-rgb), 0.22), 0 10px 28px rgba(var(--color-primary-rgb), 0.45)'
    : hovered
    ? '0 0 0 5px rgba(var(--color-accent-purple-light-rgb), 0.18), 0 8px 24px rgba(var(--color-primary-rgb), 0.4)'
    : '0 6px 20px rgba(var(--color-primary-rgb), 0.32)';

  return (
    <MotionButton
      onClick={() => { if (!blocked) onClick(); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label="AI Assistant"
      aria-disabled={blocked}
      disabled={blocked}
      // The idle float and the hover/open scale share this element, so they
      // share one target: `scale` resolves from state, `y` only loops while
      // idle (never while blocked, thinking, open, or under reduced motion).
      animate={{
        scale: blocked ? 1 : hovered ? 1.05 : isOpen ? 1.03 : 1,
        y: !blocked && !isOpen && !isThinking && !reduceMotion ? [0, -3, 0] : 0,
        filter: blocked ? 'blur(2.5px)' : 'blur(0px)',
        opacity: blocked ? 0.55 : 1,
      }}
      whileTap={blocked ? undefined : { scale: 0.95 }}
      transition={{
        scale: { duration: 0.2 },
        y: { duration: 6, ease: 'easeInOut', repeat: Infinity },
        filter: { duration: 0.2 },
        opacity: { duration: 0.2 },
      }}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        height: 44, padding: '0 16px 0 8px',
        borderRadius: 9999, border: 'none', cursor: blocked ? 'default' : 'pointer',
        background: 'linear-gradient(135deg, var(--color-purple-mid-8) 0%, var(--color-purple-mid-13) 100%)',
        boxShadow: glow,
      }}
    >
      <motion.div
        animate={{ rotate: !blocked && isThinking ? 360 : 0 }}
        transition={!blocked && isThinking ? { duration: 1.1, ease: 'linear', repeat: Infinity } : { duration: 0.2 }}
        style={{
          width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
          background: 'rgba(var(--color-white-rgb), 0.2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Icon name="auto_awesome" size={15} color="var(--color-white)" />
      </motion.div>
      <span style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 700, color: 'var(--color-white)', letterSpacing: '-0.01em' }}>
        Sol
      </span>
      {!blocked && isThinking && (
        <motion.span
          animate={{ scale: [1, 1.35, 1], opacity: [1, 0.6, 1] }}
          transition={{ duration: 1.0, ease: 'easeInOut', repeat: Infinity }}
          style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--color-success)', flexShrink: 0 }}
        />
      )}
    </MotionButton>
  );
}
