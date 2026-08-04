// ---------------------------------------------------------------------------
// Sol's long-term memory (aiMemory.ts) — validation, the entry-count cap, and
// user-scoping on remove/clear.
//
// Uses the mock-QueryExec convention established by workspaceIntegrity.test.ts
// (see also aiSkillsData.test.ts): a tiny in-memory table, just enough SQL
// pattern-matching to drive aiMemory.ts's actual queries end-to-end.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import type { QueryExec } from '../workspaceUtil';
import { addMemory, removeMemory, clearMemory, listMemory, MAX_MEMORY_ENTRIES, MAX_MEMORY_CONTENT_LENGTH, type AiUserMemoryRow } from '../aiMemory';

function makeMemoryTableExec() {
  const rows: AiUserMemoryRow[] = [];
  let seq = 0;

  const exec: QueryExec = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();

    if (sql.startsWith('SELECT COUNT(*)::int AS n FROM ai_user_memory')) {
      const [userId] = params as [string];
      const n = rows.filter((r) => r.user_id === userId).length;
      return { rows: [{ n }], rowCount: 1 } as never;
    }

    if (sql.startsWith('INSERT INTO ai_user_memory')) {
      const [id, userId, content] = params as [string, string, string];
      seq += 1;
      const row: AiUserMemoryRow = {
        id, user_id: userId, content,
        created_at: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
        updated_at: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
      };
      rows.push(row);
      return { rows: [row], rowCount: 1 } as never;
    }

    if (sql.startsWith('SELECT * FROM ai_user_memory WHERE user_id')) {
      const [userId] = params as [string];
      const hits = rows.filter((r) => r.user_id === userId).sort((a, b) => a.created_at.localeCompare(b.created_at));
      return { rows: hits, rowCount: hits.length } as never;
    }

    if (sql.startsWith('DELETE FROM ai_user_memory WHERE id')) {
      const [id, userId] = params as [string, string];
      const idx = rows.findIndex((r) => r.id === id && r.user_id === userId);
      if (idx === -1) return { rows: [], rowCount: 0 } as never;
      rows.splice(idx, 1);
      return { rows: [], rowCount: 1 } as never;
    }

    if (sql.startsWith('DELETE FROM ai_user_memory WHERE user_id')) {
      const [userId] = params as [string];
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].user_id === userId) rows.splice(i, 1);
      return { rows: [], rowCount: before - rows.length } as never;
    }

    return { rows: [], rowCount: 0 } as never;
  }) as QueryExec;

  return { exec, rows };
}

describe('addMemory', () => {
  it('rejects empty content', async () => {
    const { exec } = makeMemoryTableExec();
    const result = await addMemory('user-1', '   ', exec);
    expect(result.ok).toBe(false);
  });

  it('rejects content over the max length', async () => {
    const { exec } = makeMemoryTableExec();
    const result = await addMemory('user-1', 'x'.repeat(MAX_MEMORY_CONTENT_LENGTH + 1), exec);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/too long/i);
  });

  it('trims content before saving', async () => {
    const { exec } = makeMemoryTableExec();
    const result = await addMemory('user-1', '  prefers metric units  ', exec);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.memory.content).toBe('prefers metric units');
  });

  it('rejects once the per-user cap is hit, without touching another user\'s room', async () => {
    const { exec } = makeMemoryTableExec();
    for (let i = 0; i < MAX_MEMORY_ENTRIES; i++) {
      const result = await addMemory('user-1', `fact ${i}`, exec);
      expect(result.ok).toBe(true);
    }
    const overCap = await addMemory('user-1', 'one too many', exec);
    expect(overCap.ok).toBe(false);
    if (!overCap.ok) expect(overCap.error).toMatch(/full/i);

    // A different user's own cap is untouched.
    const otherUser = await addMemory('user-2', 'first fact', exec);
    expect(otherUser.ok).toBe(true);
  });
});

describe('listMemory', () => {
  it('returns only the given user\'s entries, oldest first', async () => {
    const { exec } = makeMemoryTableExec();
    await addMemory('user-1', 'first', exec);
    await addMemory('user-2', 'someone else\'s fact', exec);
    await addMemory('user-1', 'second', exec);

    const rows = await listMemory('user-1', exec);
    expect(rows.map((r) => r.content)).toEqual(['first', 'second']);
  });
});

describe('removeMemory', () => {
  it('deletes an entry only when it belongs to the calling user', async () => {
    const { exec } = makeMemoryTableExec();
    const created = await addMemory('user-1', 'a fact', exec);
    if (!created.ok) throw new Error('setup failed');

    const wrongUser = await removeMemory('user-2', created.memory.id, exec);
    expect(wrongUser).toBe(false);

    const rightUser = await removeMemory('user-1', created.memory.id, exec);
    expect(rightUser).toBe(true);

    expect(await listMemory('user-1', exec)).toHaveLength(0);
  });
});

describe('clearMemory', () => {
  it('removes every entry for one user without touching another user\'s memory', async () => {
    const { exec } = makeMemoryTableExec();
    await addMemory('user-1', 'fact a', exec);
    await addMemory('user-1', 'fact b', exec);
    await addMemory('user-2', 'unrelated fact', exec);

    const cleared = await clearMemory('user-1', exec);
    expect(cleared).toBe(2);
    expect(await listMemory('user-1', exec)).toHaveLength(0);
    expect(await listMemory('user-2', exec)).toHaveLength(1);
  });
});
