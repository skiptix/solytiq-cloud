// Knowledge Base entry-type catalog (label + icon per KnowledgeEntryType) —
// shared between EntryInspector.tsx (the type picker) and KnowledgeScreen.tsx
// (the term-type filter). Kept out of both component files deliberately: a
// file that exports both a component and a plain constant breaks Fast Refresh
// (see CLAUDE.md's Knowledge Base section / utils/markdownBlocks.ts's header
// for the same rule applied elsewhere).

export const ENTRY_TYPE_OPTIONS: Array<{ key: string; label: string; icon: string }> = [
  { key: 'concept', label: 'Concept', icon: 'lightbulb' },
  { key: 'person', label: 'Person', icon: 'person' },
  { key: 'project', label: 'Project', icon: 'rocket_launch' },
  { key: 'system', label: 'System', icon: 'dns' },
  { key: 'acronym', label: 'Acronym', icon: 'abc' },
  { key: 'policy', label: 'Policy', icon: 'gavel' },
  { key: 'process', label: 'Process', icon: 'account_tree' },
  { key: 'other', label: 'Other', icon: 'more_horiz' },
];
