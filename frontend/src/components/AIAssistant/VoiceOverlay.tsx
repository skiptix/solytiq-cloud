// ---------------------------------------------------------------------------
// Voice-only mode — the full-screen surface that replaces the chat sheet.
//
// There is no text input here, by design: on a phone the keyboard is the worst
// input the device has, and a voice assistant that still shows a composer just
// invites you to fall back to typing. What's on screen is an orb, a waveform,
// and one line of status. Everything is one tap: tap to speak, tap to send,
// tap again to interrupt a reply.
//
// The conversation still runs through the SAME `onSend` the text chat uses, so
// every tool, skill and Knowledge Base lookup behaves identically — see
// aiVoice.ts for why the pipeline shape is what guarantees that.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from '@/components/animate-ui/motion';
import { EASE_SETTLE, EASE_SPRING, backdropVariants } from '@/components/animate-ui/motionTokens';
import useFrameLoop from '../animate-ui/useFrameLoop';
import Icon from '../Icon';
import { useVisualViewport } from '../../hooks/useVisualViewport';
import { useLockBodyScroll } from '../../hooks/useLockBodyScroll';
import VoiceWaveform from './VoiceWaveform';
import useVoiceSession, { isVoiceSupported, type VoicePhase } from './useVoiceSession';

interface Props {
  /** Runs one full assistant turn and resolves with the reply text to speak. */
  onTurn: (transcript: string) => Promise<string>;
  onClose: () => void;
  /** Offered only when voice genuinely cannot run here, never as an ordinary
   *  escape hatch — see the fallback block below. */
  onFallbackToText: () => void;
  sessionId: string | null;
  isMobile: boolean;
  voiceName?: string;
  /** Opened via the "Talk to Sol" shortcut — begin listening on mount. */
  autoListen?: boolean;
  onAutoListenHandled?: () => void;
}

/** One short line per phase. Every one names the tap that advances it, because
 *  with no other chrome on screen the status line is the only affordance. */
const PHASE_LABEL: Record<VoicePhase, string> = {
  idle: 'Tap to speak',
  requesting: 'Waiting for microphone access…',
  listening: 'Listening — tap when you’re done',
  transcribing: 'Got that…',
  thinking: 'Working on it…',
  speaking: 'Tap to interrupt',
};

/**
 * The orb. Breathes with the live amplitude by reading `levelRef` every frame
 * and writing `scale` straight to the node — the same no-React-state-per-frame
 * rule the waveform follows.
 */
function VoiceOrb({ levelRef, phase }: { levelRef: React.RefObject<number>; phase: VoicePhase }) {
  const ref = useRef<HTMLDivElement>(null);
  const current = useRef(1);
  const busy = phase === 'listening' || phase === 'speaking';

  useFrameLoop(() => {
    const el = ref.current;
    if (!el) return;
    const target = busy ? 1 + Math.min(1, levelRef.current) * 0.22 : 1;
    current.current += (target - current.current) * 0.18;
    el.style.transform = `scale(${current.current.toFixed(4)})`;
  }, { running: busy, reducedMotion: 'settle', settleMs: 60_000 });

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute', inset: 0, borderRadius: '50%',
        background: 'radial-gradient(circle at 32% 28%, var(--color-purple-pale-14) 0%, var(--color-primary) 55%, var(--color-purple-mid-13) 100%)',
        boxShadow: '0 18px 60px rgba(var(--color-primary-rgb), 0.55)',
        willChange: 'transform',
      }}
    />
  );
}

export default function VoiceOverlay({ onTurn, onClose, onFallbackToText, sessionId, isMobile, voiceName, autoListen, onAutoListenHandled }: Props) {
  const { height: viewportHeight, top: viewportTop } = useVisualViewport();
  useLockBodyScroll();
  const [supported] = useState(() => isVoiceSupported());

  // One turn, end to end. This stays a plain "words in, words out" function —
  // returning the reply is all it takes to have it spoken, because the hook
  // owns playback (see VoiceSessionOptions.onTranscript). That's what keeps
  // "what a turn IS" here, in the assistant, and audio entirely in the hook.
  const handleTranscript = useCallback((text: string) => onTurn(text), [onTurn]);

  const voice = useVoiceSession({ onTranscript: handleTranscript, sessionId });

  // Voice-only mode with no way to record is a dead end, not a degraded
  // experience — an orb that can never do anything is worse than no orb. This
  // is the ONLY case that offers a text fallback; it is a rescue, not a
  // general-purpose "type instead" button, which would defeat the mode.
  const dead = !supported || voice.permissionDenied;
  const { phase, error, permissionDenied, levelRef, analyserRef } = voice;

  // The shortcut's whole point is one gesture, so honour it on mount rather
  // than making the user tap the orb they just asked for. Guarded by a ref so
  // it fires exactly once even though `phase` changes many times afterwards.
  const autoListenDone = useRef(false);
  useEffect(() => {
    if (!autoListen || autoListenDone.current || dead) return;
    autoListenDone.current = true;
    onAutoListenHandled?.();
    void voice.startListening();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoListen, dead]);

  const handleTap = useCallback(() => {
    if (phase === 'idle') void voice.startListening();
    else if (phase === 'listening') void voice.stopListening();
    else if (phase === 'speaking') voice.cancel();
    // transcribing / thinking / requesting are waits on something else —
    // a tap there would abandon work already paid for, so it does nothing.
  }, [phase, voice]);

  // Escape closes, space toggles the turn. Space is the desktop analogue of
  // tapping the orb; it is safe to claim outright because voice-only mode has
  // no text field anywhere for it to be typed into.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { voice.cancel(); onClose(); return; }
      if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); handleTap(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleTap, onClose, voice]);

  const listening = phase === 'listening';
  const speaking = phase === 'speaking';
  const active = listening || speaking;
  const orbSize = isMobile ? 156 : 184;

  return (
    <>
      <motion.div
        onClick={() => { voice.cancel(); onClose(); }}
        variants={backdropVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        style={{
          // Outset past every edge for the same reason the chat overlay's
          // backdrop is: a blurred box sized exactly to the viewport shows a
          // seam at its own boundary on Safari.
          position: 'fixed', top: -100, left: -100, right: -100, bottom: -100,
          background: 'rgba(var(--color-black-rgb), 0.62)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          zIndex: 9000,
        }}
      />

      <motion.div
        initial={false}
        animate={{ top: viewportTop, height: viewportHeight }}
        transition={{ duration: 0.25, ease: EASE_SETTLE }}
        style={{
          position: 'fixed', left: 0, right: 0, zIndex: 9001,
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          pointerEvents: 'none',
        }}
      >
        {/* Close */}
        <div style={{ width: '100%', display: 'flex', justifyContent: 'flex-end', padding: 'calc(env(safe-area-inset-top, 0px) + 14px) 16px 0', pointerEvents: 'auto' }}>
          <motion.button
            onClick={() => { voice.cancel(); onClose(); }}
            aria-label="Close voice mode"
            whileHover={{ scale: 1.06 }}
            whileTap={{ scale: 0.94 }}
            style={{
              width: 40, height: 40, borderRadius: '50%', border: 'none', cursor: 'pointer',
              background: 'rgba(var(--color-white-rgb), 0.14)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Icon name="close" size={20} color="var(--color-white)" />
          </motion.button>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 30, padding: '0 24px', pointerEvents: 'auto', width: '100%' }}>
          {dead ? (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: EASE_SETTLE }}
              style={{ maxWidth: 340, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}
            >
              <Icon name={permissionDenied ? 'mic_off' : 'error'} size={40} color="var(--color-white)" />
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, fontWeight: 600, color: 'var(--color-white)' }}>
                {permissionDenied ? 'Microphone blocked' : 'Voice isn’t available here'}
              </div>
              <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, lineHeight: 1.5, color: 'rgba(var(--color-white-rgb), 0.72)' }}>
                {permissionDenied
                  ? 'Your browser is blocking the microphone for this site. Re-allow it in your browser or system settings — the app can’t ask again once it’s been denied.'
                  : 'This browser can’t record audio. You can still chat with Sol by typing.'}
              </div>
              <motion.button
                onClick={onFallbackToText}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                style={{
                  marginTop: 4, padding: '11px 20px', borderRadius: 12, border: 'none', cursor: 'pointer',
                  background: 'var(--color-white)', color: 'var(--color-primary)',
                  fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600,
                }}
              >
                Type instead
              </motion.button>
            </motion.div>
          ) : (
            <>
              {/* Orb — the single tap target for the whole conversation. */}
              <motion.button
                onClick={handleTap}
                aria-label={PHASE_LABEL[phase]}
                initial={{ scale: 0.86, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.45, ease: EASE_SPRING }}
                whileTap={{ scale: 0.96 }}
                style={{
                  position: 'relative', width: orbSize, height: orbSize, borderRadius: '50%',
                  border: 'none', padding: 0, cursor: 'pointer', background: 'transparent',
                  flexShrink: 0,
                }}
              >
                <VoiceOrb levelRef={levelRef} phase={phase} />
                <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon
                    name={listening ? 'graphic_eq' : speaking ? 'volume_up' : phase === 'idle' ? 'mic' : 'more_horiz'}
                    size={44}
                    color="var(--color-white)"
                  />
                </span>
              </motion.button>

              {/* Waveform. Rendered at all times, not only while active — the
                  resting line is what tells you the surface is live and
                  waiting rather than frozen. */}
              <VoiceWaveform
                analyserRef={analyserRef}
                levelRef={levelRef}
                active={active}
                bars={isMobile ? 22 : 30}
                width={isMobile ? Math.min(280, window.innerWidth - 72) : 320}
                height={isMobile ? 72 : 88}
                color="rgba(var(--color-white-rgb), 0.9)"
              />

              <div style={{ textAlign: 'center', minHeight: 42 }}>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 600, color: 'var(--color-white)' }}>
                  {PHASE_LABEL[phase]}
                </div>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'rgba(var(--color-white-rgb), 0.6)', marginTop: 5 }}>
                  {error ?? (phase === 'idle' ? `Sol is listening in ${voiceName ?? 'her'} voice` : ' ')}
                </div>
              </div>
            </>
          )}
        </div>

        {/* A live region so a screen-reader user gets the same turn-by-turn
            status the status line above shows sighted users. The visual line
            is not itself the live region: it re-renders on every phase change
            including ones that carry no news. */}
        <span
          aria-live="polite"
          style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}
        >
          {PHASE_LABEL[phase]}
        </span>
      </motion.div>
    </>
  );
}
