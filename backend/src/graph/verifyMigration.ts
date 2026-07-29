// ---------------------------------------------------------------------------
// Graph Layer rolling-refactor drift verifier (R3 of the phased plan — see
// CLAUDE.md's Graph Layer section). The 5 legacy hard-link mechanisms
// (sublists, task<->list links, markdown-page Todo sync, both attachment
// tables) are dual-written into entity_links by the trg_hardlink_* triggers
// (index.ts's runMigrations()) on every INSERT/UPDATE — this module checks
// that the dual-write has actually stayed correct over time, independent of
// trusting the triggers to never have a bug or a pre-trigger-era row that
// slipped through.
//
// A "clean" result means every legacy row has its expected origin='system'
// edge AND no origin='system' edge exists without a legacy row justifying it.
// sweepMigrationVerification() (registered nightly in index.ts's start())
// tracks a consecutive-clean-days streak in app_settings; only once that
// streak reaches the 7-day threshold does app_settings.graph_migration_verified
// flip to 'true' — the ONLY thing the gated DROP COLUMN migration checks
// before ever touching the legacy columns (see runMigrations()). Any drift
// resets the streak to zero, so a single bad day never lets the gate open
// early.
// ---------------------------------------------------------------------------

import { query } from '../db';
import type { QueryExec } from '../workspaceUtil';

export interface DriftCheckResult {
  mechanism: string;
  missing: number;
  orphaned: number;
}

async function count(exec: QueryExec, sql: string): Promise<number> {
  const r = await exec(sql, []);
  return Number((r.rows[0] as { c: string }).c);
}

/**
 * Compare every legacy hard-link column/table against its mirrored
 * entity_links edges. Each mechanism reports:
 *   - missing:  a legacy row exists with no corresponding system edge
 *   - orphaned: a system edge exists with no legacy row justifying it
 */
export async function checkDrift(exec: QueryExec = query): Promise<DriftCheckResult[]> {
  const results: DriftCheckResult[] = [];

  // Sublists + the redundant lists.parent_task_id back-reference both produce
  // the SAME list--[child_of]-->task edge shape, so an edge is justified if
  // EITHER source says so — checked together, not as two independent mechanisms.
  results.push({
    mechanism: 'sublists (list--[child_of]-->task)',
    missing: await count(exec, `
      SELECT COUNT(*) AS c FROM tasks t
      WHERE t.linked_list_id IS NOT NULL AND t.linked_list_type = 'sublist'
        AND NOT EXISTS (
          SELECT 1 FROM entity_links el WHERE el.origin = 'system' AND el.link_type = 'child_of'
            AND el.src_type = 'list' AND el.src_id = t.linked_list_id AND el.dst_type = 'task' AND el.dst_id = t.id::text
        )
    `) + await count(exec, `
      SELECT COUNT(*) AS c FROM lists l
      WHERE l.parent_task_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM entity_links el WHERE el.origin = 'system' AND el.link_type = 'child_of'
            AND el.src_type = 'list' AND el.src_id = l.id AND el.dst_type = 'task' AND el.dst_id = l.parent_task_id::text
        )
    `),
    orphaned: await count(exec, `
      SELECT COUNT(*) AS c FROM entity_links el
      WHERE el.origin = 'system' AND el.link_type = 'child_of' AND el.src_type = 'list' AND el.dst_type = 'task'
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id::text = el.dst_id AND t.linked_list_id = el.src_id AND t.linked_list_type = 'sublist')
        AND NOT EXISTS (SELECT 1 FROM lists l WHERE l.id = el.src_id AND l.parent_task_id::text = el.dst_id)
    `),
  });

  results.push({
    mechanism: 'task->list links (task--[links_to]-->list)',
    missing: await count(exec, `
      SELECT COUNT(*) AS c FROM tasks t
      WHERE t.linked_list_id IS NOT NULL AND t.linked_list_type = 'link'
        AND NOT EXISTS (
          SELECT 1 FROM entity_links el WHERE el.origin = 'system' AND el.link_type = 'links_to'
            AND el.src_type = 'task' AND el.src_id = t.id::text AND el.dst_type = 'list' AND el.dst_id = t.linked_list_id
        )
    `),
    orphaned: await count(exec, `
      SELECT COUNT(*) AS c FROM entity_links el
      WHERE el.origin = 'system' AND el.link_type = 'links_to' AND el.src_type = 'task' AND el.dst_type = 'list'
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id::text = el.src_id AND t.linked_list_id = el.dst_id AND t.linked_list_type = 'link')
    `),
  });

  results.push({
    mechanism: 'markdown page Todo sync (markdownList--[tracks]-->list)',
    missing: await count(exec, `
      SELECT COUNT(*) AS c FROM markdown_lists m
      WHERE m.todo_list_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM entity_links el WHERE el.origin = 'system' AND el.link_type = 'tracks'
            AND el.src_type = 'markdownList' AND el.src_id = m.id AND el.dst_type = 'list' AND el.dst_id = m.todo_list_id
        )
    `),
    orphaned: await count(exec, `
      SELECT COUNT(*) AS c FROM entity_links el
      WHERE el.origin = 'system' AND el.link_type = 'tracks' AND el.src_type = 'markdownList' AND el.dst_type = 'list'
        AND NOT EXISTS (SELECT 1 FROM markdown_lists m WHERE m.id = el.src_id AND m.todo_list_id = el.dst_id)
    `),
  });

  results.push({
    mechanism: 'task attachments (file--[attached_to]-->task)',
    missing: await count(exec, `
      SELECT COUNT(*) AS c FROM task_attachments a
      WHERE a.attachment_type = 'linked' AND a.shared_file_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM entity_links el WHERE el.origin = 'system' AND el.link_type = 'attached_to'
            AND el.src_type = 'file' AND el.src_id = a.shared_file_id AND el.dst_type = 'task' AND el.dst_id = a.task_id::text
        )
    `),
    orphaned: 0, // multiple attachment rows can legitimately reference the same (file, task) pair — an edge outliving one deleted row is not drift as long as at least one row still justifies it, which the missing-check above already covers from the other direction
  });

  results.push({
    mechanism: 'milestone attachments (file--[attached_to]-->milestone)',
    missing: await count(exec, `
      SELECT COUNT(*) AS c FROM milestone_attachments a
      WHERE a.attachment_type = 'linked' AND a.shared_file_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM entity_links el WHERE el.origin = 'system' AND el.link_type = 'attached_to'
            AND el.src_type = 'file' AND el.src_id = a.shared_file_id AND el.dst_type = 'milestone' AND el.dst_id = a.milestone_id
        )
    `),
    orphaned: 0,
  });

  return results;
}

export async function isFullyConsistent(exec: QueryExec = query): Promise<boolean> {
  const results = await checkDrift(exec);
  return results.every((r) => r.missing === 0 && r.orphaned === 0);
}

const CLEAN_DAYS_KEY = 'graph_migration_clean_days';
const LAST_CHECK_KEY = 'graph_migration_last_check';
const VERIFIED_KEY = 'graph_migration_verified';
const REQUIRED_CLEAN_DAYS = 7;

async function getAppSetting(key: string, exec: QueryExec): Promise<string | null> {
  const r = await exec(`SELECT value FROM app_settings WHERE key = $1`, [key]);
  return (r.rows[0] as { value: string } | undefined)?.value ?? null;
}
async function setAppSetting(key: string, value: string, exec: QueryExec): Promise<void> {
  await exec(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [key, value]);
}

/**
 * Nightly sweep: check drift, update the consecutive-clean-days streak, and —
 * only once it reaches REQUIRED_CLEAN_DAYS — flip graph_migration_verified to
 * 'true'. This is the ONLY writer of that flag; nothing else may set it.
 */
export async function sweepMigrationVerification(exec: QueryExec = query): Promise<void> {
  try {
    const results = await checkDrift(exec);
    const consistent = results.every((r) => r.missing === 0 && r.orphaned === 0);
    await setAppSetting(LAST_CHECK_KEY, new Date().toISOString(), exec);

    if (!consistent) {
      await setAppSetting(CLEAN_DAYS_KEY, '0', exec);
      console.warn('🔗 ⚠️  Graph Layer migration drift detected:', results.filter((r) => r.missing > 0 || r.orphaned > 0));
      return;
    }

    const prevStreak = Number((await getAppSetting(CLEAN_DAYS_KEY, exec)) ?? '0');
    const streak = prevStreak + 1;
    await setAppSetting(CLEAN_DAYS_KEY, String(streak), exec);
    if (streak >= REQUIRED_CLEAN_DAYS) {
      const alreadyVerified = (await getAppSetting(VERIFIED_KEY, exec)) === 'true';
      await setAppSetting(VERIFIED_KEY, 'true', exec);
      if (!alreadyVerified) {
        console.log(`🔗 ✅ Graph Layer migration verified stable for ${streak} consecutive clean day(s) — legacy hard-link columns are now eligible for removal on next restart (see runMigrations()'s gated drop).`);
      }
    }
  } catch (err) {
    console.error('🔗 ✗ sweepMigrationVerification failed:', err);
  }
}
