import { describe, it, expect } from 'vitest';
import {
  buildPromoteConflict,
  buildRestrictConflict,
  type ConflictAncestor,
  type ConflictDescendant,
} from '../visibility';

describe('buildPromoteConflict', () => {
  it('is resolvable when every private ancestor can be promoted', () => {
    const ancestors: ConflictAncestor[] = [
      { type: 'workspace', id: 'w1', name: 'Team', canPromote: true },
      { type: 'folder', id: 'f1', name: 'Docs', canPromote: true },
    ];
    const c = buildPromoteConflict('list', 'My List', ancestors);
    expect(c.direction).toBe('promote');
    expect(c.canResolve).toBe(true);
    expect(c.blockedReason).toBeUndefined();
    expect(c.ancestors).toEqual(ancestors);
  });

  it('is blocked with an explanation when an ancestor cannot be promoted', () => {
    const ancestors: ConflictAncestor[] = [
      { type: 'workspace', id: 'w1', name: 'Team', canPromote: false },
    ];
    const c = buildPromoteConflict('folder', 'Docs', ancestors);
    expect(c.canResolve).toBe(false);
    expect(c.blockedReason).toContain('Team');
    expect(c.blockedReason).toContain('workspace');
  });
});

describe('buildRestrictConflict', () => {
  it('lists the public descendants that will be hidden and is always resolvable', () => {
    const descendants: ConflictDescendant[] = [
      { type: 'list', id: 'l1', name: 'Tasks' },
      { type: 'timeline', id: 't1', name: 'Roadmap' },
    ];
    const c = buildRestrictConflict('workspace', 'Team', descendants);
    expect(c.direction).toBe('restrict');
    expect(c.canResolve).toBe(true);
    expect(c.descendants).toEqual(descendants);
  });
});
