// Date formatting shared by the read-only shared-list renderers.
//
// Split out of components/SharedListViews.tsx: a module exporting both a
// component and a plain function breaks Fast Refresh (see CLAUDE.md).
export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
