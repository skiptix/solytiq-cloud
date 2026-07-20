<div align="center">
  <img src="./public/solytiq-cloud.png" alt="Solytiq Cloud Logo" width="120" height="120" style="border-radius: 24px; box-shadow: 0 10px 25px rgba(94, 77, 187, 0.2);" />
  <h1>Solytiq Cloud</h1>
  <p><strong>Your lists. Your cloud. Simple, powerful, and self-hosted.</strong></p>

  <div align="center">
    <img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="License: MIT" />
    <img src="https://img.shields.io/badge/Docker-Enabled-blue.svg?logo=docker&style=flat-square" alt="Docker" />
    <img src="https://img.shields.io/badge/Frontend-React_19-blue.svg?logo=react&style=flat-square" alt="React" />
    <img src="https://img.shields.io/badge/Backend-Node.js_22-green.svg?logo=nodedotjs&style=flat-square" alt="Node.js" />
    <img src="https://img.shields.io/badge/Language-TypeScript-blue.svg?logo=typescript&style=flat-square" alt="TypeScript" />
  </div>
</div>

----

## 🌟 Overview

**Solytiq Cloud** is a premium, self-hosted productivity application that merges the refined simplicity of Apple Reminders with the robust capabilities of a power-user task manager. Built with the **"Luminous List"** design language, it offers a serene, "lit-from-within" experience for managing your life and work.

### ✨ Key Features

- 🏗️ **Workspaces** — Organize your life into separate environments (Personal, Work, Hobbies) with shared or private access.
- 🔍 **Global Search** — Instantly find tasks, lists, timelines, milestones, meetings, and workspaces across your entire cloud.
- 🚀 **Dashboard** — A bird's-eye view of your day featuring "Due Today" focus, priority tracking, and productivity stats.
- 📅 **Scheduled View** — A full interactive calendar with drag-and-drop scheduling for unscheduled tasks.
- 📂 **Folders & Lists** — Deeply nestable folders and smart lists with custom emojis, colors, and progress tracking.
- 🗺️ **GPS Tracks & Routing** — Upload, analyze, and map GPX/FIT files directly within your workspace.
- 📈 **Visual Timelines** — Track project milestones and plan your schedule chronologically.
- ⚡ **Real-time Sync (SSE)** — Changes sync instantly across all devices via Server-Sent Events.
- 🔒 **Enhanced Security** — Built-in TOTP 2FA support, JWT-based authentication, and hardened security headers.
- 🤖 **AI Assistant & MCP Server** — A floating AI chat powered by OpenRouter, plus an integrated Model Context Protocol (MCP) server for external AI agents (like Claude) to securely interact with your workspace via OAuth 2.1.
- 📎 **Cloud File Sharing** — Securely share files (max upload size: 200 MB, Nginx proxy limit: 210 MB) with password protection, expiry dates, and public links.
- 👥 **Multi-User & Admin** — Full member management with 15 GB per-user storage quotas and admin-controlled permissions.
- 📅 **CalDAV Server** — Built-in CalDAV support allowing native integration with external calendar apps (Apple Calendar, Thunderbird, etc.) for viewing milestones/tasks and managing meetings.
- 🗑️ **Trash & Restore** — Comprehensive protection against accidental deletions with a 30-day recovery window.
- 📋 **Templates** — Capture any list or timeline as a reusable template, keeping relative dates and recursive sublist structures intact.
- 🧩 **App Directory & Automation Hub** — Expand functionality with admin-installable apps (GPS, Files, MCP, Automations). The Automation Hub enables visual, flow-chart automations with secure, sandboxed JavaScript execution via `isolated-vm`.

---

## 🎨 Design Philosophy: "Luminous List"

Solytiq Cloud is built on a specific aesthetic foundation designed to reduce cognitive load and enhance focus:

*   **Glassmorphism:** Subtle blurs and translucent layers that create a sense of depth.
*   **Lavender Surfaces:** A calming palette of soft lavender (`#5e4dbb`) and crisp whites.
*   **Fluid Motion:** Every interaction—from dragging lists to toggling tasks—is animated for immediate feedback.
*   **Typography:** *Hanken Grotesk* for modern headings and *Inter* for maximum readability.
*   **Styling Engine:** Tailwind CSS v4 provides base styles, combined with inline `style={{}}` objects and design tokens.
*   **Icons:** Material Symbols via the `<Icon>` component (`src/components/Icon.tsx`). Pass the symbol name as a string.
*   **Pickers:** Always use the shared `<CalendarPicker>` (`src/components/CalendarPicker.tsx`) and `<TimePicker>` (`src/components/TimePicker.tsx`) components for date and time fields. Never use native `<input type="date">` or `<input type="time">`.

---

## 🛠️ Tech Stack

### Frontend
- **Framework:** [React 19](https://react.dev/) + [Vite](https://vitejs.dev/)
- **State Management:** [Zustand](https://github.com/pmndrs/zustand) (with persistence)
- **Routing:** [React Router 7](https://reactrouter.com/)
- **Styling:** Tailwind CSS v4 base + Modern CSS (Design Tokens) with refined animations
- **Communication:** [Server-Sent Events (SSE)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) for real-time updates
- **Maps:** [Leaflet](https://leafletjs.com/) for rendering GPS tracks

### Backend
- **Runtime:** [Node.js 22](https://nodejs.org/) (Alpine-based)
- **Framework:** [Express 4](https://expressjs.com/)
- **Database:** [PostgreSQL 16](https://www.postgresql.org/)
- **Auth:** JWT + [otplib](https://github.com/yeoju/otplib) (TOTP 2FA) + bcryptjs
- **File Handling:** Multer (with disk storage)
- **AI Integration:** [OpenRouter API](https://openrouter.ai/) + [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/sdk) (MCP server + OAuth 2.1)
- **Data Parsing:** GPX & FIT file processing (`fast-xml-parser`, `fit-file-parser`), and PDF/spreadsheet data extraction (`pdf-parse`, `xlsx`)

---

## 🔧 Development Setup

### Prerequisites

- Docker + Docker Compose (recommended for full stack)
- Node.js 22+ (for local frontend/backend development)
- PostgreSQL 16 (if running backend without Docker)

### Running with Docker Compose (recommended)

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/skiptix/solytiq-cloud.git
    cd solytiq-cloud
    ```

2.  **Configure environment:**
    ```bash
    cp .env.example .env
    ```
    *Mandatory:* Change `POSTGRES_PASSWORD` and `JWT_SECRET`.

3.  **Deploy:**
    ```bash
    docker compose up --build
    ```

Frontend is served at `http://localhost` (port 80 via Nginx).

**First run:** if no users exist yet, the backend logs a one-time **setup token** (generated via `setupToken.ts`). Use it on the `/setup` wizard to securely create the first admin account, overriding old automatic registration flows.

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

## ⚙️ Configuration

| Variable | Required | Description | Default |
| :--- | :--- | :--- | :--- |
| `POSTGRES_DB` | Yes | Database name | `solytiq` |
| `POSTGRES_USER` | Yes | Database username | `solytiq` |
| `POSTGRES_PASSWORD` | Yes | Database password — must be changed in production | `change_me` |
| `JWT_SECRET` | Yes | Key for session signing — **fails startup if default** | `change_me` |
| `FRONTEND_URL` | Yes | Origin allowed by CORS (e.g., `http://localhost`). Strictly required for secure CORS configuration; **backend crashes on startup if missing.** Used for OAuth/MCP discovery when `PUBLIC_URL` is unset | `http://localhost` |
| `PUBLIC_URL` | No | Public origin (scheme + host) for OAuth issuer/endpoints and MCP | — |
| `PORT` | No | Public host port / backend listen port | `3001` (backend) / `80` (Docker) |
| `OPENROUTER_API_KEY` | No | Enables the AI assistant via OpenRouter | — |
| `OPENROUTER_MODEL` | No | AI Model (e.g., `openai/gpt-4o-mini`) | `openai/gpt-4o-mini` |

The backend refuses to start in `NODE_ENV=production` if `JWT_SECRET` is the default placeholder.

The GPS route planner calls public upstreams (Overpass for POIs, Valhalla for road snapping/routing). Outbound IPv4 is forced at startup (`dns.setDefaultResultOrder('ipv4first')`) because containers often advertise non-routable IPv6.

---

## 🏗️ Architecture & Core Concepts

- **Version Number** — On every deploy / release, update the version string in `frontend/src/components/Sidebar.tsx`. Use semantic versioning.
- **Migrations in code, not files** — `runMigrations()` in `index.ts` uses guards and idempotent data heals/seeds.
- **No ORM** — Raw SQL keeps queries explicit and avoids N+1 pitfalls; use `JOIN` freely. When doing bulk database inserts into PostgreSQL using a dynamic parameter array (e.g. `$1, $2...`), remember to chunk the parameters so you do not exceed PostgreSQL's maximum parameter limit (65535).
- **Zustand over Redux** — Minimal boilerplate; each store is a standalone module. Stores call the API client directly; components call store actions.
- **Soft delete** — Deleted tasks, lists, folders, and timelines go to their respective `trash*` tables (JSONB payload) with a 30-day `expires_at`. The live tables have no `deleted_at` column.
- **Task IDs are BIGINT** — Generated client-side as `Date.now()` (milliseconds). Handled as numbers in TypeScript. Use secure integer generation like `crypto.randomInt()` instead of string-based UUIDs like `crypto.randomUUID()` when generating new IDs for these fields. Per-user FK scoping prevents cross-user collisions.
- **Workspaces scope everything** — Lists, folders, tasks, and timelines carry a `workspace_id`. Every user gets an auto-seeded private "Personal" workspace. Workspace `visibility` plus `workspace_members` govern who can see shared content in-app.
- **Two distinct notions of "public":**
  1. `is_public` on lists/folders/timelines = **in-app visibility to workspace members**.
  2. `share_enabled` + `share_token` = **anonymous read-only link** for anyone on the internet (no login), optionally password-protected and/or time-limited.
- **Real-time via SSE** — Mutations append to a `sync_log` transactional outbox and broadcast refresh signals over `/api/events`; the frontend reloads affected slices. There is no WebSocket server.
- **AI via OpenRouter** — The AI endpoint is a thin proxy. Model and enabled state live in `app_settings` so admins can change them without redeployment. Chat sessions and uploaded files expire after 30 days.
- **Automation Hub** — Workspace-scoped flow-chart automations (V1 graphs are strictly linear) that execute per-step. Parameters support an eval-free `{{...}}` token syntax. User-supplied JavaScript in the Code action runs inside a real `isolated-vm` V8 isolate, avoiding Node's insecure built-in `vm` module.
- **GPS route state is versioned** — `gps_files.route_state` is `GpsRouteStateV1`; bump the version and migrate the shape if its structure changes.
- **CalDAV Server** — Built-in read/write CalDAV server (a focused subset of RFC 4791 / WebDAV). It lets Apple Calendar, Thunderbird, etc. subscribe to everything on the Calendar page via HTTP Basic auth with generated app passwords.
- **MCP Server** — Model Context Protocol server over Streamable HTTP. It exposes the shared tool registry to external agents (e.g. the Claude MCP connector) with bearer tokens minted via an OAuth 2.1 connector flow.
- **Shared AI Tool Registry** — `backend/src/aiTools.ts` uses JSON-Schema specs and secure, user-scoped SQL handlers to prevent prompt injection.
- **Mobile Responsiveness** — Every new component must work correctly on mobile (≥ 390px, e.g. iPhone 15 Pro) with mobile as an adaptive layer on top of desktop.
- **Task Source Duality** — Tasks have a source duality (`'dash'` or `'list'`) which dictates the appropriate frontend store actions to use (`updateDashTask` vs `updateListTask`).
- **Sublists & Linked Lists** — Created by having a list task link to another list via `linkedListId` and `linkedListType` properties.
- **File Uploads** — Handled by `multer`. Max upload size: 200 MB (multer config), Nginx proxy limit: 210 MB. Each user has a 15 GB storage quota.
- **Security** — IDOR prevention using verified JWT `userId`, strict file path traversal checks, `bcryptjs` for password and share-link hashing, and transaction-based quota checks. Avoid using synchronous I/O operations (like `fs.readFileSync`) in Express route handlers to prevent blocking the Node.js event loop.
- **Rate Limiting** — Configured in three tiers (`apiLimiter` for general API, `authLimiter` for logins/2FA, and `setupLimiter` for registration/nuke endpoints). The `apiLimiter` is automatically applied to all routes mounted under `/api/` in `backend/src/index.ts`.
- **Testing** — Vitest is the standard for both frontend and backend suites. To run tests, navigate to their respective directories and run `npm install && npm run test`.

---

## 🔑 Admin API

The **Admin API** is an instance-wide REST API for external tools and automations. It is authenticated with **admin API keys** (not user session tokens) and can both **read** all data across the instance and **write** — create, update and delete users, workspaces, folders, lists, items, timelines, milestones and meetings — on behalf of any user.

Base URL: `https://<your-host>/api/admin-read`

### Managing keys

Admin API keys are managed from **Settings → API** (admins only):

1. Click **New API key** to open the creation wizard.
2. Give the key a name and toggle exactly which **permissions** it should have.
3. Click **Generate key**. The secret (`solytiq_admin_…`) is shown **once** — copy it immediately. Only a SHA‑256 hash is stored, so it can never be recovered later.
4. Revoke a key any time from the **Active keys** list; its permissions are shown as chips.

Keys created before this feature existed keep working as **read‑only** (`read` permission only).

### Permissions (scopes)

Each key carries a set of scopes chosen in the wizard. A request to an endpoint returns **403** if the key lacks the required scope. Grant only what an integration needs.

| Scope | Grants |
|---|---|
| `read` | Read everything via `GET /export` |
| `users` | Create / update / delete user accounts |
| `workspaces` | Create / update / delete workspaces |
| `folders` | Create / update / delete folders |
| `lists` | Create / manage lists, sections and items (tasks) |
| `timelines` | Create / manage timelines and milestones |
| `meetings` | Create / manage calendar meetings |

### Authentication

Send the key as a Bearer token (or an `x-api-key` header):

```bash
curl -H "Authorization: Bearer solytiq_admin_XXXXXXXX…" \
  "https://<your-host>/api/admin-read/export"
```

### Targeting a user (`ownerId`)

Because a key is an **instance‑level** admin credential (not a single user), every **write** that creates user‑owned content accepts an optional `ownerId` — the id of the user the content belongs to. When omitted, it defaults to the admin who created the key. `ownerId` is always validated against a real user, and new lists/folders/timelines land in that user's Personal workspace unless a `workspaceId` they can access is supplied.

### Endpoints

**Read** (scope `read`)
- `GET /export?workspaceId=&userId=` — full instance snapshot (users, workspaces, folders, lists, sections, items, timelines, milestones, meetings, timings and attachment metadata). Both filters are optional. Secrets (password hashes, file paths) are never included.

**Users** (scope `users`)
- `POST /users` — `{ username, password, email?, fullName?, isAdmin? }`
- `PUT /users/:id` — `{ username?, password?, fullName?, isAdmin? }` (changing the password invalidates that user's sessions)
- `DELETE /users/:id`

**Workspaces** (scope `workspaces`)
- `POST /workspaces` — `{ ownerId?, name, description?, emoji?, visibility? }`
- `PUT /workspaces/:id` — `{ name?, description?, emoji?, visibility? }`
- `DELETE /workspaces/:id` — refused (409) while the workspace still holds lists, folders or timelines

**Folders** (scope `folders`)
- `POST /folders` — `{ ownerId?, workspaceId?, name, emoji?, isPublic? }`
- `PUT /folders/:id` — `{ name?, emoji?, isPublic? }`
- `DELETE /folders/:id`

**Lists · sections · items** (scope `lists`)
- `POST /lists` — `{ ownerId?, workspaceId?, folderId?, name, emoji?, isPublic? }` → returns the list plus a `defaultSectionId`
- `PUT /lists/:id` — `{ name?, emoji?, isPublic? }`
- `DELETE /lists/:id` — soft‑deletes to trash (30‑day restore)
- `POST /lists/:id/sections` — `{ label, emoji? }`
- `POST /items` — `{ ownerId?, title, listId?, sectionId?, note?, deadline?, priority?, workspaceId? }` — a dashboard task, or a list item when `listId` + `sectionId` are given
- `PUT /items/:id` — `{ title?, note?, deadline?, priority?, checked? }`
- `DELETE /items/:id`

**Timelines · milestones** (scope `timelines`)
- `POST /timelines` — `{ ownerId?, workspaceId?, folderId?, name, emoji?, subtitle?, color?, layout?, isPublic? }`
- `PUT /timelines/:id` — `{ name?, emoji?, subtitle?, color?, layout?, isPublic? }`
- `DELETE /timelines/:id` — soft‑deletes to trash
- `POST /timelines/:id/milestones` — `{ title, date?, time?, status?, emoji?, color?, description? }`
- `PUT /milestones/:id` — `{ title?, date?, time?, status?, emoji?, color?, description? }`
- `DELETE /milestones/:id`

**Meetings** (scope `meetings`)
- `POST /meetings` — `{ ownerId?, title, date, startTime?, endTime?, allDay?, location?, description?, color? }`
- `PUT /meetings/:id` — same fields as create
- `DELETE /meetings/:id`

Dates are `YYYY-MM-DD`, times are 24‑hour `HH:MM`, and task `priority` is one of `High` / `Medium` / `Low`.

### Examples

Create a list for a specific user, then add an item to its default section:

```bash
# Create the list
curl -X POST "https://<your-host>/api/admin-read/lists" \
  -H "Authorization: Bearer solytiq_admin_XXXXXXXX…" \
  -H "Content-Type: application/json" \
  -d '{"ownerId":"<user-id>","name":"Q3 Roadmap","emoji":"🗺️"}'
# → { "list": { "id": "list_…" }, "defaultSectionId": "sec_…" }

# Add an item to it
curl -X POST "https://<your-host>/api/admin-read/items" \
  -H "Authorization: Bearer solytiq_admin_XXXXXXXX…" \
  -H "Content-Type: application/json" \
  -d '{"ownerId":"<user-id>","listId":"list_…","sectionId":"sec_…","title":"Ship v2","priority":"High","deadline":"2026-09-01"}'
```

> **Security:** treat admin API keys like passwords. They can read and modify **all** users' data within the scopes granted. Store them in a secret manager, prefer the narrowest set of permissions, rotate periodically, and revoke unused keys.

---

## ⌨️ Keyboard Shortcuts

- **`frontend/src/shortcuts/registry.ts`** is the single source of truth for every global keyboard shortcut.
- **User overrides** are persisted to `users.keyboard_shortcuts` and managed via Account Settings → Controls.
- A global listener in `frontend/src/components/KeyboardShortcuts.tsx` handles execution and cross-component signaling.

## 🔗 n8n Community Node

The `n8n/` directory contains the source for the `n8n-nodes-solytiq-cloud` npm package. This community node wraps the instance-wide Admin API. Whenever the API changes, this node must be updated and published to npm to stay in sync.

---

## 📁 Project Structure

```text
solytiq-cloud/
├── 🌐 frontend/         # React SPA
│   ├── src/api/         # API clients & SSE logic
│   ├── src/store/       # Zustand global state (Auth, App, AI)
│   ├── src/screens/     # Main view components
│   └── src/modals/      # Wizards and overlay dialogs
├── ⚙️ backend/          # Express API
│   ├── src/routes/      # API endpoints (Workspaces, AI, Files, etc.)
│   ├── src/auth.ts      # JWT & 2FA helpers
│   └── src/db.ts        # Database connection & migrations
├── 🛡️ nginx/            # Reverse proxy & security headers
└── 🐳 docker-compose.yml # Full stack orchestration
```

---

## 🤝 Contributing

We welcome contributions! Please feel free to submit a Pull Request or open an issue for feature requests and bug reports.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

<div align="center">
  <br />
  <sub>Built with ❤️ by the Solytiq Team</sub>
</div>
