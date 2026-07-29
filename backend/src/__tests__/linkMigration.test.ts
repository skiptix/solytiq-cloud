import { describe, expect, it, vi } from 'vitest';
import { backfillHardLinks } from '../graph/backfill';
import type { QueryExec } from '../workspaceUtil';

function makeExec() {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const exec = vi.fn(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
  }) as unknown as QueryExec;
  return { exec, calls };
}

// backfillHardLinks materializes the 5 pre-existing hard-link mechanisms
// (sublists, task↔list links, the parent_task_id redundancy, markdown-page
// Todo sync, and the two attachment tables) as real entity_links rows. Every
// statement MUST be idempotent (ON CONFLICT DO NOTHING against the unique
// index) since runMigrations() re-runs this on every backend startup.

describe('backfillHardLinks', () => {
  it('issues one statement per hard-link mechanism, all idempotent', async () => {
    const { exec, calls } = makeExec();
    await backfillHardLinks(exec);

    // 6 sources: sublist child_of, task links_to, parent_task_id child_of,
    // markdown tracks, task attachments, milestone attachments, + 2 structural
    // part_of statements (milestone→timeline, task→list) = 8 total.
    expect(calls.length).toBe(8);
    for (const call of calls) {
      expect(call.text).toContain('ON CONFLICT DO NOTHING');
      expect(call.text).toContain('INSERT INTO entity_links');
    }
  });

  it('backfills sublists as list --[child_of]--> task, from tasks.linked_list_id', async () => {
    const { exec, calls } = makeExec();
    await backfillHardLinks(exec);
    const stmt = calls.find((c) => c.text.includes("'child_of'") && c.text.includes('linked_list_type'));
    expect(stmt).toBeDefined();
    expect(stmt!.text).toContain("'list', t.linked_list_id, 'task', t.id::text");
    expect(stmt!.text).toContain("t.linked_list_type = 'sublist'");
  });

  it('backfills plain task→list references as links_to', async () => {
    const { exec, calls } = makeExec();
    await backfillHardLinks(exec);
    const stmt = calls.find((c) => c.text.includes("'links_to'"));
    expect(stmt).toBeDefined();
    expect(stmt!.text).toContain("'task', t.id::text, 'list', t.linked_list_id");
    expect(stmt!.text).toContain("t.linked_list_type = 'link'");
  });

  it('backfills the markdown-page Todo-list sync as tracks', async () => {
    const { exec, calls } = makeExec();
    await backfillHardLinks(exec);
    const stmt = calls.find((c) => c.text.includes("'tracks'"));
    expect(stmt).toBeDefined();
    expect(stmt!.text).toContain('markdown_lists m');
    expect(stmt!.text).toContain('m.todo_list_id');
  });

  it('backfills BOTH attachment tables as attached_to, file → owning entity', async () => {
    const { exec, calls } = makeExec();
    await backfillHardLinks(exec);
    const attachStmts = calls.filter((c) => c.text.includes("'attached_to'"));
    expect(attachStmts).toHaveLength(2);
    expect(attachStmts.some((c) => c.text.includes('task_attachments'))).toBe(true);
    expect(attachStmts.some((c) => c.text.includes('milestone_attachments'))).toBe(true);
    // Direction: the FILE is the source, the task/milestone the destination.
    for (const c of attachStmts) {
      expect(c.text).toMatch(/'file', a\.shared_file_id, '(task|milestone)'/);
    }
  });

  it('backfills structural part_of edges from existing FKs, hidden from the graph view by convention (checked in linkTypes.ts)', async () => {
    const { exec, calls } = makeExec();
    await backfillHardLinks(exec);
    const partOfStmts = calls.filter((c) => c.text.includes("'part_of'"));
    expect(partOfStmts).toHaveLength(2);
    expect(partOfStmts.some((c) => c.text.includes('milestones ms') && c.text.includes('timelines tl'))).toBe(true);
    expect(partOfStmts.some((c) => c.text.includes("t.source = 'list'"))).toBe(true);
  });

  it('every generated link id is prefixed "lnk_" via gen_random_uuid(), matching the app-level id convention', async () => {
    const { exec, calls } = makeExec();
    await backfillHardLinks(exec);
    for (const call of calls) {
      expect(call.text).toContain("'lnk_' || gen_random_uuid()");
    }
  });

  it('is a no-op the second time it runs against an unchanged database (idempotency contract)', async () => {
    const { exec, calls } = makeExec();
    await backfillHardLinks(exec);
    const firstRunCount = calls.length;
    await backfillHardLinks(exec);
    // Same statements issued again — DB-side ON CONFLICT DO NOTHING is what
    // actually makes re-running a no-op; here we assert the statements
    // themselves are unconditionally safe to repeat (no non-idempotent DDL,
    // no counters, no state mutated between calls).
    expect(calls.length).toBe(firstRunCount * 2);
    expect(calls.slice(0, firstRunCount).map((c) => c.text)).toEqual(calls.slice(firstRunCount).map((c) => c.text));
  });
});
