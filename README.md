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

---

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
- 📎 **Cloud File Sharing** — Securely share files (up to 210MB) with password protection, expiry dates, and public links.
- 👥 **Multi-User & Admin** — Full member management with storage quotas and admin-controlled permissions.
- 📅 **CalDAV Server** — Built-in CalDAV support allowing native integration with external calendar apps (Apple Calendar, Thunderbird, etc.) for viewing milestones/tasks and managing meetings.
- 🗑️ **Trash & Restore** — Comprehensive protection against accidental deletions with a 30-day recovery window.

---

## 🎨 Design Philosophy: "Luminous List"

Solytiq Cloud is built on a specific aesthetic foundation designed to reduce cognitive load and enhance focus:

*   **Glassmorphism:** Subtle blurs and translucent layers that create a sense of depth.
*   **Lavender Surfaces:** A calming palette of soft lavender (`#5e4dbb`) and crisp whites.
*   **Fluid Motion:** Every interaction—from dragging lists to toggling tasks—is animated for immediate feedback.
*   **Typography:** *Hanken Grotesk* for modern headings and *Inter* for maximum readability.
*   **Styling Engine:** Tailwind CSS v4 provides base styles, combined with inline `style={{}}` objects and design tokens.

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

## 🚀 Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/) and [Docker Compose](https://docs.docker.com/compose/)

### Installation

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
    docker compose up -d
    ```

4.  **Access:**
    Navigate to `http://localhost`. The first user to register automatically becomes the **System Admin**.

---

## ⚙️ Configuration

| Variable | Required | Description | Default |
| :--- | :--- | :--- | :--- |
| `POSTGRES_DB` | Yes | Database name | `solytiq` |
| `POSTGRES_USER` | Yes | Database username | `solytiq` |
| `POSTGRES_PASSWORD` | Yes | Database password — must be changed in production | `change_me` |
| `JWT_SECRET` | Yes | Key for session signing — **fails startup if default** | `change_me` |
| `FRONTEND_URL` | Yes | Origin allowed by CORS (e.g., `http://localhost`). **Backend crashes on startup if missing.** Used for OAuth/MCP discovery when `PUBLIC_URL` is unset | `http://localhost` |
| `PUBLIC_URL` | No | Public origin (scheme + host) for OAuth issuer/endpoints and MCP | — |
| `PORT` | No | Public host port / backend listen port | `3001` (backend) / `80` (Docker) |
| `OPENROUTER_API_KEY` | No | Enables the AI assistant via OpenRouter | — |
| `OPENROUTER_MODEL` | No | AI Model (e.g., `openai/gpt-4o-mini`) | `openai/gpt-4o-mini` |

---

## 🏗️ Architecture & Core Concepts

- **Version Number** — Bump `v1.24.0` in both places in `frontend/src/components/Sidebar.tsx` on every deploy.
- **Migrations in code, not files** — `runMigrations()` in `index.ts` uses guards and idempotent data heals/seeds.
- **No ORM** — Raw SQL keeps queries explicit and avoids N+1 pitfalls; use `JOIN` freely.
- **Zustand over Redux** — Minimal boilerplate; each store is a standalone module. Stores call the API client directly; components call store actions.
- **Soft delete** — Deleted tasks, lists, folders, and timelines go to their respective `trash*` tables (JSONB payload) with a 30-day `expires_at`. The live tables have no `deleted_at` column.
- **Task IDs are BIGINT** — Generated client-side as `Date.now()` (milliseconds). Per-user FK scoping prevents cross-user collisions.
- **Workspaces scope everything** — Lists, folders, tasks, and timelines carry a `workspace_id`. Every user gets an auto-seeded private "Personal" workspace. Workspace `visibility` plus `workspace_members` govern who can see shared content in-app.
- **Two distinct notions of "public":**
  1. `is_public` on lists/folders/timelines = **in-app visibility to workspace members**.
  2. `share_enabled` + `share_token` = **anonymous read-only link** for anyone on the internet (no login), optionally password-protected and/or time-limited.
- **Real-time via SSE** — Mutations broadcast refresh signals over `/api/events`; the frontend reloads affected slices. There is no WebSocket server.
- **AI via OpenRouter** — The AI endpoint is a thin proxy. Model and enabled state live in `app_settings` so admins can change them without redeployment. Chat sessions and uploaded files expire after 30 days.
- **GPS route state is versioned** — `gps_files.route_state` is `GpsRouteStateV1`; bump the version and migrate the shape if its structure changes.
- **CalDAV Server** — Built-in read/write CalDAV server (a focused subset of RFC 4791 / WebDAV). It lets Apple Calendar, Thunderbird, etc. subscribe to everything on the Calendar page via HTTP Basic auth with generated app passwords.
- **MCP Server** — Model Context Protocol server over Streamable HTTP. It exposes the shared tool registry to external agents (e.g. the Claude MCP connector) with bearer tokens minted via an OAuth 2.1 connector flow.
- **Shared AI Tool Registry** — A single source of truth for AI capabilities (`backend/src/aiTools.ts`). Tools have a JSON-Schema parameter spec and a server-side SQL handler. Handlers receive `userId` from the verified credential only, preventing prompt-injection paths to other users' data.
- **Task Source Duality** — Tasks originate from either the Dashboard (`'dash'`) or a specific list (`'list'`). This affects which store actions update them.
- **Sublists & Linked Lists** — List tasks can embed child sublists or link to existing standalone lists, allowing complex task hierarchies and referencing.

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
