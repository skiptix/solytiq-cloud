<div align="center">
  <img src="./public/solytiq-todo-logo.svg" alt="Solytiq Cloud Logo" width="120" height="120" />
  <h1>Solytiq Cloud</h1>
  <p><strong>Your lists. Your cloud. Simple, powerful, and self-hosted.</strong></p>

  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
  [![Docker](https://img.shields.io/badge/Docker-Enabled-blue.svg?logo=docker)](https://www.docker.com/)
  [![React](https://img.shields.io/badge/Frontend-React_19-blue.svg?logo=react)](https://react.dev/)
  [![Node.js](https://img.shields.io/badge/Backend-Node.js-green.svg?logo=nodedotjs)](https://nodejs.org/)
  [![TypeScript](https://img.shields.io/badge/Language-TypeScript-blue.svg?logo=typescript)](https://www.typescriptlang.org/)
</div>

---

## Overview

**Solytiq Cloud** is a self-hosted productivity application that combines the elegance of Apple Reminders with the robustness of a power-user task manager. Designed with the **"Luminous List"** aesthetic, it features minimalist layouts, subtle glassmorphism, and lavender-white surfaces that feel lit from within.

### Key Features

- **Dashboard** — Bird's-eye view of your productivity with "Due Today" focus and priority tasks.
- **Scheduled View** — Full calendar with drag-to-schedule for unscheduled tasks.
- **Smart Lists** — Custom lists with emojis, colors, sections, subtitles, and progress tracking.
- **Folders** — Group related lists into collapsible, shareable folders.
- **Global Search** — Lightning-fast search (⌘K) across tasks, lists, and settings.
- **File Sharing** — Upload files up to 200 MB with optional password protection, expiry dates, and public share links.
- **AI Assistant** — Floating AI chat powered by OpenRouter for task suggestions and productivity help.
- **Trash & Restore** — Accidentally deleted a task? Restore it within 30 days.
- **Public Sharing** — Share individual lists or folders publicly via a read-only link.
- **Multi-User** — Admin-controlled member management with per-user 15 GB storage quota.
- **Self-Hosted** — You own your data. Deploy with a single Docker Compose command.

---

## Design Philosophy: "Luminous List"

- **Glassmorphism** — Subtle blurs and translucent layers throughout the UI.
- **Typography** — *Hanken Grotesk* for headings, *Inter* for body text.
- **Palette** — Soft lavender (`#5e4dbb`), crisp whites, and gentle grays.
- **Icons** — Material Symbols Outlined via a lightweight wrapper component.

---

## Tech Stack

### Frontend
- **Framework:** [React 19](https://react.dev/) + [Vite](https://vitejs.dev/)
- **State Management:** [Zustand](https://github.com/pmndrs/zustand)
- **Styling:** [Tailwind CSS v4](https://tailwindcss.com/)
- **Routing:** [React Router v7](https://reactrouter.com/)
- **Markdown:** [react-markdown](https://github.com/remarkjs/react-markdown)
- **Icons:** [Material Symbols Outlined](https://fonts.google.com/icons)

### Backend
- **Runtime:** [Node.js 22](https://nodejs.org/)
- **Framework:** [Express 4](https://expressjs.com/)
- **Database:** [PostgreSQL 16](https://www.postgresql.org/) (raw SQL via `pg`)
- **Authentication:** JWT + bcryptjs
- **File Uploads:** multer (200 MB limit, disk storage)
- **AI Integration:** [OpenRouter](https://openrouter.ai/) (configurable model)
- **Language:** [TypeScript](https://www.typescriptlang.org/)

### Infrastructure
- **Containerization:** [Docker](https://www.docker.com/) & [Docker Compose](https://docs.docker.com/compose/)
- **Web Server:** [Nginx](https://www.nginx.com/) (reverse proxy, gzip, SPA fallback, 210 MB upload limit)

---

## Quick Start

### Prerequisites

- Docker and Docker Compose installed on your system.

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/skiptix/solytiq-cloud.git
   cd solytiq-cloud
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and set at minimum `POSTGRES_PASSWORD` and `JWT_SECRET` (see [Configuration](#configuration)).

3. **Start the stack:**
   ```bash
   docker compose up -d
   ```

4. **Open the app:**
   Navigate to `http://localhost` in your browser. The first user to register becomes the admin.

---

## Configuration

All variables are set in your `.env` file (copied from `.env.example`).

| Variable | Description | Default |
|---|---|---|
| `POSTGRES_DB` | PostgreSQL database name | `solytiq` |
| `POSTGRES_USER` | PostgreSQL username | `solytiq` |
| `POSTGRES_PASSWORD` | PostgreSQL password — **change this** | `change_me_in_production` |
| `JWT_SECRET` | Secret key for JWT signing — **change this** | `change_this_to_a_long_random_secret` |
| `FRONTEND_URL` | Origin allowed by CORS | `http://localhost` |
| `PORT` | Host port for the frontend container | `80` |
| `OPENROUTER_API_KEY` | Enables the AI assistant (optional) | — |
| `OPENROUTER_MODEL` | AI model via OpenRouter (optional) | `openai/gpt-4o-mini` |

> **Production note:** The backend will refuse to start if `NODE_ENV=production` and `JWT_SECRET` is still set to the placeholder default.

---

## Project Structure

```
solytiq-cloud/
├── backend/            # Express REST API (TypeScript)
│   ├── src/
│   │   ├── index.ts        # Entry point, middleware, DB migrations
│   │   ├── db.ts           # PostgreSQL connection pool
│   │   ├── auth.ts         # JWT + bcrypt helpers
│   │   ├── middleware.ts   # Auth middleware
│   │   └── routes/         # auth, tasks, lists, folders, trash, files, admin, ai
│   └── package.json
├── frontend/           # React 19 + Vite SPA (TypeScript)
│   ├── src/
│   │   ├── api/client.ts   # Centralised HTTP client
│   │   ├── store/          # Zustand stores (app, auth, AI, members)
│   │   ├── components/     # Reusable UI components
│   │   ├── screens/        # Full-page views
│   │   ├── modals/         # Modal overlays
│   │   └── types.ts        # Shared TypeScript interfaces
│   └── package.json
├── nginx/              # Nginx reverse proxy configuration
├── docker-compose.yml  # Full-stack orchestration (postgres, backend, frontend)
├── .env.example        # Environment variable template
└── public/             # Static assets (logos)
```

---

## Contributing

Contributions are welcome! Please submit a Pull Request.

---

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

<div align="center">
  <sub>Built with ❤️ by the Solytiq Team</sub>
</div>
