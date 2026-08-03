// ---------------------------------------------------------------------------
// AI Skills data layer (aiSkills/skills.ts) — slug generation/uniqueness,
// validation, and the admin-check helper every mutation tool re-derives from.
//
// Uses the mock-QueryExec convention established by workspaceIntegrity.test.ts
// (see also knowledgeBase.test.ts): a tiny in-memory table so slug-uniqueness
// and round-trip behavior are exercised for real, without a live database.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from 'vitest';
import type { QueryExec } from '../workspaceUtil';
import {
  createSkill, updateSkill, isUserAdmin, setSkillFile,
  type AiSkillRow,
} from '../aiSkills/skills';

/** A minimal in-memory `ai_skills` table behind a QueryExec, just enough SQL
 *  pattern-matching to drive skills.ts's actual queries end-to-end. */
function makeSkillsTableExec() {
  const rows: AiSkillRow[] = [];
  let seq = 0;

  const exec: QueryExec = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();

    if (sql.startsWith('SELECT 1 FROM ai_skills WHERE slug')) {
      const [slug, excludeId] = params as [string, string | undefined];
      const hit = rows.find((r) => r.slug === slug && (excludeId === undefined || r.id !== excludeId));
      return { rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 } as never;
    }

    if (sql.startsWith('INSERT INTO ai_skills')) {
      const [id, name, slug, description, content, source, origin, createdBy] = params as [
        string, string, string, string, string, string, string, string | null
      ];
      const row: AiSkillRow = {
        id, name, slug, description, content,
        enabled: true, source: source as AiSkillRow['source'], origin: origin as AiSkillRow['origin'],
        created_by: createdBy, updated_by: createdBy, version: 1,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        file_count: 0,
      };
      rows.push(row);
      return { rows: [row], rowCount: 1 } as never;
    }

    if (sql.startsWith('SELECT s.*') && sql.includes('WHERE s.id = $1')) {
      const [id] = params as [string];
      const hit = rows.find((r) => r.id === id);
      return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 } as never;
    }

    if (sql.startsWith('UPDATE ai_skills SET')) {
      // Last param is always the id (see skills.ts's `push` accumulator).
      const id = params[params.length - 1] as string;
      const row = rows.find((r) => r.id === id);
      if (!row) return { rows: [], rowCount: 0 } as never;
      // Reconstruct field order from the generated SET clause.
      const setCols = [...sql.matchAll(/(\w+) = \$(\d+)/g)].filter((m) => m[1] !== 'version');
      for (const [, col, idx] of setCols) {
        const val = params[Number(idx) - 1];
        (row as unknown as Record<string, unknown>)[col] = val;
      }
      row.version += 1;
      return { rows: [row], rowCount: 1 } as never;
    }

    if (sql.startsWith('SELECT is_admin FROM users')) {
      const [id] = params as [string];
      return { rows: [{ is_admin: id === 'admin-1' }], rowCount: 1 } as never;
    }

    return { rows: [], rowCount: 0 } as never;
  }) as QueryExec;

  return { exec, rows };
}

describe('createSkill', () => {
  it('rejects an empty name', async () => {
    const { exec } = makeSkillsTableExec();
    const result = await createSkill({ name: '', content: 'body' }, exec);
    expect(result.ok).toBe(false);
  });

  it('rejects empty content — a skill with no instructions is not a skill', async () => {
    const { exec } = makeSkillsTableExec();
    const result = await createSkill({ name: 'My Skill', content: '   ' }, exec);
    expect(result.ok).toBe(false);
  });

  it('slugifies the name', async () => {
    const { exec } = makeSkillsTableExec();
    const result = await createSkill({ name: 'Weekly Report Formatting!', content: 'body' }, exec);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skill.slug).toBe('weekly-report-formatting');
  });

  it('disambiguates a colliding slug rather than erroring', async () => {
    const { exec } = makeSkillsTableExec();
    const first = await createSkill({ name: 'Onboarding', content: 'body one' }, exec);
    const second = await createSkill({ name: 'Onboarding', content: 'body two' }, exec);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.skill.slug).toBe('onboarding');
      expect(second.skill.slug).toBe('onboarding-2');
      expect(first.skill.id).not.toBe(second.skill.id);
    }
  });

  it('defaults a new skill to enabled', async () => {
    const { exec } = makeSkillsTableExec();
    const result = await createSkill({ name: 'A Skill', content: 'body' }, exec);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skill.enabled).toBe(true);
  });
});

describe('updateSkill', () => {
  it('re-slugs when the name changes, keeping the old slug free for reuse', async () => {
    const { exec } = makeSkillsTableExec();
    const created = await createSkill({ name: 'Old Name', content: 'body' }, exec);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const updated = await updateSkill(created.skill.id, { name: 'New Name' }, exec);
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.skill.slug).toBe('new-name');
  });

  it('rejects clearing content to empty', async () => {
    const { exec } = makeSkillsTableExec();
    const created = await createSkill({ name: 'A Skill', content: 'body' }, exec);
    if (!created.ok) throw new Error('setup failed');
    const updated = await updateSkill(created.skill.id, { content: '   ' }, exec);
    expect(updated.ok).toBe(false);
  });

  it('can disable and re-enable a skill', async () => {
    const { exec } = makeSkillsTableExec();
    const created = await createSkill({ name: 'A Skill', content: 'body' }, exec);
    if (!created.ok) throw new Error('setup failed');
    const disabled = await updateSkill(created.skill.id, { enabled: false }, exec);
    expect(disabled.ok && disabled.skill.enabled === false).toBe(true);
    const reenabled = await updateSkill(created.skill.id, { enabled: true }, exec);
    expect(reenabled.ok && reenabled.skill.enabled === true).toBe(true);
  });

  it('reports "Skill not found" for a nonexistent id', async () => {
    const { exec } = makeSkillsTableExec();
    const result = await updateSkill('nope', { name: 'X' }, exec);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found/i);
  });
});

describe('isUserAdmin', () => {
  it('reflects users.is_admin for the given userId, never trusting anything else', async () => {
    const { exec } = makeSkillsTableExec();
    expect(await isUserAdmin('admin-1', exec)).toBe(true);
    expect(await isUserAdmin('user-1', exec)).toBe(false);
  });
});

describe('setSkillFile', () => {
  it('rejects a path traversal attempt', async () => {
    const exec: QueryExec = (async () => ({ rows: [], rowCount: 0 })) as unknown as QueryExec;
    const result = await setSkillFile('skill_1', '../../etc/passwd', 'evil', exec);
    expect(result.ok).toBe(false);
  });

  it('rejects an oversized file', async () => {
    const exec: QueryExec = (async () => ({ rows: [], rowCount: 0 })) as unknown as QueryExec;
    const huge = 'x'.repeat(300 * 1024);
    const result = await setSkillFile('skill_1', 'reference/huge.md', huge, exec);
    expect(result.ok).toBe(false);
  });
});
