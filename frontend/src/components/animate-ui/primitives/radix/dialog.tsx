'use client';

// Vendored from Animate UI (https://animate-ui.com), registry item
// "primitives-radix-dialog" — registry.json fetched from
// https://animate-ui.com/r/registry.json on 2026-08-10.
// Upstream source: https://github.com/imskyleen/animate-ui
// Pinned upstream commit: efeb96ffd7a3b7a4868667e4ac3c346620fb3044 (package
// version 1.0.27, 2025-12-31). License: MIT + Commons Clause (Copyright (c)
// 2025 Elliot Sutton) — permits use "as part of an application, website, or
// product" (this app's use case); forbids reselling/redistributing these
// components in their original form as a standalone product. See
// https://github.com/imskyleen/animate-ui/blob/main/LICENSE.md.
//
// LOCAL PATCH (Solytiq, Phase 3 Animate-UI-Kompatibilitäts-Spike): the
// upstream DialogContent animates a raw CSS `transform` string rather than
// Motion's structured transform value keys (x/y/scale/rotateX/...), so
// `MotionConfig reducedMotion="user"` silently failed to shorten/disable this
// 3D perspective-rotate entrance — verified with Playwright: settle time was
// ~430ms regardless of a `prefers-reduced-motion: reduce` context. Patched
// below to explicitly read `useReducedMotion()` and swap to a near-instant
// transition when active; verified fix: reduced-motion settle time ~20ms,
// normal-motion settle time unchanged (~430ms). See Sprint 03 handoff.
import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { AnimatePresence, motion, useReducedMotion, type HTMLMotionProps } from 'motion/react';

import { useControlledState } from '@/hooks/use-controlled-state';
import { getStrictContext } from '@/lib/get-strict-context';

type DialogContextType = {
  isOpen: boolean;
  setIsOpen: DialogProps['onOpenChange'];
};

const [DialogProvider, useDialog] =
  getStrictContext<DialogContextType>('DialogContext');

type DialogProps = React.ComponentProps<typeof DialogPrimitive.Root>;

function Dialog(props: DialogProps) {
  const [isOpen, setIsOpen] = useControlledState({
    value: props?.open,
    defaultValue: props?.defaultOpen,
    onChange: props?.onOpenChange,
  });

  return (
    <DialogProvider value={{ isOpen, setIsOpen }}>
      <DialogPrimitive.Root
        data-slot="dialog"
        {...props}
        onOpenChange={setIsOpen}
      />
    </DialogProvider>
  );
}

type DialogTriggerProps = React.ComponentProps<typeof DialogPrimitive.Trigger>;

function DialogTrigger(props: DialogTriggerProps) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

type DialogPortalProps = Omit<
  React.ComponentProps<typeof DialogPrimitive.Portal>,
  'forceMount'
>;

function DialogPortal(props: DialogPortalProps) {
  const { isOpen } = useDialog();

  return (
    <AnimatePresence>
      {isOpen && (
        <DialogPrimitive.Portal
          data-slot="dialog-portal"
          forceMount
          {...props}
        />
      )}
    </AnimatePresence>
  );
}

type DialogOverlayProps = Omit<
  React.ComponentProps<typeof DialogPrimitive.Overlay>,
  'forceMount' | 'asChild'
> &
  HTMLMotionProps<'div'>;

function DialogOverlay({
  transition = { duration: 0.2, ease: 'easeInOut' },
  ...props
}: DialogOverlayProps) {
  return (
    <DialogPrimitive.Overlay data-slot="dialog-overlay" asChild forceMount>
      <motion.div
        key="dialog-overlay"
        initial={{ opacity: 0, filter: 'blur(4px)' }}
        animate={{ opacity: 1, filter: 'blur(0px)' }}
        exit={{ opacity: 0, filter: 'blur(4px)' }}
        transition={transition}
        {...props}
      />
    </DialogPrimitive.Overlay>
  );
}

type DialogFlipDirection = 'top' | 'bottom' | 'left' | 'right';

type DialogContentProps = Omit<
  React.ComponentProps<typeof DialogPrimitive.Content>,
  'forceMount' | 'asChild'
> &
  HTMLMotionProps<'div'> & {
    from?: DialogFlipDirection;
  };

function DialogContent({
  from = 'top',
  onOpenAutoFocus,
  onCloseAutoFocus,
  onEscapeKeyDown,
  onPointerDownOutside,
  onInteractOutside,
  transition = { type: 'spring', stiffness: 150, damping: 25 },
  ...props
}: DialogContentProps) {
  const initialRotation =
    from === 'bottom' || from === 'left' ? '20deg' : '-20deg';
  const isVertical = from === 'top' || from === 'bottom';
  const rotateAxis = isVertical ? 'rotateX' : 'rotateY';
  // PATCH (Solytiq): the upstream primitive animates a raw `transform` CSS
  // string, which Motion's built-in reducedMotion detection does not
  // recognize as a structured transform value (x/y/scale/rotateX/etc.) — so
  // MotionConfig reducedMotion="user" silently fails to shorten/disable this
  // 3D perspective-rotate entrance. We explicitly read the reduced-motion
  // state and swap to a near-instant, non-perspective transition when active,
  // which is the documented workaround for animating a composite `transform`
  // string under Motion. See Phase 3 handoff, Pilotgate finding #1.
  const prefersReducedMotion = useReducedMotion();
  const effectiveTransition = prefersReducedMotion
    ? { duration: 0.01 }
    : transition;

  return (
    <DialogPrimitive.Content
      asChild
      forceMount
      onOpenAutoFocus={onOpenAutoFocus}
      onCloseAutoFocus={onCloseAutoFocus}
      onEscapeKeyDown={onEscapeKeyDown}
      onPointerDownOutside={onPointerDownOutside}
      onInteractOutside={onInteractOutside}
    >
      <motion.div
        key="dialog-content"
        data-slot="dialog-content"
        initial={{
          opacity: 0,
          filter: 'blur(4px)',
          transform: `perspective(500px) ${rotateAxis}(${initialRotation}) scale(0.8)`,
        }}
        animate={{
          opacity: 1,
          filter: 'blur(0px)',
          transform: `perspective(500px) ${rotateAxis}(0deg) scale(1)`,
        }}
        exit={{
          opacity: 0,
          filter: 'blur(4px)',
          transform: `perspective(500px) ${rotateAxis}(${initialRotation}) scale(0.8)`,
        }}
        transition={effectiveTransition}
        {...props}
      />
    </DialogPrimitive.Content>
  );
}

type DialogCloseProps = React.ComponentProps<typeof DialogPrimitive.Close>;

function DialogClose(props: DialogCloseProps) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

type DialogHeaderProps = React.ComponentProps<'div'>;

function DialogHeader(props: DialogHeaderProps) {
  return <div data-slot="dialog-header" {...props} />;
}

type DialogFooterProps = React.ComponentProps<'div'>;

function DialogFooter(props: DialogFooterProps) {
  return <div data-slot="dialog-footer" {...props} />;
}

type DialogTitleProps = React.ComponentProps<typeof DialogPrimitive.Title>;

function DialogTitle(props: DialogTitleProps) {
  return <DialogPrimitive.Title data-slot="dialog-title" {...props} />;
}

type DialogDescriptionProps = React.ComponentProps<
  typeof DialogPrimitive.Description
>;

function DialogDescription(props: DialogDescriptionProps) {
  return (
    <DialogPrimitive.Description data-slot="dialog-description" {...props} />
  );
}

// `useDialog` (the internal open/close context accessor) is intentionally
// NOT re-exported here — LOCAL PATCH (Solytiq): a components-file exporting
// a plain hook alongside components breaks Fast Refresh
// (react-refresh/only-export-components), and nothing outside this file
// (DialogPortal is its only consumer) currently needs it. Re-add a public
// export only alongside a real consumer.
export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  type DialogProps,
  type DialogTriggerProps,
  type DialogPortalProps,
  type DialogCloseProps,
  type DialogOverlayProps,
  type DialogContentProps,
  type DialogHeaderProps,
  type DialogFooterProps,
  type DialogTitleProps,
  type DialogDescriptionProps,
  type DialogContextType,
  type DialogFlipDirection,
};
