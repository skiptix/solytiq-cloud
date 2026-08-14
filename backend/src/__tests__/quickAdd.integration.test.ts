// ---------------------------------------------------------------------------
// Quick Add — live-Postgres, live-HTTP end-to-end test of the staging tray and
// the placement predictor.
//
// This file exists for the things a mock QueryExec cannot prove:
//
//   * The pg_trgm `similarity()` / `word_similarity()` channels actually match
//     what they're supposed to, against real indexes and real thresholds. A
//     mocked exec can only assert the SQL was ISSUED, not that it retrieves.
//   * The "only the LAST section" rule survives real UPSERT semantics — the
//     unit tests assert the statement's shape, this asserts the table's
//     contents after a genuine sequence of moves.
//   * A staged item (section_id IS NULL) round-trips through the real list
//     payload builders into `stagedTasks`, rather than vanishing the way an
//     orphaned task used to.
//
// Same live-DB convention as objectPolicy.integration.test.ts — env vars set
// before any dynamic import, SKIPPED (not passed) if no database is reachable.
// ---------------------------------------------------------------------------

import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.PGHOST     = process.env.TEST_PGHOST     ?? 'localhost';
process.env.PGPORT     = process.env.TEST_PGPORT     ?? '5432';
process.env.PGDATABASE = process.env.TEST_PGDATABASE ?? 'solytiq_test';
process.env.PGUSER     = process.env.TEST_PGUSER     ?? 'solytiq_test';
process.env.PGPASSWORD = process.env.TEST_PGPASSWORD ?? 'solytiq_test_pw';

let dbAvailable = false;
let pool: typeof import('../db').pool;

try {
  const dbMod = await import('../db');
  pool = dbMod.pool;
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch (err) {
  console.warn(`⚠️  quickAdd.integration.test.ts: no reachable Postgres — every test in this file is SKIPPED, not passed. (${(err as Error)?.message})`);
}

describe.skipIf(!dbAvailable)('Quick Add — staging tray + placement prediction', () => {
  let server: http.Server;
  let baseUrl: string;
  let token: string;

  const userId = 'a0000000-0000-4000-8000-0000000000a1';
  const wsId = 'ws_test_quick_add';
  const listId = 'list_test_quick_add';
  const secTodo = 'sec_qa_todo';
  const secDoing = 'sec_qa_doing';
  const secDone = 'sec_qa_done';

  beforeAll(async () => {
    // Locked entry point, not raw runMigrations() — concurrent test files
    // otherwise race DDL on the shared solytiq_test database.
    const { runAllMigrations } = await import('../migrations');
    await runAllMigrations();

    const express = (await import('express')).default;
    const listsRouter = (await import('../routes/lists')).default;
    const { generateToken, hashPassword } = await import('../auth');

    await pool.query(`DELETE FROM lists WHERE id = $1`, [listId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [wsId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);

    const pw = await hashPassword('irrelevant-for-this-test-x');
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, full_name, is_admin)
       VALUES ($1, 'quickadd_owner', 'quickadd@test.local', $2, 'Quick Add Owner', false)`,
      [userId, pw]
    );
    token = generateToken(userId, 0);

    await pool.query(`INSERT INTO workspaces (id, name, visibility, owner_id) VALUES ($1, 'Quick Add WS', 'private', $2)`, [wsId, userId]);
    await pool.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [wsId, userId]);
    await pool.query(
      `INSERT INTO lists (id, user_id, name, is_public, workspace_id, quick_add_enabled) VALUES ($1, $2, 'Sprint', false, $3, true)`,
      [listId, userId, wsId]
    );
    await pool.query(
      `INSERT INTO sections (id, list_id, label, position) VALUES ($1, $4, 'To do', 0), ($2, $4, 'Doing', 1), ($3, $4, 'Done', 2)`,
      [secTodo, secDoing, secDone, listId]
    );

    const app = express();
    app.use(express.json());
    app.use('/api/lists', listsRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM lists WHERE id = $1`, [listId]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [wsId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  // A function, not a constant: the describe body runs BEFORE beforeAll, so a
  // header object built here would capture `token` while it is still undefined.
  const auth = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

  const quickAdd = (title: string) =>
    fetch(`${baseUrl}/api/lists/${listId}/quick-add/items`, { method: 'POST', headers: auth(), body: JSON.stringify({ title }) });
  const predict = (title: string) =>
    fetch(`${baseUrl}/api/lists/${listId}/quick-add/predict`, { method: 'POST', headers: auth(), body: JSON.stringify({ title, lexicalOnly: true }) });
  const moveTo = (taskId: string, sectionId: string) =>
    fetch(`${baseUrl}/api/lists/${listId}/tasks/${taskId}`, { method: 'PUT', headers: auth(), body: JSON.stringify({ sectionId }) });

  it('creates a Quick Add item in the staging tray, not in any section', async () => {
    const res = await quickAdd('Fix login bug');
    expect(res.status).toBe(201);
    const body = await res.json() as { task: { id: string; sectionId: string | null } };
    expect(body.task.sectionId).toBeNull();

    const row = await pool.query(`SELECT section_id, list_id FROM tasks WHERE id = $1`, [body.task.id]);
    expect(row.rows[0]).toMatchObject({ section_id: null, list_id: listId });
  });

  it('surfaces staged items in the list payload as stagedTasks — they are not lost', async () => {
    const { getListForUser } = await import('../routes/lists');
    const list = await getListForUser(userId, listId);
    expect(list?.stagedTasks.map((t) => t.title)).toContain('Fix login bug');
    // And they're not silently duplicated into a section.
    expect(list?.sections.flatMap((s) => s.tasks).map((t) => t.title)).not.toContain('Fix login bug');
  });

  it('counts staged items in the board\'s progress totals', async () => {
    const { getListForUser } = await import('../routes/lists');
    const list = await getListForUser(userId, listId);
    expect(list?.linkedProgress?.total).toBeGreaterThan(0);
  });

  it('learns from a real move and predicts that section for the same item next time', async () => {
    const created = await (await quickAdd('Refactor the auth module')).json() as { task: { id: string } };
    expect((await moveTo(created.task.id, secDoing)).status).toBe(200);

    const memory = await pool.query(`SELECT last_section_id FROM section_memory WHERE list_id = $1 AND title_key = $2`, [listId, 'refactor the auth module']);
    expect(memory.rows[0]?.last_section_id).toBe(secDoing);

    const { suggestions } = await (await predict('Refactor the auth module')).json() as { suggestions: Array<{ sectionId: string; confidence: number }> };
    expect(suggestions[0]?.sectionId).toBe(secDoing);
    expect(suggestions[0]?.confidence).toBeGreaterThan(0);
  });

  it('matches a re-typed title through real trigram similarity, not just an exact hit', async () => {
    // Never seen verbatim; shares wording with the remembered item above.
    const { suggestions } = await (await predict('Refactor auth module again')).json() as { suggestions: Array<{ sectionId: string }> };
    expect(suggestions[0]?.sectionId).toBe(secDoing);
  });

  it('normalizes case/punctuation, so a differently-typed repeat still matches', async () => {
    const { suggestions } = await (await predict('REFACTOR THE AUTH MODULE!!')).json() as { suggestions: Array<{ sectionId: string }> };
    expect(suggestions[0]?.sectionId).toBe(secDoing);
  });

  it('uses ONLY the last section after a chain of moves — earlier ones must not vote', async () => {
    const created = await (await quickAdd('Ship the release notes')).json() as { task: { id: string } };
    await moveTo(created.task.id, secTodo);
    await moveTo(created.task.id, secDoing);
    await moveTo(created.task.id, secDone);

    // The projection holds exactly one row, naming the LAST section.
    const memory = await pool.query(
      `SELECT last_section_id, occurrences FROM section_memory WHERE list_id = $1 AND title_key = $2`,
      [listId, 'ship the release notes']
    );
    expect(memory.rows).toHaveLength(1);
    expect(memory.rows[0].last_section_id).toBe(secDone);

    // The full journey IS still recorded — it's just kept out of the predictor.
    const history = await pool.query(
      `SELECT to_section_id FROM section_placement_events WHERE list_id = $1 AND title_key = $2 ORDER BY id ASC`,
      [listId, 'ship the release notes']
    );
    expect(history.rows.map((r: { to_section_id: string | null }) => r.to_section_id)).toEqual([null, secTodo, secDoing, secDone]);

    // And the suggestion follows the projection, not the history.
    const { suggestions } = await (await predict('Ship the release notes')).json() as { suggestions: Array<{ sectionId: string }> };
    expect(suggestions[0].sectionId).toBe(secDone);
    expect(suggestions.map((s) => s.sectionId)).not.toContain(secTodo);
  });

  it('keeps remembering an item after it is deleted — the board learned from it either way', async () => {
    const created = await (await quickAdd('Cancel the vendor contract')).json() as { task: { id: string } };
    await moveTo(created.task.id, secDone);
    const del = await fetch(`${baseUrl}/api/lists/${listId}/tasks/${created.task.id}`, { method: 'DELETE', headers: auth() });
    expect(del.status).toBe(200);

    expect((await pool.query(`SELECT 1 FROM tasks WHERE id = $1`, [created.task.id])).rows).toHaveLength(0);
    const { suggestions } = await (await predict('Cancel the vendor contract')).json() as { suggestions: Array<{ sectionId: string }> };
    expect(suggestions[0]?.sectionId).toBe(secDone);
  });

  it('returns no suggestion for an item unlike anything the board has seen', async () => {
    const { suggestions } = await (await predict('zzqx wibble frobnicate')).json() as { suggestions: unknown[] };
    expect(suggestions).toEqual([]);
  });

  it('drops a memory whose section was deleted rather than suggesting somewhere unreachable', async () => {
    const tmpSection = 'sec_qa_temp';
    await pool.query(`INSERT INTO sections (id, list_id, label, position) VALUES ($1, $2, 'Temp', 3)`, [tmpSection, listId]);
    const created = await (await quickAdd('Archive the old designs')).json() as { task: { id: string } };
    await moveTo(created.task.id, tmpSection);
    expect((await pool.query(`SELECT 1 FROM section_memory WHERE list_id = $1 AND title_key = 'archive the old designs'`, [listId])).rows).toHaveLength(1);

    await pool.query(`DELETE FROM sections WHERE id = $1`, [tmpSection]);
    expect((await pool.query(`SELECT 1 FROM section_memory WHERE list_id = $1 AND title_key = 'archive the old designs'`, [listId])).rows).toHaveLength(0);

    const { suggestions } = await (await predict('Archive the old designs')).json() as { suggestions: unknown[] };
    expect(suggestions).toEqual([]);
  });

  it('moves a staged item into a section when the suggestion is accepted, and back out again', async () => {
    const created = await (await quickAdd('Update the changelog')).json() as { task: { id: string } };
    await moveTo(created.task.id, secTodo);
    expect((await pool.query(`SELECT section_id FROM tasks WHERE id = $1`, [created.task.id])).rows[0].section_id).toBe(secTodo);

    // Dragging it back to the tray — `sectionId: null` can't express this, so
    // the route takes an explicit `stage` flag.
    const back = await fetch(`${baseUrl}/api/lists/${listId}/tasks/${created.task.id}`, {
      method: 'PUT', headers: auth(), body: JSON.stringify({ stage: true }),
    });
    expect(back.status).toBe(200);
    expect((await pool.query(`SELECT section_id FROM tasks WHERE id = $1`, [created.task.id])).rows[0].section_id).toBeNull();

    // Un-filing does NOT erase what the board learned.
    const memory = await pool.query(`SELECT last_section_id FROM section_memory WHERE list_id = $1 AND title_key = 'update the changelog'`, [listId]);
    expect(memory.rows[0]?.last_section_id).toBe(secTodo);
  });

  it('gives the board a Knowledge Base bubble holding its learned placements', async () => {
    const { ensureBubble, syncBubble } = await import('../quickAdd/kbBubble');

    // Creates the workspace's Knowledge Base too if it doesn't have one — a
    // user shouldn't need to know the Knowledge Base exists to flip a board setting.
    const entryId = await ensureBubble({ listId, listName: 'Sprint', workspaceId: wsId, userId });
    expect(entryId).toBeTruthy();
    expect((await pool.query(`SELECT 1 FROM knowledge_bases WHERE workspace_id = $1`, [wsId])).rows).toHaveLength(1);

    // Idempotent — a second enable must not mint a second bubble.
    expect(await ensureBubble({ listId, listName: 'Sprint', workspaceId: wsId, userId })).toBe(entryId);
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM knowledge_entries WHERE properties->>'listId' = $1`, [listId])).rows[0].n).toBe(1);

    await syncBubble(listId);
    const entry = await pool.query<{ term: string; summary: string; content: { blocks: Array<{ type: string; rows?: Array<{ cells: string[] }> }> }; origin: string }>(
      `SELECT term, summary, content, origin FROM knowledge_entries WHERE id = $1`, [entryId!]
    );
    const row = entry.rows[0];
    expect(row.term).toContain('Sprint');
    // Machine-derived, so the inspector badges it "Scanned" rather than
    // presenting it as something a person wrote or Sol authored.
    expect(row.origin).toBe('extracted');
    expect(row.summary).toMatch(/remembers where \d+ items? belongs?/);

    // The learned placements are rendered as a readable table, not a blob.
    const table = row.content.blocks.find((b) => b.type === 'table');
    expect(table).toBeDefined();
    expect(table!.rows![0].cells).toEqual(['Item', 'Last section', 'Times placed', 'Last seen']);
    const rendered = table!.rows!.slice(1).map((r) => r.cells[0]);
    expect(rendered).toContain('Refactor the auth module');

    // It's linked to the board it describes, so it renders beside it on the net.
    const link = await pool.query(
      `SELECT link_type FROM entity_links WHERE src_type = 'knowledgeEntry' AND src_id = $1 AND dst_type = 'list' AND dst_id = $2`,
      [entryId!, listId]
    );
    expect(link.rows[0]?.link_type).toBe('defines');
  });

  it('marks the board dirty on a placement, and the sweep reconciles the bubble', async () => {
    const created = await (await quickAdd('Draft the Q3 roadmap')).json() as { task: { id: string } };
    await moveTo(created.task.id, secTodo);
    expect((await pool.query(`SELECT quick_add_memory_dirty FROM lists WHERE id = $1`, [listId])).rows[0].quick_add_memory_dirty).toBe(true);

    const { sweepDirtyBubbles } = await import('../quickAdd/kbBubble');
    expect(await sweepDirtyBubbles()).toBeGreaterThan(0);
    expect((await pool.query(`SELECT quick_add_memory_dirty FROM lists WHERE id = $1`, [listId])).rows[0].quick_add_memory_dirty).toBe(false);

    const entry = await pool.query<{ content: { blocks: Array<{ type: string; rows?: Array<{ cells: string[] }> }> } }>(
      `SELECT content FROM knowledge_entries WHERE properties->>'listId' = $1`, [listId]
    );
    const table = entry.rows[0].content.blocks.find((b) => b.type === 'table');
    expect(table!.rows!.slice(1).map((r) => r.cells[0])).toContain('Draft the Q3 roadmap');
  });

  it('keeps predicting after its bubble is deleted — the dictionary entry is a mirror, not the source', async () => {
    await pool.query(`DELETE FROM knowledge_entries WHERE properties->>'listId' = $1`, [listId]);
    const { suggestions } = await (await predict('Refactor the auth module')).json() as { suggestions: Array<{ sectionId: string }> };
    expect(suggestions[0]?.sectionId).toBe(secDoing);
  });

  it('refuses Quick Add on a board the caller cannot write to', async () => {
    const { generateToken, hashPassword } = await import('../auth');
    const outsider = 'a0000000-0000-4000-8000-0000000000a2';
    await pool.query(
      `INSERT INTO users (id, username, email, password_hash, full_name, is_admin)
       VALUES ($1, 'quickadd_outsider', 'quickadd-out@test.local', $2, 'Outsider', false)
       ON CONFLICT (id) DO NOTHING`,
      [outsider, await hashPassword('irrelevant-for-this-test-x')]
    );
    const res = await fetch(`${baseUrl}/api/lists/${listId}/quick-add/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${generateToken(outsider, 0)}` },
      body: JSON.stringify({ title: 'Should never be created' }),
    });
    expect(res.status).toBe(403);
    await pool.query(`DELETE FROM users WHERE id = $1`, [outsider]);
  });
});
