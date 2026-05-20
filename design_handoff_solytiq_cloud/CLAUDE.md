# Claude Code — Solytiq Cloud Implementation Brief

You are implementing **Solytiq Cloud** — a local-first productivity app (task + list management).

## Your mission

1. Initialise a new **Vite + React + TypeScript** project in this repository root
2. Implement all 6 screens exactly as designed (see `README.md` and `design_files/`)
3. Wire up all navigation, state, and interactions
4. Commit and push everything to the `main` branch of `skiptix/solytiq-cloud`

## Step-by-step

```bash
# 1. Scaffold the project
npm create vite@latest . -- --template react-ts
npm install

# 2. Install dependencies
npm install zustand tailwindcss @tailwindcss/vite
npm install -D @types/node

# 3. Init Tailwind
npx tailwindcss init -p

# 4. Start coding — see README.md for full specs
```

## Critical rules

- **Never copy the HTML prototype files into src/** — they are design references only
- Use the **exact hex values** from the Design Tokens section in README.md
- Fonts: load **Hanken Grotesk** and **Inter** from Google Fonts in `index.html`
- Icons: load **Material Symbols Outlined** from Google Fonts CDN — do NOT install an npm package
- State must be persisted to **localStorage** (Zustand `persist` middleware)
- Every component must be **TypeScript-typed** — no `any`
- File structure must follow the layout in README.md exactly

## Design reference

Open `design_files/index.html` in a browser to interact with the full prototype.
Every screen, animation, hover state, and modal is live in that file.
Use it as your ground truth for UI behaviour.

## Git workflow

```bash
git remote set-url origin https://github.com/skiptix/solytiq-cloud.git
git add .
git commit -m "feat: initial Solytiq Cloud implementation"
git push origin main
```

Push after each major screen is complete, not only at the end.
