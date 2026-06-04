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
- 🚀 **Dashboard** — A bird's-eye view of your day featuring "Due Today" focus, priority tracking, and productivity stats.
- 📅 **Scheduled View** — A full interactive calendar with drag-and-drop scheduling for unscheduled tasks.
- 📂 **Folders & Lists** — Deeply nestable folders and smart lists with custom emojis, colors, and progress tracking.
- ⚡ **Real-time Sync (SSE)** — Changes sync instantly across all devices via Server-Sent Events.
- 🔒 **Enhanced Security** — Built-in TOTP 2FA support, JWT-based authentication, and hardened security headers.
- 🤖 **AI Assistant** — A floating AI chat powered by OpenRouter to help you break down tasks and stay productive.
- 📎 **Cloud File Sharing** — Securely share files (up to 210MB) with password protection, expiry dates, and public links.
- 👥 **Multi-User & Admin** — Full member management with storage quotas and admin-controlled permissions.
- 🗑️ **Trash & Restore** — Comprehensive protection against accidental deletions with a 30-day recovery window.

---

## 🎨 Design Philosophy: "Luminous List"

Solytiq Cloud is built on a specific aesthetic foundation designed to reduce cognitive load and enhance focus:

*   **Glassmorphism:** Subtle blurs and translucent layers that create a sense of depth.
*   **Lavender Surfaces:** A calming palette of soft lavender (`#5e4dbb`) and crisp whites.
*   **Fluid Motion:** Every interaction—from dragging lists to toggling tasks—is animated for immediate feedback.
*   **Typography:** *Hanken Grotesk* for modern headings and *Inter* for maximum readability.

---

## 🛠️ Tech Stack

### Frontend
- **Framework:** [React 19](https://react.dev/) + [Vite](https://vitejs.dev/)
- **State Management:** [Zustand](https://github.com/pmndrs/zustand) (with persistence)
- **Routing:** [React Router 7](https://reactrouter.com/)
- **Styling:** Modern CSS (Design Tokens) with refined animations
- **Communication:** [Server-Sent Events (SSE)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) for real-time updates

### Backend
- **Runtime:** [Node.js 22](https://nodejs.org/) (Alpine-based)
- **Framework:** [Express 4](https://expressjs.com/)
- **Database:** [PostgreSQL 16](https://www.postgresql.org/)
- **Auth:** JWT + [otplib](https://github.com/yeoju/otplib) (TOTP 2FA) + bcryptjs
- **File Handling:** Multer (with disk storage)
- **AI Integration:** [OpenRouter API](https://openrouter.ai/)

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

| Variable | Description | Default |
| :--- | :--- | :--- |
| `POSTGRES_PASSWORD` | Database password (**Required**) | `change_me` |
| `JWT_SECRET` | Key for session signing (**Required**) | `change_me` |
| `FRONTEND_URL` | Allowed CORS origin | `http://localhost` |
| `PORT` | Public host port | `80` |
| `OPENROUTER_API_KEY` | API Key for AI Assistant | — |
| `OPENROUTER_MODEL` | AI Model (e.g., `openai/gpt-4o-mini`) | `openai/gpt-4o-mini` |

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
