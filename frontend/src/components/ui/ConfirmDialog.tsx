// Stable Solytiq primitive wrapping the vendored Animate UI Radix Dialog
// primitive (src/components/animate-ui/primitives/radix/dialog.tsx).
//
// This is the Sprint 03 Animate-UI production pilot: a small, self-contained
// destructive-confirmation dialog, first wired in TemplatesScreen.tsx in
// place of a hand-rolled `createPortal` div that had no dialog semantics, no
// focus trap, and no Escape handling. Callers get the exact same visual
// language as the app's existing modals (Solytiq tokens, `--font-heading`,
// existing radii/shadows) plus real accessibility for free:
//   - accessible name (DialogTitle, `aria-labelledby`)
//   - accessible description (DialogDescription, `aria-describedby`)
//   - focus moves into the dialog on open and is trapped inside it
//   - Escape closes it and returns focus to the trigger — see
//     `restoreFocusTo` below for why this needs an explicit assist at the
//     one real call site this pilot has (Sprint 03 independent-review
//     finding: Radix's default onCloseAutoFocus restores focus to whatever
//     element was focused when the dialog OPENED, but TemplatesScreen's
//     "Delete" menu item unmounts itself the instant it's clicked — by the
//     time the dialog closes, that node no longer exists in the DOM, so the
//     browser silently fell back to focusing <body>. `restoreFocusTo` lets
//     the caller name a DIFFERENT, still-mounted element — e.g. the "..."
//     menu trigger button, which survives the menu closing — as the real
//     focus-restoration target.)
//   - MotionConfig reducedMotion="user" (set once at the app root, see
//     main.tsx) makes the entrance/exit animation honor the user's OS-level
//     reduced-motion preference
//
// Intentionally NOT a general-purpose Dialog/AlertDialog/Sheet API surface —
// Sprint 03's scope is "ein kleiner Produktionspilot", not a full component
// library rollout (that migration is explicitly Sprint 04's job). Extend
// this file's surface only alongside a real second call site.
import type { ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogDescription,
} from '@/components/animate-ui/primitives/radix/dialog';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Defaults to the app's destructive/error color — set false for a
   *  non-destructive confirmation (uses the primary purple instead). */
  destructive?: boolean;
  onConfirm: () => void;
  /** Explicit focus-restoration target for when the dialog closes (Escape,
   *  Cancel, or Confirm) — pass the element that opened it IF that element
   *  is guaranteed to still be mounted when the dialog closes. Omit this
   *  only when the triggering element is provably still in the DOM at close
   *  time (Radix's own default `onCloseAutoFocus` behavior is otherwise
   *  used, which assumes exactly that and silently falls back to `<body>`
   *  when it's wrong — see the note above). */
  restoreFocusTo?: HTMLElement | null;
}

export default function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = true,
  onConfirm,
  restoreFocusTo,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(var(--color-black-rgb), 0.28)',
            backdropFilter: 'blur(5px)',
          }}
        />
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 'var(--modal-pad)',
            pointerEvents: 'none',
          }}
        >
          <DialogContent
            onCloseAutoFocus={(e) => {
              if (restoreFocusTo) {
                // Radix would otherwise try to focus whatever had focus when
                // the dialog OPENED; preventDefault() stops that so we can
                // point it at a target we know is actually still mounted.
                e.preventDefault();
                restoreFocusTo.focus();
              }
            }}
            style={{
              pointerEvents: 'auto',
              background: 'var(--color-white)',
              borderRadius: 16,
              width: '100%',
              maxWidth: 380,
              boxShadow: '0 12px 40px rgba(var(--color-black-rgb), 0.18)',
              padding: 24,
              outline: 'none',
            }}
          >
            <DialogTitle
              style={{
                fontFamily: 'var(--font-heading)',
                fontSize: 16,
                fontWeight: 700,
                color: 'var(--color-text-primary)',
                marginBottom: 8,
              }}
            >
              {title}
            </DialogTitle>
            {description && (
              <DialogDescription
                style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: 13,
                  color: 'var(--color-text-tertiary)',
                  marginBottom: 20,
                }}
              >
                {description}
              </DialogDescription>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: description ? 0 : 20 }}>
              <button
                onClick={() => onOpenChange(false)}
                style={{
                  fontFamily: 'var(--font-heading)',
                  fontSize: 13,
                  fontWeight: 500,
                  color: 'var(--color-text-secondary)',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '10px 16px',
                }}
              >
                {cancelLabel}
              </button>
              <button
                onClick={() => { onConfirm(); onOpenChange(false); }}
                style={{
                  fontFamily: 'var(--font-heading)',
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--color-white)',
                  background: destructive ? 'var(--color-error)' : 'var(--color-primary)',
                  border: 'none',
                  borderRadius: 8,
                  padding: '10px 20px',
                  cursor: 'pointer',
                }}
              >
                {confirmLabel}
              </button>
            </div>
          </DialogContent>
        </div>
      </DialogPortal>
    </Dialog>
  );
}
