import { useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from '@/components/animate-ui/motion';
import { backdropVariants, modalVariants } from '@/components/animate-ui/motionTokens';
import MotionButton from '@/components/animate-ui/MotionButton';
import Icon from './Icon';
import usePushStore from '../store/usePushStore';

/**
 * The first-launch notification pre-prompt.
 *
 * WHY A PRE-PROMPT AND NOT JUST THE OS PROMPT: on iOS,
 * `Notification.requestPermission()` can be answered exactly once. A user who
 * taps "Don't Allow" — because a system dialog appeared out of nowhere before
 * they knew what the app even does — can never be asked again by any code; only
 * by digging through iOS Settings. So this spends a dismissible in-app dialog
 * (which costs nothing and can be shown again) to explain what they'd be
 * agreeing to, and only fires the irreversible system prompt from the "Turn on"
 * button's own click handler — which is also the user gesture iOS requires for
 * the prompt to appear at all.
 *
 * "Not now" records a per-account dismissal rather than a permanent one: the
 * permission itself is untouched, so the user can still turn notifications on
 * from Settings → Notifications whenever they want.
 */
export default function PushPermissionPrompt({ userId, onClose }: { userId: string; onClose: () => void }) {
  const enablePush = usePushStore((s) => s.enablePush);
  const dismissPrompt = usePushStore((s) => s.dismissPrompt);
  const busy = usePushStore((s) => s.busy);
  const [denied, setDenied] = useState(false);

  const close = () => {
    dismissPrompt(userId);
    onClose();
  };

  const handleEnable = async () => {
    const permission = await enablePush();
    if (permission === 'granted') {
      close();
      return;
    }
    // A denial is final on iOS, so say so plainly here instead of letting the
    // user tap the same button again and wonder why nothing happens.
    setDenied(true);
    dismissPrompt(userId);
  };

  const perks: { icon: string; label: string }[] = [
    { icon: 'alternate_email', label: 'When someone mentions or tags you' },
    { icon: 'group', label: 'Activity on boards and pages you share' },
    { icon: 'event_busy', label: 'Deadlines and meeting reminders' },
  ];

  return createPortal(
    <AnimatePresence>
      <motion.div
        onClick={(e) => { if (e.target === e.currentTarget) close(); }}
        variants={backdropVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        style={{ position: 'fixed', inset: 0, background: 'rgba(var(--color-black-rgb), 0.28)', backdropFilter: 'blur(5px)', zIndex: 1500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--modal-pad)' }}
      >
        <motion.div
          onClick={(e) => e.stopPropagation()}
          variants={modalVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          style={{ background: 'var(--color-white)', borderRadius: 20, width: '100%', maxWidth: 380, boxShadow: '0 20px 60px rgba(var(--color-black-rgb), 0.18)', overflow: 'hidden' }}
        >
          {/* Hero */}
          <div style={{ padding: '26px 24px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
            <motion.div
              initial={{ scale: 0.7, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 320, damping: 20 }}
              style={{ width: 58, height: 58, borderRadius: 18, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}
            >
              <Icon name={denied ? 'notifications_off' : 'notifications_active'} size={28} color="var(--color-primary)" />
            </motion.div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)' }}>
              {denied ? 'Notifications are off' : 'Stay in the loop'}
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--color-text-tertiary)', lineHeight: 1.5, marginTop: 6 }}>
              {denied
                ? 'iOS only asks once. To turn them on, open the Settings app → Notifications → Solytiq Cloud and allow them there.'
                : 'Get a notification on this device the moment something needs you — even when Solytiq Cloud is closed.'}
            </div>
          </div>

          {!denied && (
            <div style={{ padding: '18px 24px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {perks.map((perk, i) => (
                <motion.div
                  key={perk.icon}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.06 * i + 0.08, duration: 0.22 }}
                  style={{ display: 'flex', alignItems: 'center', gap: 11 }}
                >
                  <div style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Icon name={perk.icon} size={16} color="var(--color-primary)" />
                  </div>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-secondary)' }}>{perk.label}</div>
                </motion.div>
              ))}
            </div>
          )}

          {/* Actions */}
          <div style={{ padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 9 }}>
            {denied ? (
              <MotionButton
                onClick={close}
                whileHover={{ opacity: 0.92 }}
                style={{ width: '100%', padding: '12px 16px', borderRadius: 11, border: 'none', background: 'var(--color-primary)', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
              >
                Got it
              </MotionButton>
            ) : (
              <>
                {/* The OS prompt is fired straight from this click handler — no
                    awaited work in between, or iOS drops the user gesture. */}
                <MotionButton
                  onClick={handleEnable}
                  disabled={busy}
                  whileHover={busy ? undefined : { opacity: 0.92 }}
                  style={{ width: '100%', padding: '12px 16px', borderRadius: 11, border: 'none', background: 'var(--color-primary)', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.75 : 1 }}
                >
                  {busy ? 'Turning on…' : 'Turn on notifications'}
                </MotionButton>
                <MotionButton
                  onClick={close}
                  whileHover={{ background: 'var(--color-surface-tint)' }}
                  style={{ width: '100%', padding: '11px 16px', borderRadius: 11, border: 'none', background: 'transparent', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-heading)', fontSize: 13.5, fontWeight: 600, cursor: 'pointer' }}
                >
                  Not now
                </MotionButton>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 11, color: 'var(--color-text-quaternary)', textAlign: 'center', marginTop: 2 }}>
                  You can change this any time in Settings → Notifications.
                </div>
              </>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
}
