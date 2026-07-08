# n8n-nodes-solytiq-cloud

This is an [n8n](https://n8n.io) community node package for **[Solytiq Cloud](https://github.com/skiptix/solytiq-cloud)** — the self-hosted productivity suite (task lists, timelines, workspaces, meetings and more).

It talks to the Solytiq Cloud **Admin API** (`/api/admin-read`) using an Admin API key, so a single credential can read the whole instance and create, update or delete content on behalf of any user.

The package ships two nodes:

- **Solytiq Cloud** — action node covering every Admin API endpoint (also usable as an AI agent tool)
- **Solytiq Cloud Trigger** — polling trigger that starts a workflow when something is created (or updated) in your instance

## Installation

In n8n go to **Settings → Community Nodes → Install** and enter:

```
n8n-nodes-solytiq-cloud
```

Or install manually in a self-hosted n8n:

```bash
npm install n8n-nodes-solytiq-cloud
```

See the [n8n community node installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) for details.

## Credentials

1. In Solytiq Cloud, open **Settings → Admin API keys** (admin account required) and create a key.
2. Select the **scopes** the key should have — each node operation needs the matching scope (see the table below). Include the **read** scope: it powers the instance export, all dropdowns, and the credential test.
3. In n8n, create a **Solytiq Cloud API** credential:
   - **Base URL** — your instance origin, e.g. `https://cloud.example.com` (no `/api`)
   - **API Token** — the Admin API key

## Solytiq Cloud node — resources & operations

| Resource | Operations | Required key scope |
|---|---|---|
| **Export** | Get (full instance export, filterable by workspace / user) | `read` |
| **User** | Create, Update, Delete | `users` |
| **Workspace** | Create, Update, Delete | `workspaces` |
| **Folder** | Create, Update, Delete | `folders` |
| **List** | Create, Update (name/emoji/visibility), Delete (soft delete → trash, 30-day restore) | `lists` |
| **Section** | Create (inside a list) | `lists` |
| **Item** (task) | Create (on the dashboard or in a list section), Update (title, deadline, priority, note, checked), Delete | `lists` |
| **Timeline** | Create, Update, Delete (soft delete → trash) | `timelines` |
| **Milestone** | Create (on a timeline), Update, Delete | `timelines` |
| **Meeting** | Create, Update, Delete | `meetings` |

### Dynamic dropdowns

Every ID field is a searchable dropdown loaded live from your instance: users, workspaces, folders, lists, sections (filtered to the selected list), items, timelines, milestones and meetings. You can always switch any of them to an expression and pass an ID from a previous node instead. The dropdowns call the export endpoint, so they need a key with the `read` scope.

### Acting on behalf of a user

Create operations accept an optional **Owner** — the user who will own the new workspace/folder/list/item/timeline/meeting. When left on *API Key Creator (Default)*, content is created for the admin who created the API key. Workspace-scoped resources also accept an optional **Workspace**; when omitted, the owner's *Personal* workspace is used.

### Good to know

- **Item create — Add To:** *Dashboard* creates a standalone dashboard task; *List Section* requires picking a list and one of its sections (the section dropdown follows the selected list). List items inherit the list's workspace.
- **Meeting update replaces optional fields:** the API overwrites *Description, Location, Start Time, End Time* and *Color* on every update — any of those you don't set are cleared on the meeting. *Title, Date* and *All Day* keep their current value when omitted.
- **Workspace delete** is refused while the workspace still contains lists, folders or timelines (HTTP 409).
- **List / Timeline delete** are soft deletes — the content moves to the owner's trash with a 30-day restore window. Folder, item, milestone, meeting and user deletes are permanent.
- Dates are `YYYY-MM-DD` strings, times are 24-hour `HH:MM` strings — matching what the Solytiq Cloud UI stores.
- Changing a user's password signs that user out of all sessions.
- The node is marked **usable as a tool**, so AI Agent nodes can call it directly.

## Solytiq Cloud Trigger node

A polling trigger (you choose the poll interval in n8n). Pick:

- **Resource** — Folder, Item, List, Meeting, Milestone, Timeline, User or Workspace
- **Event** — *Created*, or *Created or Updated* (update detection is available for Items and Meetings, which expose an update timestamp)
- **Filters** — optionally narrow to one workspace and/or one user

On each poll the node fetches the instance export and emits every row whose timestamp is newer than the previous poll. Executing the trigger manually returns the 10 most recent rows so you can inspect the data shape while building. The API key needs the `read` scope.

## Compatibility

- Requires n8n 1.x and Node.js ≥ 20.
- Tested against the Solytiq Cloud Admin API as of v1.14.

## Version history

### 0.2.0

- Full rewrite of the action node: all create/update operations now send their request bodies (0.1.x shipped operations without any input fields).
- Dynamic dropdowns for users, workspaces, folders, lists, sections, items, timelines, milestones and meetings — everywhere an ID is needed.
- New **Export** filters (workspace / user), **Owner** selection on create operations, and dashboard-vs-list item placement.
- Rewrote the trigger node into a working polling trigger (created / created-or-updated events with workspace & user filters); 0.1.x's trigger failed to load.
- Credential test, bundled node icon, and this README.

### 0.1.1 / 0.1.0

- Initial release (scaffold).

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
- [Solytiq Cloud](https://github.com/skiptix/solytiq-cloud)

## Maintaining this package

This directory (`n8n/` in the `solytiq-cloud` repo) is the source of truth for the published `n8n-nodes-solytiq-cloud` npm package. It is kept in sync with `backend/src/routes/adminReadApi.ts` — see `CLAUDE.md` at the repo root for the synchronization rule.

To cut a new release:

```bash
cd n8n
npm install
npm run build     # tsc -> dist/, then copies the node icons
npm test           # node smoke-test.mjs — exercises execute()/poll()/loadOptions against a mock Admin API
# bump "version" in package.json (semver), update the README's Version History section
npm publish
```

`npm publish` needs an npm auth token with publish rights on `n8n-nodes-solytiq-cloud`. Provide it via `NPM_TOKEN` (env var or repo `.env`) and either export it as `NODE_AUTH_TOKEN`/`npm config set //registry.npmjs.org/:_authToken=$NPM_TOKEN`, or ask the user for one if it isn't set.

## License

[MIT](LICENSE.md)
