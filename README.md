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

## 🌟 Overview

**Solytiq Cloud** is a self-hosted productivity application that combines the elegance of Apple Reminders with the robustness of a power-user task manager. Designed with the **"Luminous List"** aesthetic, it features minimalist layouts, subtle glassmorphism, and lavender-white surfaces that feel lit from within.

### ✨ Key Features

- 📊 **Dashboard:** A bird's-eye view of your productivity with real-time stats and "Due Today" focus.
- 📅 **Scheduled View:** A full-featured calendar to manage deadlines and drag-to-schedule unscheduled tasks.
- 📝 **Smart Lists:** Create custom lists with emojis, sections, and progress tracking.
- 🔍 **Global Search:** Lightning-fast search (⌘K) for tasks, lists, and settings.
- ♻️ **Trash & Restore:** Accidentally deleted a task? No problem, restore it from the trash within 30 days.
- 🔒 **Self-Hosted:** You own your data. Deploy easily with Docker.

---

## 🎨 Design Philosophy: "Luminous List"

Solytiq Cloud isn't just a tool; it's an experience.
- **Glassmorphism:** Subtle blurs and translucent layers.
- **Typography:** Using *Hanken Grotesk* for headings and *Inter* for body text.
- **Palette:** Soft lavender (`#5e4dbb`), crisp whites, and gentle grays.

---

## 🛠️ Tech Stack

### Frontend
- **Framework:** [React 19](https://react.dev/) + [Vite](https://vitejs.dev/)
- **State Management:** [Zustand](https://github.com/pmndrs/zustand)
- **Styling:** [Tailwind CSS v4](https://tailwindcss.com/)
- **Routing:** [React Router v7](https://reactrouter.com/)
- **Icons:** [Material Symbols Outlined](https://fonts.google.com/icons)

### Backend
- **Runtime:** [Node.js](https://nodejs.org/)
- **Framework:** [Express](https://expressjs.com/)
- **Database:** [PostgreSQL](https://www.postgresql.org/)
- **Authentication:** JWT + Bcrypt
- **Language:** [TypeScript](https://www.typescriptlang.org/)

### Infrastructure
- **Containerization:** [Docker](https://www.docker.com/) & [Docker Compose](https://docs.docker.com/compose/)
- **Web Server:** [Nginx](https://www.nginx.com/)

---

## 🚀 Quick Start

Deploying Solytiq Cloud is straightforward using Docker.

### Prerequisites
- Docker and Docker Compose installed on your system.

### Installation Steps

1. **Clone the repository:**
   ```bash
   git clone https://github.com/skiptix/solytiq-cloud.git
   cd solytiq-cloud
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```
   *Edit the `.env` file to set your `JWT_SECRET` and database passwords.*

3. **Spin up the containers:**
   ```bash
   docker-compose up -d
   ```

4. **Access the application:**
   Open your browser and navigate to `http://localhost`.

---

## ⚙️ Configuration

The following environment variables can be configured in your `.env` file:

| Variable | Description | Default |
|----------|-------------|---------|
| `POSTGRES_USER` | PostgreSQL username | `solytiq` |
| `POSTGRES_PASSWORD` | PostgreSQL password | `solytiq_secret` |
| `POSTGRES_DB` | PostgreSQL database name | `solytiq` |
| `JWT_SECRET` | Secret key for JWT signing | `change_me` |
| `PORT` | Host port for the frontend | `80` |

---

## 📁 Project Structure

```text
├── backend/            # Express API with TypeScript
├── frontend/           # Vite + React application
├── nginx/              # Nginx configuration for reverse proxy
├── design_handoff_solytiq_cloud/  # Original design specs and interactive prototype
├── docker-compose.yml  # Orchestration for the entire stack
└── public/             # Static assets (logos, icons)
```

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

## 📜 License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

<div align="center">
  <sub>Built with ❤️ by the Solytiq Team</sub>
</div>
