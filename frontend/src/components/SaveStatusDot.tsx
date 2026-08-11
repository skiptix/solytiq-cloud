import { useState } from 'react';
import { motion, useReducedMotion } from '@/components/animate-ui/motion';
import useSaveStatusStore, { type SaveStatus } from '../store/useSaveStatusStore';

// CSS `ease` keyword as an explicit cubic-bezier, so the Motion-driven
// tooltip entrance below is timing-identical to the `menuIn` keyframe it
// replaces here (opacity 0→1, scale .88→1, translateY -6px→0, 120ms ease).
const MENU_IN_EASE: [number, number, number, number] = [0.25, 0.1, 0.25, 1];

// Small colored status dot shown after a list/timeline/markdown page title:
//   green  = all changes saved (resting/idle or just-saved)
//   amber  = saving… (gently pulses)
//   red    = a save failed
// Hovering reveals a tooltip with the full status text. Pass `state` to drive
// it from a screen's own save state (markdown pages do this); omit it to read
// the global list-content save signal (Board / Timeline screens).
const CONFIG: Record<SaveStatus, { color: string; halo: string; label: string }> = {
  idle:   { color: 'var(--color-success)', halo: 'rgba(var(--color-success-rgb), 0.22)', label: 'All changes saved' },
  saved:  { color: 'var(--color-success)', halo: 'rgba(var(--color-success-rgb), 0.22)', label: 'All changes saved' },
  saving: { color: 'var(--color-warning)', halo: 'rgba(217, 119, 6, 0.24)',              label: 'Saving…' },
  error:  { color: 'var(--color-error)',   halo: 'rgba(var(--color-error-rgb), 0.22)',   label: "Couldn't save changes" },
};

interface SaveStatusDotProps {
  state?: SaveStatus;
  /** Diameter of the dot in px (default 10). */
  size?: number;
}

export default function SaveStatusDot({ state, size = 10 }: SaveStatusDotProps) {
  const globalStatus = useSaveStatusStore(s => s.status);
  const status = state ?? globalStatus;
  const [hovered, setHovered] = useState(false);
  const cfg = CONFIG[status];
  const prefersReducedMotion = useReducedMotion();
  const pulsing = status === 'saving' && !prefersReducedMotion;

  return (
    <span
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
      aria-label={cfg.label}
      role="status"
    >
      <motion.span
        style={{
          width: size, height: size, borderRadius: '50%', background: cfg.color,
          boxShadow: `0 0 0 3px ${cfg.halo}`, cursor: 'default',
          transition: 'background 200ms ease, box-shadow 200ms ease',
        }}
        animate={pulsing ? { opacity: [1, 0.4, 1] } : { opacity: 1 }}
        transition={pulsing ? { duration: 1.2, ease: 'easeInOut', repeat: Infinity } : { duration: 0.2 }}
      />
      {hovered && (
        <motion.span
          initial={{ opacity: 0, scale: 0.88, y: -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.12, ease: MENU_IN_EASE }}
          style={{
            position: 'absolute', top: 'calc(100% + 8px)', left: '50%', x: '-50%',
            background: 'var(--color-text-primary)', color: 'var(--color-white)',
            fontFamily: 'var(--font-heading)', fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap',
            padding: '5px 9px', borderRadius: 7, boxShadow: '0 6px 20px rgba(var(--color-black-rgb), 0.22)',
            zIndex: 60, pointerEvents: 'none',
          }}
        >
          {cfg.label}
        </motion.span>
      )}
    </span>
  );
}
