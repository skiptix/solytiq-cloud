import { useEffect, useMemo } from 'react';
import useShortcutsStore from '../store/useShortcutsStore';
import useAppStore from '../store/useAppStore';
import useAIStore from '../store/useAIStore';
import { SHORTCUT_DEFS, bindingFor, comboFromEvent } from '../shortcuts/registry';

const SIDEBAR_MINI = 60;
const SIDEBAR_DEFAULT = 256;
const SIDEBAR_COLLAPSE_THRESHOLD = 72; // matches Sidebar.tsx's `collapsed = width <= 72`

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

// Mounted once in AppLayout. Matches keydown events against the user's current
// shortcut bindings and either performs the action directly (sidebar toggle,
// a plain store mutation) or dispatches a `shortcut:<id>` CustomEvent for
// whichever screen/component is mounted to handle it (create-item, delete, etc).
export default function KeyboardShortcuts() {
  const overrides = useShortcutsStore(s => s.overrides);
  const setSidebarWidth = useAppStore(s => s.setSidebarWidth);

  const comboMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const def of SHORTCUT_DEFS) {
      const binding = bindingFor(overrides, def);
      if (binding.enabled && binding.key) map.set(binding.key, def.id);
    }
    return map;
  }, [overrides]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Sol's chat is a full-screen modal — while it's open, any OTHER
      // global shortcut would still act on the app underneath it (switch
      // views, collapse the sidebar, ...) invisibly behind the overlay.
      // Only Escape is let through, to close the chat; everything else is
      // swallowed here, whether or not focus happens to be inside the
      // chat's own textarea (which is why this runs BEFORE the typing-
      // target check below — that check alone would also block Escape).
      if (useAIStore.getState().isOpen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          useAIStore.getState().setOpen(false);
        }
        return;
      }

      if (isTypingTarget(e.target)) return;
      const id = comboMap.get(comboFromEvent(e));
      if (!id) return;
      e.preventDefault();

      if (id === 'toggle-sidebar') {
        const current = useAppStore.getState().sidebarWidth;
        setSidebarWidth(current <= SIDEBAR_COLLAPSE_THRESHOLD ? SIDEBAR_DEFAULT : SIDEBAR_MINI);
        return;
      }

      window.dispatchEvent(new CustomEvent(`shortcut:${id}`));
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [comboMap, setSidebarWidth]);

  return null;
}
