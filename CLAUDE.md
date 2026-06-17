# CLAUDE.md — Solytiq Cloud

Solytiq Cloud is a self-hosted, full-stack productivity suite: task lists, project timelines, file sharing, shared workspaces, a GPS/GPX route planner, and an AI assistant. The stack is React 19 + Vite (frontend), Express + TypeScript (backend), PostgreSQL 16, and Nginx — orchestrated with Docker Compose.

---

## Version Number

The current version is displayed at the bottom-left of the sidebar in `frontend/src/components/Sidebar.tsx`.

**On every deploy / release, update the version string** in that file — search for the `v1.14.0` literal (it appears in two places, for the expanded and collapsed sidebar states) and bump **both**. Use semantic versioning: patch for small fixes, minor for new features, major for breaking changes.

---

## Repository Layout

```
solytiq-cloud/
├── backend/          # Express REST API (Node.js / TypeScript)
│   ├── src/
│   │   ├── index.ts          # App entry, middleware, routes, runMigrations(), public share + SSE endpoints
│   │   ├── db.ts             # PostgreSQL pool + query() helper
│   │   ├── auth.ts           # JWT helpers (generateToken/verifyToken), bcrypt
│   │   ├── middleware.ts     # Auth middleware (verifyToken) — sets req.userId
│   │   ├── sse.ts            # Server-Sent Events client registry + broadcastToUser()
│   │   ├── gpx.ts            # GPX/FIT parsing & serialization (fast-xml-parser, fit-file-parser)
│   │   ├── workspaceUtil.ts  # Workspace access-control helpers
│   │   ├── setupToken.ts     # First-run setup token generation/logging
│   │   ├── __tests__/        # Vitest tests (currently gpx.test.ts + GPX fixtures)
│   │   └── routes/           # One file per resource
│   │       ├── auth.ts            # /api/auth — register, login, profile, TOTP 2FA
│   │       ├── tasks.ts           # /api/tasks — CRUD, reorder
│   │       ├── lists.ts           # /api/lists — CRUD, sections, sublists, links, share link
│   │       ├── folders.ts         # /api/folders — CRUD
│   │       ├── timelines.ts       # /api/timelines — CRUD, milestones, upcoming, share link
│   │       ├── workspaces.ts      # /api/workspaces — CRUD, members
│   │       ├── trash.ts           # /api/trash — soft delete, restore (tasks/lists/folders/timelines)
│   │       ├── files.ts           # /api/files — upload/download (multer), share settings
│   │       ├── taskAttachments.ts # /api/tasks/:taskId/attachments — upload/link files to tasks
│   │       ├── gps.ts             # /api/gps — GPX/FIT upload, edit, route planning, POIs
│   │       ├── admin.ts           # /api/admin — users, roles, nuke, settings
│   │       └── ai.ts              # /api/ai — OpenRouter chat, sessions, file uploads, usage
│   ├── init.sql              # (legacy) initial schema — migrations now in index.ts
│   ├── tsconfig.json
│   └── package.json
├── frontend/         # React SPA (Vite + TypeScript)
│   ├── src/
│   │   ├── main.tsx          # React DOM entry
│   │   ├── App.tsx           # Router, layout shell, modal state, SSE connect
│   │   ├── types.ts          # All shared TypeScript interfaces
│   │   ├── index.css         # Tailwind v4 base + Material Symbols font + keyframe animations
│   │   ├── App.css           # Component-scoped styles / overrides
│   │   ├── api/client.ts     # All HTTP calls (fetch wrappers) + SSE connect/disconnect
│   │   ├── store/            # Zustand stores (see State Management below)
│   │   ├── components/       # Reusable UI (Sidebar, TopBar, TaskItem, Icon, AIAssistant, GPS map widgets, …)
│   │   ├── screens/          # Full-page views (one per route) + public share pages
│   │   └── modals/           # Modal overlays (wizards, settings)
│   ├── tsconfig.json / tsconfig.app.json
│   ├── vite.config.ts
│   ├── eslint.config.js
│   └── package.json
├── nginx/
│   └── nginx.conf            # Reverse proxy, SPA fallback, gzip, headers
├── docker-compose.yml        # Three services: postgres, backend, frontend
├── .env.example              # Required environment variable template
└── security_report.md        # Prior security audit findings and fixes
```

---

## Development Setup

### Prerequisites

- Docker + Docker Compose (recommended for full stack)
- Node.js 22+ (for local frontend/backend development)
- PostgreSQL 16 (if running backend without Docker)

### Running with Docker Compose (recommended)

```bash
cp .env.example .env          # fill in POSTGRES_PASSWORD, JWT_SECRET
docker compose up --build
```

Frontend is served at `http://localhost` (port 80 via Nginx).

**First run:** if no users exist yet, the backend logs a one-time **setup token** (see `setupToken.ts`). Use it on the `/setup` wizard to create the first (admin) account.

### Running locally without Docker

**Backend:**
```bash
cd backend
npm install
# Ensure PostgreSQL is running and PGHOST/PGUSER/PGPASSWORD/PGDATABASE env vars are set
npm run dev        # ts-node-dev with --respawn, port 3001
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev        # Vite dev server, port 5173 with HMR
```

When running the frontend separately, point it at the backend with `VITE_API_URL` (the API client defaults to `/api`), or add a `/api` proxy to `vite.config.ts` (none is configured by default).

---

## Environment Variables

Copy `.env.example` to `.env` at the repository root. Docker Compose reads this file automatically.

| Variable | Required | Description |
|---|---|---|
| `POSTGRES_DB` | Yes | Database name (default: `solytiq`) |
| `POSTGRES_USER` | Yes | DB username (default: `solytiq`) |
| `POSTGRES_PASSWORD` | Yes | DB password — must be changed in production |
| `JWT_SECRET` | Yes | Long random string for signing JWTs — **fails startup if default** |
| `FRONTEND_URL` | Yes | Origin allowed by CORS (e.g. `http://localhost`). When unset, CORS allows `*` without credentials. Also used as the public origin for OAuth/MCP discovery when `PUBLIC_URL` is unset |
| `PUBLIC_URL` | No | Public origin (scheme + host) for OAuth issuer/endpoints and the MCP resource pointer. Falls back to `FRONTEND_URL`, then the request's forwarded host |
| `PORT` | No | Backend listen port (default: `3001`); also the host port for the frontend container |
| `OPENROUTER_API_KEY` | No | Enables the AI assistant via OpenRouter |
| `OPENROUTER_MODEL` | No | Model name (default: `openai/gpt-4o-mini`) |

The backend refuses to start in `NODE_ENV=production` if `JWT_SECRET` is the default placeholder.

The GPS route planner calls public upstreams (Overpass for POIs, Valhalla for road snapping/routing). Outbound IPv4 is forced at startup (`dns.setDefaultResultOrder('ipv4first')`) because containers often advertise non-routable IPv6.

---

## Backend Conventions

### Database

- **No ORM.** All queries use raw SQL via the `pg` client (`pool.query` / `query` helper from `db.ts`).
- **Schema migrations** run automatically at startup inside `runMigrations()` in `index.ts`. New columns use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` so they are additive and safe to re-run.
- **Never add a separate migration file** — append `pool.query(...)` calls to `runMigrations()` in `index.ts`. `runMigrations()` also performs idempotent data heals/seeds (e.g. auto-creating a "Personal" workspace per user, re-syncing list items to their list's workspace).
- Task IDs are `BIGINT` (numeric, generated client-side as `Date.now()`). Most other entity IDs are `VARCHAR(100)` strings (uuid package or timestamp-based). User and workspace-member IDs are `UUID` from `pgcrypto`'s `gen_random_uuid()`.

### Core Data Model

| Table | Purpose / key columns |
|---|---|
| `users` | `id UUID`, `username`, `email`, `password_hash`, `is_admin`, `token_version` (JWT invalidation), `profile_image`, `totp_secret`/`totp_enabled` (2FA), `last_online` |
| `lists` | List metadata + `is_public` (workspace visibility), `folder_id`, `workspace_id`, `parent_task_id`/`depth` (sublists), and share-link columns (`share_token`, `share_enabled`, `share_password_hash`, `share_expires_at`, `share_subpages`) |
| `sections` | Ordered groups within a list (`list_id`, `label`, `emoji`, `position`) |
| `tasks` | `id BIGINT`, `source` `'dash'｜'list'`, `list_id`/`section_id`, `linked_list_id`/`linked_list_type` (`'sublist'｜'link'`), `workspace_id`; `updated_at` maintained by a trigger |
| `folders` | Groups lists/timelines; `is_public`, `collapsed`, `workspace_id` |
| `timelines` | Milestone-based views: `layout` (`vertical｜compact｜detailed`), `is_public`, `folder_id`, `workspace_id`, share-link columns (`share_token`, `share_enabled`, `share_password_hash`, `share_expires_at`) |
| `milestones` | `timeline_id`, `title`, `milestone_date`, `time_val`, `status` (`upcoming｜in-progress｜done`), `position` |
| `workspaces` | `visibility` (`private｜public`), `owner_id`; each user is auto-seeded a private "Personal" workspace |
| `workspace_members` | `(workspace_id, user_id)` PK, `role` (`owner｜member`) |
| `shared_files` | File sharing: `share_token` (unique), `is_public`, `password_hash`, `expires_at`, `title`, `note` |
| `task_attachments` | Files attached to tasks: `attachment_type` (`upload｜linked`), optional `shared_file_id` |
| `milestone_attachments` | Files attached to milestones — same shape as `task_attachments` (`milestone_id` FK, `upload｜linked`) |
| `gps_files` | `file_type` (`gpx｜fit`), `file_path`, `metadata JSONB`, `smoothed`, `route_state JSONB` (Route Planner State v1) |
| `trash`, `trash_lists`, `trash_folders`, `trash_timelines` | Soft-delete payloads as JSONB with a 30-day `expires_at` |
| `app_settings` | Key/value config (storage quota, `ai_assistant_enabled`, `ai_model`, `two_fa_feature_enabled`) |
| `ai_chat_sessions`, `ai_chats`, `ai_chat_files`, `ai_usage` | AI conversations, messages, uploaded files (30-day TTL), and per-call token usage |

### Authentication

- JWT tokens are generated in `auth.ts` (`generateToken`) and verified via the `verifyToken` middleware in `middleware.ts`, which sets `req.userId`.
- Tokens embed a `token_version`; bumping `users.token_version` invalidates all of a user's existing tokens (used on password change / forced logout).
- **TOTP 2FA** (`otplib` + `qrcode`): when enabled, login returns a pending token and the client must call `/api/auth/2fa/verify`. Gated by the `two_fa_feature_enabled` app setting.
- Passwords are hashed with `bcryptjs`. Never store or log plaintext passwords.
- All routes except `/api/auth/login`, `/api/auth/register`, `/api/auth/request-setup-token`, the public `/api/share/*` endpoints, and `/health` require auth. The SSE endpoint `/api/events` authenticates via `?token=` query param or `Authorization` header.

### Rate Limiting

Three tiers defined in `index.ts`:
- `apiLimiter` — 300 req / 15 min (all `/api/*`)
- `authLimiter` — 10 req / 15 min (login, `/api/auth/2fa/verify`)
- `setupLimiter` — 5 req / 1 hour (register, `request-setup-token`, admin nuke)

### Route Patterns

Each route file follows this pattern:
```ts
import { Router } from 'express';
import { verifyToken } from '../middleware';
import { query } from '../db';

const router = Router();
router.use(verifyToken);   // applied to all routes in the file, or per-route

router.get('/', async (req, res) => {
  const userId = (req as any).userId;   // set by verifyToken
  // ...
  res.json(result);
});

export default router;
```

### Real-time Sync (SSE)

- `sse.ts` keeps an in-memory registry of connected clients per user. Mutating endpoints call `broadcastToUser(userId, channel)` (channels like `'lists'`, `'files'`, `'timelines'`) to push a refresh signal.
- The frontend opens `GET /api/events` (EventSource) via `connectSSE()` in `client.ts`; stores listen and reload the affected data. Heartbeat pings every 25s keep the connection alive behind Nginx.

### Public Sharing (files, lists, timelines)

Public share endpoints are mounted **directly in `index.ts`** (not behind `verifyToken`):

- **Files:** `GET /api/share/:token` (metadata) and `GET /api/share/:token/download` (binary; optional `?password=`).
- **Lists:** `GET /api/share/list/:token` (metadata) and `GET /api/share/list/:token/content` (sections + tasks; optional `?password=`).
- **Timelines:** `GET /api/share/timeline/:token` (metadata) and `GET /api/share/timeline/:token/content` (milestones; optional `?password=`).

Sharing model for lists/timelines (distinct from the workspace `is_public` flag — see Key Architectural Decisions):
- An **opaque `share_token`** (24-byte hex) is minted when sharing is first enabled. `share_enabled` toggles the public link; `share_password_hash` and `share_expires_at` are optional (full parity with file shares).
- **Owner-side management:** `PUT /api/lists/:listId/share` and `PUT /api/timelines/:timelineId/share` toggle/configure the link.
- **Subpages:** lists have `share_subpages`. When enabled together with sharing, the share state cascades to nested sublist descendants (each gets its own token, inheriting password/expiry). The list-content endpoint exposes each shared sublist's token as `linkedShareToken` so the public page can deep-link to the subpage, plus a `linkedProgress` summary for the ring indicator. When a sublist isn't live-shared, its token is omitted.
- Expired or disabled links return `410`/`404`; private/missing return `404`.

### File Uploads

- Handled by `multer` in `routes/files.ts`. Files saved to disk under `UPLOAD_DIR`.
- Max upload size: 200 MB (multer config). Nginx proxy limit: 210 MB.
- Each user has a 15 GB storage quota enforced server-side (configurable via `app_settings.storage_quota_per_user`).
- File sharing uses an opaque `share_token` (hex). Public file info and download are at `/api/share/:token` and `/api/share/:token/download`.
- **Task attachments** (`taskAttachments.ts`) either upload a new file or link an existing `shared_files` row to a task. **Milestone attachments** (`milestoneAttachments.ts`, mounted at `/api/timelines/milestones/:milestoneId/attachments`) mirror this for timeline milestones; access is gated by the milestone's timeline (owner, or workspace-public for reads).

### GPS / Route Planner

- `routes/gps.ts` + `gpx.ts` handle GPX and FIT files. Parsing uses `fast-xml-parser` (GPX) and `fit-file-parser` (FIT); track smoothing/decimation uses `simplify-js`.
- Endpoints under `/api/gps`: list, `upload`, `:id/data`, `:id/smooth(+-save)`, `:id/rename`, `new`, `combine`, `:id/download`, `:id/points`, `:id/route-state`, delete, plus `route` (Valhalla snapping/routing) and `pois` (Overpass POI search).
- **Route Planner State v1** (`route_state JSONB`) stores rich editing state — control points, routed/offgrid spans, POI markers, course points — alongside the canonical track. See `GpsRouteStateV1` and related types in `types.ts`.

### AI Assistant

- Thin proxy to OpenRouter (`/api/ai/chat`). Requires `OPENROUTER_API_KEY`.
- **Sessions:** conversations live in `ai_chat_sessions` (30-day TTL); messages in `ai_chats` (role, content, `tool_calls`, `metadata`, `session_id`). Endpoints: `POST/GET /api/ai/sessions`, `GET/DELETE /api/ai/sessions/:id`, `POST/DELETE /api/ai/history`.
- **File context:** users can upload files into a chat (`POST /api/ai/files`); stored in `ai_chat_files` with extracted `content_text` (PDF via `pdf-parse`, spreadsheets via `xlsx`) and a 30-day TTL. A startup + 6-hour cron purges expired files.
- **Usage tracking:** every OpenRouter call records token counts in `ai_usage`.
- AI settings (`ai_assistant_enabled`, `ai_model`) live in `app_settings` and are admin-configurable from the Settings screen.

### Shared AI Tool Registry (single source of truth)

- **`backend/src/aiTools.ts`** is the one place AI capabilities are defined: each tool has a JSON-Schema parameter spec **and** a server-side SQL handler. `executeAiTool(userId, name, args)` runs a tool; `getOpenRouterToolDefs()` / `getMcpToolDefs()` adapt the same defs to each consumer.
- **Security invariant:** handlers receive `userId` from the verified credential only — there is **no `user_id` tool parameter**, and every query is scoped by `user_id`. This removes any prompt-injection path to another user's data. New tools must follow this rule.
- **Internal AI** (`Sol`) fetches these defs from `GET /api/ai/tools` and executes data tools via `POST /api/ai/execute`; the frontend keeps only client-coupled tools (navigation, GPS browser-downloads, reorder/move, sublists, workspaces) — see `SUPERSEDED_CLIENT_TOOLS` in `components/AIAssistant/index.tsx`.
- File→text extraction is centralized in **`backend/src/fileText.ts`** (used by both `/api/ai/files` and the `read_file` tool).

### MCP Server (external AI agents)

- **`/mcp`** (mounted in `index.ts`, handler in `routes/mcp.ts`) is a Model Context Protocol server over **Streamable HTTP** (`@modelcontextprotocol/sdk`, stateless: one server+transport per request). It exposes the shared registry to external agents (e.g. the Claude MCP connector). Nginx proxies `/mcp` with buffering off.
- **Auth: bearer tokens minted via OAuth.** Agents send `Authorization: Bearer solytiq_pat_…`. Tokens live in `api_tokens` (only a SHA-256 hash is stored), are long-lived and individually revocable. PAT helpers are in `backend/src/apiToken.ts`. A missing/invalid token returns `401` with a `WWW-Authenticate: Bearer … resource_metadata="…"` header pointing at the Protected Resource Metadata doc, which kicks off the OAuth handshake.
- **OAuth 2.1 connector flow** (`routes/oauth.ts`): the user connects Claude from the **Claude MCP** section of the per-user `UserSettingsModal` by pasting the `/mcp` URL into Claude as a custom connector. Claude then runs OAuth discovery → Dynamic Client Registration → authorization → token exchange:
  - **Discovery:** `GET /.well-known/oauth-protected-resource[/mcp]` (RFC 9728, resource→authorization-server pointer) and `GET /.well-known/oauth-authorization-server` (RFC 8414, endpoint metadata) — both served from `index.ts`, using `getPublicBaseUrl()` (`publicUrl.ts`, prefers `PUBLIC_URL`/`FRONTEND_URL`).
  - **DCR:** `POST /api/oauth/register` (RFC 7591) stores the client (`oauth_clients`: `client_id`, `client_name`, `redirect_uris`) and returns a public PKCE `client_id` (`token_endpoint_auth_method: none`).
  - **Authorize:** `GET /api/oauth/authorize` validates `response_type=code`, the client + `redirect_uri`, and that PKCE `code_challenge` (S256) is present, then redirects to the React `/oauth/consent` screen.
  - **Consent:** `POST /api/oauth/approve` (session-JWT authenticated) mints a single-use, 5-minute authorization code bound to `user_id` + `client_id` + `redirect_uri` + `code_challenge` (`oauth_codes`).
  - **Token:** `POST /api/oauth/token` (`grant_type=authorization_code`) consumes the code atomically, verifies the PKCE `code_verifier` (S256, constant-time), and returns a `api_tokens` PAT scoped to the consenting user — so the connector can only ever do what that user can do in-app.
- **Token management:** `GET`/`DELETE /api/tokens` (`routes/tokens.ts`) list and revoke (disconnect) connected clients; there is no manual token-creation endpoint — tokens are minted only by the OAuth flow.

---

## Frontend Conventions

### State Management

All shared state lives in **Zustand stores** under `src/store/`. Do not use React `useState` for data shared across components.

| Store | Contains |
|---|---|
| `useAppStore` | Dashboard tasks, lists, folders, timelines, all trash buckets, sidebar width; `loadFromApi(workspaceId)` is the main loader |
| `useAuthStore` | Current user, JWT token, auth actions, 2FA state (persisted to localStorage) |
| `useWorkspaceStore` | Workspace list + currently active workspace; switching reloads scoped data |
| `useAIStore` | AI chat window state, sessions, conversation history |
| `useMembersStore` | Members list for shared spaces |
| `useGpsStore` | GPS screen UI state |
| `useUserPrefsStore` | Per-user UI preferences |

`useAppStore.loadFromApi()` is called on mount in `App.tsx`. It fetches tasks, lists, folders, and timelines (scoped to the active workspace) in parallel.

### API Calls

All HTTP calls go through `src/api/client.ts`. Do not call `fetch` directly in components or stores. The client reads the token from auth state and attaches `Authorization: Bearer <token>`. List/timeline/task/folder loaders accept an optional `workspaceId` to scope results. `connectSSE()`/`disconnectSSE()` manage the real-time event stream.

### Types

All shared interfaces are in `src/types.ts`. Key types:

- `Task` — `id: number`, `_source: 'dash' | 'list'`, `_listId?`, `deadline: YYYY-MM-DD`, `linkedListId`/`linkedListType` (sublists/links)
- `List` — `sections: Section[]`; workspace `isPublic`; share-link fields (`shareEnabled`, `shareToken`, `shareHasPassword`, `shareExpiresAt`, `shareSubpages`); `parentTaskId`/`depth`
- `Timeline` — `layout`, `milestones: Milestone[]`, share-link fields
- `Workspace` / `WorkspaceMember` — visibility + role
- `Folder` — groups lists/timelines, has `collapsed` state
- `TrashedTask`/`TrashedList`/`TrashedFolder`/`TrashedTimeline` — wrap an entity with restore context
- `SharedFile`, `TaskAttachment`, `AIFile`
- GPS/Route types — `GpsFile`, `GpsTrackData`, `GpsRouteStateV1`, `RouteControlPoint`, `PoiMarker`, `NamedPin`, etc.

### Routing

Routes are defined in `App.tsx` using React Router v7. Authenticated app routes render inside the layout shell; public/auth routes render standalone. Protected access is enforced by the `loggedIn` flag in `useAuthStore`.

Authenticated routes:
- `/dashboard` → `DashboardScreen` (due today + priority tasks + upcoming-milestone widget)
- `/folder/:folderId` → `FolderDashboardScreen`
- `/list/:listId` → `ListScreen`
- `/timeline/:timelineId` → `TimelineScreen`
- `/calendar` → `CalendarScreen`
- `/files` → `FilesScreen`
- `/gps` → `GPSScreen`, `/gps/:id/edit` → `GPSEditScreen`
- `/settings` → `SettingsScreen`
- `/nuke` → `NukeScreen` (account/data deletion)

Public / unauthenticated routes:
- `/login` → `LoginScreen`, `/setup` → `SetupWizard` (first-run)
- `/share/:token` → `SharePage` (public file)
- `/share/list/:token` → `SharedListPage`, `/share/timeline/:token` → `SharedTimelinePage`

### Public Share Pages — Layout Convention

`SharePage`, `SharedListPage`, and `SharedTimelinePage` share one chrome: **no sidebar**, the Solytiq logo top-left, a "Shared by {owner}" pill top-right (avatar + name), the content card centered, and a "Shared via Solytiq" footer bottom-center. They handle loading / not-found / private / expired / password-required states and gate content behind the optional password. Match this layout exactly when adding new public views.

### Modal State

Top-level modal visibility is managed by a single `modal` string state in `App.tsx` (e.g. `'completed'`, `'trash'`, workspace wizard, add wizard, `null`). Creation/settings wizards live in `src/modals/` (`AddListWizard`, `AddTimelineWizard`, `WorkspaceWizard`, `ItemSettingsModal`, `UserSettingsModal`, `WorkspaceSettingsModal`, `TwoFAWizard`, `TrashModal`, `CompletedModal`).

The per-item **"More settings…"** menu in the `Sidebar` opens `ItemSettingsModal`, which is where accessibility (workspace Public/Private), color, emoji, folder, and the **public Share link** controls live for lists and timelines.

The two editor dialogs — `TaskDialog` (task/item editing) and the milestone editor in `TimelineScreen` — share one chrome: a wide (800px) card with a colored accent stripe, a large title-with-emoji/checkbox heading row, a light-purple **properties panel** of icon+label rows (`PropRow`), a Notes section, and an explicit **Cancel / Save** footer. When the containing list/timeline is **workspace-public**, the panel also shows an **Owner** row — a `CreatorBubble` avatar + name (task `creatorId` for items; the timeline owner for milestones). Both use **buffered editing** — field edits live in local state and only persist on Save; Cancel/close/Escape discards them. (In `TaskDialog`, attachments and sub-items are the exception: they remain immediate actions.)

### Mobile Responsiveness

Every new component, screen, modal, dialog, and popup **must work correctly on mobile (≥ 390px, e.g. iPhone 15 Pro)**. Desktop layout is the design priority; mobile is an adaptive layer on top.

Rules:
- Call `useMobile()` (from `src/hooks/useBreakpoint.ts`) at the composition root (screen, modal, or layout shell). Never call it inside leaf/reusable components — pass `isMobile` as a prop if needed.
- Never set `transform` on a `position: fixed` container (e.g. the sidebar). CSS spec makes `transform` a new containing block for fixed descendants, trapping them inside and breaking overflow. Use `left`/`top` properties instead for slide animations on fixed elements.
- All fixed overlays (dropdowns, dialogs, rename modals) must use `position: fixed` with `zIndex` ≥ 400 so they escape any parent `overflow: hidden`.
- Pickers (`CalendarPicker`, `TimePicker`) use `Math.min(N, window.innerWidth - 32)` for their width to stay on-screen.
- Use `padding: 'var(--modal-pad)'` (defined in `index.css`) for modal backdrops so padding shrinks on mobile without JS.
- Test both 390px (mobile) and 1440px (desktop) after every change — desktop must remain unchanged.

### Styling — "Luminous List" Design System

- Tailwind CSS v4 provides base styles (`src/index.css`), but components predominantly use **inline `style={{}}` objects** with the design tokens below. Match the surrounding component's approach when editing.
- Aesthetic: glassmorphism, soft purples, rounded cards, springy modal animations.
- **Palette:** primary `#5e4dbb`; light purple surfaces `#F5F3FF`/`#f0edff`; text `#1c1b22` (primary) / `#484552` / `#787584` / `#b0acbe`; borders `#e8e4f0`/`#E5E7EB`; dividers `#f0ecf8`; success `#10B981`; error `#ba1a1a`; warning `#d97706`.
- **Type:** Hanken Grotesk for headings/labels/UI, Inter for body.
- **Radii:** buttons 8–10, cards/modals 14–20, pills 9999. **Shadows:** subtle purple-tinted (`0 8px 32px rgba(0,0,0,0.14)`, `0 8px 40px rgba(94,77,187,0.10)`).
- **Animations** (defined in `index.css`): `modalIn` (`280ms cubic-bezier(0.34,1.56,0.64,1)`), `menuIn`, `backdropIn`, `sectionFadeUp`, `cardIn`, `spin`.
- **Icons:** Material Symbols via the `<Icon>` component (`src/components/Icon.tsx`) — pass the symbol name as a string.
- **Privacy/visibility toggles:** two-button (lock/public) pattern; selected gets `#5e4dbb` border + `#f0edff` background + a check icon.
- **Date pickers:** Always use the shared `<CalendarPicker>` component (`src/components/CalendarPicker.tsx`) for *every* calendar/date field — never a native `<input type="date">` (it renders the OS picker, which breaks the design language and is locale-dependent). The established pattern is a trigger button (`calendar_today` icon + the formatted date or a placeholder + an `×` clear affordance) that toggles a `showExpiryCal`-style boolean, with `<CalendarPicker value={…} onChange={…} onClear={…} />` in an absolutely-positioned popover. See the expiry fields in `FilesScreen` and `ItemSettingsModal`, and the due-date field in `TaskDialog`, for reference.
- **Time pickers:** Likewise, always use the shared `<TimePicker>` component (`src/components/TimePicker.tsx`) for *every* time-of-day field — never a native `<input type="time">` (same OS-picker problem). It takes/returns a 24-hour `"HH:MM"` string and mirrors `CalendarPicker`'s chrome (same card, hour/minute scroll wheels with the selected value highlighted in `#5e4dbb`, and a **Now** / **Clear** footer). Wire it with the identical trigger-button + `showTime`-boolean + absolutely-positioned popover pattern as the date picker (a `schedule` icon + the `HH:MM` value or a `--:--`/placeholder). See the **Time** field in the `TimelineScreen` milestone editor and in `AddTimelineWizard` for reference.

### Task Source Duality

Tasks belong to one of two sources:
- `'dash'` — created from the Dashboard, not inside a list
- `'list'` — created inside a specific list/section

This affects which store actions to call: use `updateDashTask` for dash tasks and `updateListTask`/`deleteListTask` for list tasks. Always check `task._source` before dispatching.

### Sublists & Linked Lists

A list task can link to another list via `linkedListId` + `linkedListType`:
- `'sublist'` — a child list owned by this task (`lists.parent_task_id` + `depth`); progress rolls up into the parent's `linkedProgress` ring.
- `'link'` — a reference to an existing standalone list.

Create them via `apiCreateSublistTask` / `apiLinkListAsTask`. Sublists always share the parent's `workspace_id`.

---

## Build & Scripts

### Frontend

```bash
cd frontend
npm run dev       # Vite HMR dev server (localhost:5173)
npm run build     # tsc -b && vite build → dist/
npm run lint      # ESLint (flat config, TypeScript + React hooks)
npm run preview   # Serve the built dist/
npm test          # vitest run
```

### Backend

```bash
cd backend
npm run dev       # ts-node-dev --respawn src/index.ts (port 3001)
npm run build     # tsc → dist/
npm run start     # node dist/index.js (production)
npm test          # vitest run
```

### Docker

```bash
docker compose up --build       # Full stack
docker compose up --build backend  # Rebuild only backend
docker compose logs -f backend  # Stream backend logs
```

---

## Tests

A **Vitest** suite exists (`npm test` in both `backend/` and `frontend/`). Coverage is currently minimal — the only committed backend tests are GPX parsing tests in `backend/src/__tests__/gpx.test.ts` with `.gpx` fixtures. There are no frontend tests yet. Vitest is the standard for new tests in both packages; add backend tests under `src/__tests__/`. Beyond automated tests, verify manually:
- Backend: `curl` or a REST client against `http://localhost:3001`
- Frontend: run the dev server and test in browser

---

## Security Notes

These issues were identified and fixed (see `security_report.md`). Do not regress them:

1. **IDOR** — All DB queries must filter by `user_id = $userId` extracted from the verified JWT, never from request body/params alone. Workspace-scoped reads must additionally honor membership/visibility (see `workspaceUtil.ts`).
2. **JWT_SECRET** — Must be a strong random secret. Backend exits in production if it is the placeholder default. `token_version` allows mass-invalidating tokens.
3. **Rate limiting** — Auth, 2FA, setup, and destructive endpoints have tighter limits. Do not remove these.
4. **File path traversal** — Use `path.resolve` / `path.join` carefully when serving files (shared files, attachments, GPS files). Validate that the resolved path stays within its upload dir.
5. **Profile image uploads** — Validate MIME type and file extension server-side before saving.
6. **Password hashing** — Always use `bcryptjs` for account passwords AND share-link passwords. Never log or return hashes.
7. **Race conditions** — Storage quota checks must be done inside a transaction or with `SELECT ... FOR UPDATE` to prevent over-quota uploads under concurrent load.
8. **Public share endpoints** — `/api/share/*` are intentionally unauthenticated. They must only ever expose data when the relevant `share_enabled`/`is_public` flag is set, must enforce password + expiry, and must never leak owner-only fields (hashes, internal IDs, private sibling data).

---

## Key Architectural Decisions

- **Migrations in code, not files** — `runMigrations()` in `index.ts` uses `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` guards and idempotent data heals/seeds. Always append new migrations there.
- **No ORM** — Raw SQL keeps queries explicit and avoids N+1 pitfalls; use `JOIN` freely.
- **Zustand over Redux** — Minimal boilerplate; each store is a standalone module. Stores call the API client directly; components call store actions.
- **Soft delete** — Deleted tasks, lists, folders, and timelines go to their respective `trash*` tables (JSONB payload) with a 30-day `expires_at`. The live tables have no `deleted_at` column.
- **Task IDs are BIGINT** — Generated client-side as `Date.now()` (milliseconds). Per-user FK scoping prevents cross-user collisions; avoid relying on global uniqueness.
- **Workspaces scope everything** — Lists, folders, tasks, and timelines carry a `workspace_id`. Every user gets an auto-seeded private "Personal" workspace. Workspace `visibility` (`private｜public`) plus `workspace_members` govern who can see shared content in-app.
- **Two distinct notions of "public":**
  1. `is_public` on lists/folders/timelines = **in-app visibility to workspace members**.
  2. `share_enabled` + `share_token` = **anonymous read-only link** for anyone on the internet (no login), optionally password-protected and/or time-limited. These are independent — enabling one does not enable the other.
- **Real-time via SSE** — Mutations broadcast refresh signals over `/api/events`; the frontend reloads affected slices. There is no WebSocket server.
- **AI via OpenRouter** — The AI endpoint is a thin proxy. Model and enabled state live in `app_settings` so admins can change them without redeployment. Chat sessions and uploaded files expire after 30 days.
- **GPS route state is versioned** — `gps_files.route_state` is `GpsRouteStateV1`; bump the version and migrate the shape if its structure changes.
