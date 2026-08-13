// The route an automation's owning item lives at.
//
// Split out of screens/AutomationsScreen.tsx so that screen exports only its
// component — a module exporting both breaks Fast Refresh (see CLAUDE.md).
import type { AutomationOwnerEntityType } from '../types';

/** Where the "back" arrow returns to — the exact Board/Page/Timeline this
 *  automation gallery was opened from (there's no standalone gallery route
 *  in the sidebar anymore, so this is the only way back). */
export function ownerEntityPath(type: AutomationOwnerEntityType | null, id: string | null): string {
  if (type === 'list' && id) return `/list/${id}`;
  if (type === 'timeline' && id) return `/timeline/${id}`;
  if (type === 'markdownList' && id) return `/markdown-list/${id}`;
  return '/dashboard';
}
