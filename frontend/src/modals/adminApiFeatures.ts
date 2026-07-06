import type { AdminApiScope } from '../api/client';

// Feature catalogue — the single source of truth for the Admin API key wizard
// toggles AND the scope chips shown on active keys. Order matters (read first,
// then the write features). Kept in its own module so the wizard component file
// only exports a component (react-refresh friendly).
export interface AdminApiFeature {
  scope: AdminApiScope;
  label: string;
  desc: string;
  icon: string;
}

export const ADMIN_API_FEATURES: AdminApiFeature[] = [
  { scope: 'read',       label: 'Read & export',   desc: 'Read all users, workspaces, lists, items, timelines & attachments', icon: 'visibility' },
  { scope: 'users',      label: 'Users',           desc: 'Create, update & delete user accounts',                             icon: 'group' },
  { scope: 'workspaces', label: 'Workspaces',      desc: 'Create, update & delete workspaces',                                icon: 'workspaces' },
  { scope: 'folders',    label: 'Folders',         desc: 'Create, update & delete folders',                                   icon: 'folder' },
  { scope: 'lists',      label: 'Lists & items',   desc: 'Create & manage lists, sections and tasks',                         icon: 'checklist' },
  { scope: 'timelines',  label: 'Timelines',       desc: 'Create & manage timelines and milestones',                          icon: 'timeline' },
  { scope: 'meetings',   label: 'Meetings',        desc: 'Create & manage calendar meetings',                                 icon: 'event' },
];

export const featureForScope = (scope: AdminApiScope) => ADMIN_API_FEATURES.find(f => f.scope === scope);
