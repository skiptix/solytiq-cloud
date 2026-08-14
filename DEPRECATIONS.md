# Deprecations

Tracks features/mechanisms that a newer, general mechanism has superseded but
that have **not yet been removed**, and the gate that has to open before they
can be. See `CLAUDE.md`'s "Graph Layer" section for the full architecture
this document assumes.

---

## Legacy hard-link columns (superseded by `entity_links`)

**Status: deprecated, not yet removable. No action needed from operators or
integrators — this is purely an internal implementation detail.**

The Graph Layer (`entity_index` + `entity_links`) was added as a generic,
queryable relationship system alongside 5 pre-existing hand-rolled
"hard-linking" mechanisms scattered across the schema. Rather than migrate
every read/write path in one risky change, the rollout is a **phased dual-write**:

| Phase | What it does | Status |
|---|---|---|
| R1 — Backfill | One-time, idempotent conversion of existing legacy rows into `origin='system'` edges | ✅ Done |
| R2 — Dual-write | DB triggers (`trg_hardlink_*` in `runMigrations()`) mirror every legacy-column write into `entity_links` in real time | ✅ Done |
| R3 — Drift verification | Nightly job (`graph/verifyMigration.ts`) checks the legacy columns and their mirrored edges never disagree | ✅ Running |
| R4 — Read-switch | Application code (routes, `aiTools.ts`, `templateUtil.ts`, …) stops reading/writing the legacy columns directly and uses `entity_links` instead | ❌ Not started |
| R5 — Column/trigger drop | Once R4 has been running stably, the now-fully-redundant columns and their sync triggers are dropped | ❌ Gated, cannot fire yet |

### The mechanisms

1. **Sublists** — `tasks.linked_list_id` + `linked_list_type='sublist'`, and the redundant back-reference `lists.parent_task_id` → mirrored as `list --[child_of]--> task`
2. **Task↔list links** — `tasks.linked_list_id` + `linked_list_type='link'` → mirrored as `task --[links_to]--> list`
3. **Markdown page ↔ Todo list sync** — `markdown_lists.todo_list_id` → mirrored as `markdownList --[tracks]--> list`
4. **Task attachments** (`'linked'` rows) → mirrored as `file --[attached_to]--> task`
5. **Milestone attachments** (`'linked'` rows) → mirrored as `file --[attached_to]--> milestone`

Mechanisms 1–3 are **pure reference columns** (`tasks.linked_list_id`/`linked_list_type`, `lists.parent_task_id`, `markdown_lists.todo_list_id`) — their entire value is fully reconstructable from `entity_links`, nothing else depends on their physical storage. Mechanisms 4–5 live in **real data tables** (`task_attachments`/`milestone_attachments` also hold `original_name`/`mime_type`/`file_size`/`file_path` for `'upload'`-type rows, which `entity_links` does not replace) — dropping those tables is a materially different, higher-risk operation and is **explicitly out of scope** for the gate described below, even after it opens. That would be its own dedicated, separately-reviewed migration.

### The gate

`runMigrations()` (`backend/src/index.ts`) contains a migration block, gated
behind **two** independently-set `app_settings` flags, that drops the 4
reference columns (mechanisms 1–3) and retires their `trg_hardlink_*`
triggers:

- **`graph_migration_verified`** — written *only* by `graph/verifyMigration.ts`'s
  nightly `sweepMigrationVerification()`, and only after **7 consecutive
  clean days** (zero drift between every legacy column and its mirrored
  edge). Any single day of drift resets the streak to zero.
- **`graph_links_v2`** — the **read-switch** flag. This one is not set
  anywhere by this codebase (yet) — it exists as the second key so the drop
  can never fire based on drift-verification alone. Setting it is meant to
  happen only once R4 (see table above) is actually complete: every
  read/write path that currently touches `linked_list_id`/`parent_task_id`/
  `todo_list_id` directly has been migrated to go through `entity_links`
  instead, and that's been running stably. **That migration has not been
  attempted** — it touches core CRUD across `routes/lists.ts`,
  `routes/markdownLists.ts`, `aiTools.ts`, `templateUtil.ts`, and more, and
  deserves its own focused, carefully-tested change rather than being
  bundled into the Graph Layer's initial rollout.

Until both flags are `'true'`, the drop block in `runMigrations()` is a
no-op `SELECT` on every startup — provably dead code today, not merely
disabled by convention.

### Checking status

```sql
SELECT key, value FROM app_settings
 WHERE key IN ('graph_migration_verified', 'graph_migration_clean_days', 'graph_migration_last_check', 'graph_links_v2');
```

Or call `checkDrift()` / `isFullyConsistent()` from `backend/src/graph/verifyMigration.ts` directly for a live report.

---

## MCP tool visibility (`AiTool.mcpOnly`)

Not a deprecation, but a related "don't remove this restriction" note: the
Agent Runtime meta-tools (`start_agent_run`, `get_agent_run`,
`list_agent_runs`, `list_agent_proposals`, `accept_agent_proposal`,
`reject_agent_proposal`) are flagged `mcpOnly: true` in `backend/src/aiTools.ts`
and are **deliberately excluded** from `getOpenRouterToolDefs()` — the tool
list both the internal "Sol" assistant and the Agent Runtime's own
tool-calling loop draw from. Removing that flag would let an agent run call
`start_agent_run` on itself with no bound beyond each new run's own separate
policy limits — an unbounded-fork risk. If a future change genuinely needs
an agent to spawn sub-runs, it needs a real recursion-depth guard first, not
just removing this flag.

---

## `react-hooks/set-state-in-effect` — resolved, back at `error`

This entry used to record a deliberate downgrade to `warn`. That downgrade is
gone: the rule is `error` in `frontend/eslint.config.js` and the codebase is
at zero findings. The entry is kept because the *shape* it describes is the
one a future contributor is most likely to re-introduce.

The rule (from the React Compiler rule set) fires on any synchronous
`setState` in an effect body. It found five genuine "you might not need an
effect" cases, all fixed — EntryInspector resets by `key` instead of ten
setters, UserSettingsModal clamps its tab at render, CommandPalette adjusts
during render, GPSMergeWizard derives both its file list and its gap modes.
Those were real: each painted one frame with the wrong value.

The other ~35 findings were a single shape, repeated across ~24 files:

```tsx
useEffect(() => {
  if (!id) { setData([]); return; }   // clear the PREVIOUS id's data
  setLoading(true);                    // drives the spinner
  fetchThing(id).then(r => setData(r));
}, [id]);
```

Both flagged statements are load-bearing, which is why the rule could not be
obeyed at each call site: remove the reset and the previous entity's data
stays on screen while the new request is in flight; move it into the
`.then()` and you get the same flash, just later.

**The fix was to stop writing that shape.** `frontend/src/hooks/useAsyncData.ts`
stores the key the data was fetched FOR, not just the data, so:

- `data` is the stored value only while its key still matches the current
  one, otherwise `initial` — that IS the guard-reset, with no frame where
  stale data shows against a new key;
- `loading` is "the current key has no settled result yet", which becomes
  true the instant the key changes without anyone setting it.

It also replaced three different hand-rolled spellings of cancellation
(`cancelled`, `alive`, `reqId.current`), takes `debounceMs` for the
search-as-you-type callers that had a `setTimeout` in the effect, and
`setData` for lists fetched once and then patched in place. Its tests
(`hooks/__tests__/useAsyncData.test.tsx`) pin the two behaviours that matter:
a key change clears the previous key's data in the SAME render, and a stale
response that resolves after a newer one is discarded.

**What still carries a disable, and why.** Twelve effects are not data loads
and each has a line-scoped disable next to a `NOTE (set-state-in-effect):`
comment giving its own reason:

| Site | Why it is not a data load |
|---|---|
| `SlashCommandInput` | A DOM measurement — `getBoundingClientRect()` cannot be read during render, and the reset must be synchronous with layout or the popover flashes at its old position. |
| `AutomationEditorScreen`, `MarkdownListScreen` | Seed EDITABLE buffers the user then types into. A key-derived `data` would discard their edits on the next render. The alternative is a child keyed on the loaded id so it remounts — a larger structural change than the rule warrants. |
| `GraphScreen`, `KnowledgeScreen` | Consume a one-shot signal (a store field, a URL param) and clear it. There is nothing to key on: the signal IS the event, and it is gone afterwards. |
| `FilesScreen` (upload wizard) | A drag/drop handoff — the files are already dropped when the wizard opens, and the upload starts here, so it cannot move into render. |
| `SharePage` (auto-preview) | Starts a side effect on entering a state: an unprotected file fetches bytes and mints a blob URL. `previewKind` deliberately stays `'none'` until a preview actually starts. |
| The five public share pages | Password-gated state MACHINES. One fetch picks between notfound / private / error / expired / password-required / ready, and the password branch waits for a credential nobody has typed yet. `data` derived from a key cannot express "which terminal state are we in". These are the app's only unauthenticated surface, so they keep the shape that has been verified. |

If you add a data-loading site, use `useAsyncData` — do not re-introduce the
effect shape above, and do not downgrade the rule again. A new finding is
now signal, not noise.
