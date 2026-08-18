// ---------------------------------------------------------------------------
// Per-item invitations — the containment cascade ("Shared with members").
//
// The rule the whole feature rests on: a grant is stored on ONE row (the thing
// a human clicked "invite" on) but RESOLVED over the containment tree, so
// sharing a folder hands over everything inside it — including items added
// after the invite — with no fan-out rows to keep in sync.
//
// Two things are worth locking down here, and both are cheap to get wrong:
//   1. `itemShareExists` (reads, SQL) and `isItemSharedWith` (writes, runtime)
//      must resolve the SAME tree. If they drift, a user can open a board and
//      not edit it, or worse, the other way round.
//   2. Revocation must stay where the grant is. `removeItemShare` deleting an
//      inherited row it never created would be a silent no-op that reads like
//      success in the UI.
//
// Mock QueryExec per the workspaceIntegrity.test.ts convention — no live DB.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest';
import {
  itemShareExists, isItemSharedWith, parseSharedItemType, SHARED_ITEM_TYPES,
} from '../itemShares';
import type { QueryExec } from '../workspaceUtil';

function makeExec(rowsByCall: unknown[][] = []) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const exec = vi.fn(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    const rows = rowsByCall.shift() ?? [];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }) as unknown as QueryExec;
  return { exec, calls };
}

describe('parseSharedItemType', () => {
  it('accepts exactly the four shareable types', () => {
    for (const t of SHARED_ITEM_TYPES) expect(parseSharedItemType(t)).toBe(t);
    expect(SHARED_ITEM_TYPES).toContain('folder');
  });

  it('rejects anything else, so a route param can never reach a table name', () => {
    for (const bad of ['task', 'workspace', 'lists', '', 'FOLDER', 'folder; DROP TABLE users']) {
      expect(parseSharedItemType(bad)).toBeNull();
    }
  });
});

describe('itemShareExists', () => {
  it('resolves a folder share only directly — nothing contains a folder', () => {
    const sql = itemShareExists('f', 'folder');
    expect(sql).toContain("s.item_type = 'folder'");
    expect(sql).toContain('s.item_id = f.id');
    // No containment lookup: a folder has no parent to inherit from.
    expect(sql).not.toContain('folder_id');
  });

  it('resolves a timeline/markdown page share directly OR through its folder', () => {
    for (const type of ['timeline', 'markdownList'] as const) {
      const sql = itemShareExists('x', type);
      expect(sql).toContain(`s.item_type = '${type}'`);
      expect(sql).toContain('s.item_id = x.id');
      expect(sql).toContain("s.item_type = 'folder'");
      expect(sql).toContain('s.item_id = x.folder_id');
    }
  });

  it('delegates the list case to the DB function, since sublists nest arbitrarily deep', () => {
    const sql = itemShareExists('l', 'list');
    expect(sql).toContain('item_share_grants_list($1::uuid, l.id)');
  });

  it('reaches the list recursion ONLY for rows that are actually sublists', () => {
    // The InitPlan guard exempts users with zero invitations; without this
    // second gate every collaborator would pay a recursive walk per row on
    // every list query, and a listing scans mostly top-level boards.
    const sql = itemShareExists('l', 'list');
    expect(sql).toContain('l.parent_task_id IS NOT NULL AND item_share_grants_list');
    // …and the two cheap branches must come first, or the gate buys nothing.
    expect(sql.indexOf("s.item_type = 'list'")).toBeLessThan(sql.indexOf('item_share_grants_list'));
  });

  it("covers a markdown page's Todo mirror without recursing (it sits in no folder)", () => {
    const sql = itemShareExists('l', 'list');
    expect(sql).toContain('m.todo_list_id = l.id');
    expect(sql).toContain("s2.item_type = 'markdownList'");
    expect(sql).toContain("s2.item_type = 'folder'");
  });

  it('honours a caller-supplied user parameter everywhere it is referenced', () => {
    for (const type of SHARED_ITEM_TYPES) {
      const sql = itemShareExists('x', type, '$4');
      expect(sql).not.toMatch(/\$1\b/);
      expect(sql).toContain('$4');
    }
  });

  it('honours the folder invite scope: a cascade branch requires include_all, a direct one never does', () => {
    // "Folder only" invites exist precisely so a folder can be shared without
    // its contents. A cascade branch that forgot this gate would silently hand
    // over every board in the folder anyway.
    for (const type of ['list', 'timeline', 'markdownList'] as const) {
      const sql = itemShareExists('x', type);
      expect(sql).toContain("s.item_type = 'folder'  AND s.item_id = x.folder_id AND s.include_all");
      // The item's OWN invite is unconditional — include_all is a folder-only
      // concept and must not gate a direct grant.
      expect(sql).toContain(`s.item_type = '${type}' AND s.item_id = x.id)`);
    }
    // Reaching a page's Todo mirror through the page's folder is a cascade too.
    expect(itemShareExists('l', 'list')).toContain("s2.item_type = 'folder'       AND s2.item_id = m.folder_id AND s2.include_all");
    // The folder row itself is always granted — you were invited to it.
    expect(itemShareExists('f', 'folder')).not.toContain('include_all');
  });

  it('front-loads a non-correlated guard so users with no invitations pay one probe', () => {
    // Not cosmetic: this subquery does not reference the outer row, so the
    // planner hoists it into a once-per-statement InitPlan. Without it every
    // scanned row would run the containment walk.
    for (const type of SHARED_ITEM_TYPES) {
      expect(itemShareExists('x', type)).toContain('EXISTS (SELECT 1 FROM item_shares s0 WHERE s0.user_id = $1)');
    }
  });
});

describe('isItemSharedWith — the runtime twin of itemShareExists', () => {
  it('asks the same DB function for a list, so reads and writes cannot disagree', async () => {
    const { exec, calls } = makeExec([[{ granted: true }]]);
    expect(await isItemSharedWith('list', 'list_1', 'user-2', exec)).toBe(true);
    expect(calls[0].text).toContain('item_share_grants_list');
    expect(calls[0].params).toEqual(['user-2', 'list_1']);
  });

  it('reads a falsy grant as no access rather than as a present row', async () => {
    // The function always returns exactly one row — `false`, not zero rows —
    // so a naive `rows.length > 0` check here would grant access to everyone.
    const { exec } = makeExec([[{ granted: false }]]);
    expect(await isItemSharedWith('list', 'list_1', 'user-2', exec)).toBe(false);
  });

  it('checks a folder invite directly', async () => {
    const { exec, calls } = makeExec([[{ '?column?': 1 }]]);
    expect(await isItemSharedWith('folder', 'folder_1', 'user-2', exec)).toBe(true);
    expect(calls[0].text).toContain("item_type = 'folder'");
    expect(calls[0].params).toEqual(['folder_1', 'user-2']);
  });

  it('checks a timeline/markdown page against both its own invite and its folder', async () => {
    const { exec, calls } = makeExec([[{ '?column?': 1 }], [{ '?column?': 1 }]]);

    expect(await isItemSharedWith('timeline', 'tl_1', 'user-2', exec)).toBe(true);
    expect(calls[0].text).toContain('FROM timelines x');
    expect(calls[0].text).toContain("s.item_type = 'folder'");
    expect(calls[0].params).toEqual(['tl_1', 'user-2', 'timeline']);

    expect(await isItemSharedWith('markdownList', 'md_1', 'user-2', exec)).toBe(true);
    expect(calls[1].text).toContain('FROM markdown_lists x');
    expect(calls[1].params).toEqual(['md_1', 'user-2', 'markdownList']);
  });

  it('is false when nothing matches', async () => {
    const { exec } = makeExec([[]]);
    expect(await isItemSharedWith('timeline', 'tl_1', 'user-2', exec)).toBe(false);
  });
});
