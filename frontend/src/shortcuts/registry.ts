// Single source of truth for every global keyboard shortcut: its id, default
// key combo, and where it applies. `KeyboardShortcuts` (components/) matches
// keydown events against this list; the Controls tab in UserSettingsModal
// renders it for editing. Screens/components that perform the actual action
// listen for a `shortcut:<id>` CustomEvent on `window`.

export type ShortcutScope = 'global' | 'list' | 'timeline' | 'calendar' | 'dialog';

export interface ShortcutDef {
  id: string;
  label: string;
  description: string;
  defaultKey: string;
  scope: ShortcutScope;
  scopeLabel: string;
}

export interface ShortcutOverride {
  key?: string;
  enabled?: boolean;
}

export interface ShortcutBinding {
  key: string;
  enabled: boolean;
}

export const SHORTCUT_DEFS: ShortcutDef[] = [
  { id: 'focus-search', label: 'Open search', description: 'Open the search / command palette.', defaultKey: 'mod+k', scope: 'global', scopeLabel: 'Anywhere' },
  { id: 'toggle-sidebar', label: 'Collapse sidebar', description: 'Collapse or expand the sidebar.', defaultKey: 'mod+b', scope: 'global', scopeLabel: 'Anywhere' },
  { id: 'open-settings', label: 'Open account settings', description: 'Open your account settings.', defaultKey: 'mod+,', scope: 'global', scopeLabel: 'Anywhere' },
  { id: 'create-list', label: 'New board', description: 'Open the wizard to create a new board.', defaultKey: 'l', scope: 'global', scopeLabel: 'Anywhere' },
  { id: 'create-folder', label: 'New folder', description: 'Start creating a new folder in the sidebar.', defaultKey: 'f', scope: 'global', scopeLabel: 'Anywhere' },
  { id: 'create-workspace', label: 'New workspace', description: 'Open the wizard to create a new workspace.', defaultKey: 'w', scope: 'global', scopeLabel: 'Anywhere' },
  { id: 'create-item', label: 'New item', description: 'Focus the quick-add field to add a new item.', defaultKey: 'i', scope: 'list', scopeLabel: 'Inside a board' },
  { id: 'view-list', label: 'List view', description: 'Switch this board to List view.', defaultKey: '1', scope: 'list', scopeLabel: 'Inside a board' },
  { id: 'view-kanban', label: 'Kanban view', description: 'Switch this board to Kanban view.', defaultKey: '2', scope: 'list', scopeLabel: 'Inside a board' },
  { id: 'view-timeline', label: 'Timeline view', description: 'Switch this board to Timeline view.', defaultKey: '3', scope: 'list', scopeLabel: 'Inside a board' },
  { id: 'create-milestone', label: 'New milestone', description: 'Open the editor to add a new milestone.', defaultKey: 'm', scope: 'timeline', scopeLabel: 'Inside a timeline' },
  { id: 'create-meeting', label: 'New meeting', description: 'Open the editor to add a new meeting.', defaultKey: 'c', scope: 'calendar', scopeLabel: 'Calendar page' },
  { id: 'delete-current', label: 'Delete open item / milestone', description: 'Ask to delete the item or milestone currently open in its editor.', defaultKey: 'backspace', scope: 'dialog', scopeLabel: 'Item / milestone editor' },
  { id: 'toggle-changelog', label: 'Toggle change history', description: 'Show or hide the change history panel for the item currently open in its editor.', defaultKey: 'h', scope: 'dialog', scopeLabel: 'Item / milestone editor' },
];

export function bindingFor(overrides: Record<string, ShortcutOverride>, def: ShortcutDef): ShortcutBinding {
  const ov = overrides[def.id];
  return { key: ov?.key ?? def.defaultKey, enabled: ov?.enabled ?? true };
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Normalizes a keydown event into a stable combo string, e.g. "mod+shift+l". */
export function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  const key = e.key === ' ' ? 'space' : e.key.toLowerCase();
  if (!['control', 'meta', 'shift', 'alt'].includes(key)) parts.push(key);
  return parts.join('+');
}

const KEY_SYMBOLS: Record<string, string> = {
  mod: isMac ? '⌘' : 'Ctrl', shift: isMac ? '⇧' : 'Shift', alt: isMac ? '⌥' : 'Alt',
  delete: 'Delete', backspace: 'Backspace', escape: 'Esc', space: 'Space',
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
};

/** Formats a combo string for display, e.g. "mod+k" -> "⌘K" (Mac) / "Ctrl+K" (other). */
export function formatCombo(combo: string): string {
  const labelled = combo.split('+').map(part => KEY_SYMBOLS[part] ?? (part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)));
  return isMac ? labelled.join('') : labelled.join('+');
}

// Combos we refuse as custom bindings because they collide with a browser/OS
// action the user would otherwise lose (closing/opening tabs, reloading, etc.).
const RESERVED_COMBOS = new Set(['mod+w', 'mod+t', 'mod+n', 'mod+shift+n', 'mod+shift+t', 'mod+r', 'mod+q', 'mod+shift+q', 'mod+shift+w']);

export function isReservedCombo(combo: string): boolean {
  return RESERVED_COMBOS.has(combo);
}
