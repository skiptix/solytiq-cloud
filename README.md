# Solytiq Cloud Design System

**Version:** 1.1.0 | **Status:** Active Source of Truth

## Product Overview

**Solytiq Cloud** is a premium, self-hosted productivity ecosystem — a task and list management app that combines the effortless simplicity of Apple Reminders with the robustness of a self-hosted cloud suite. It is a "Local-First" app with "Cloud-Sync" reliability, targeting high-performance users who want speed and control.

### Design Language: "Luminous List"
The visual identity is defined by:
- **Clarity** — Minimalist layouts that prioritize content over chrome
- **Depth** — Subtle glassmorphism (backdrop blurs) and 1px borders instead of heavy shadows
- **Luminosity** — Palette built on extremely light lavender-whites that feel "lit from within"
- **Precision** — Perfect geometric alignment and tight typographic scale

---

## Sources

| Source | Path / Link |
|--------|-------------|
| Figma File | `solytiq-cloud-fig.fig` (mounted as virtual FS at `/`) |
| Codebase | `stitch_solytiq-cloud-design/` (local mount) |
| Logo PNG | `uploads/solytiq-todo-logo.png` |
| Logo SVG | `uploads/solytiq-todo-logo.svg` |

### Figma Frames (Page 1)
- `Dashboard - Advanced Actions & Branding` — Main dashboard with sidebar, top nav, bento grid
- `Login - Solytiq Cloud` — Centered login card on lavender background
- `Backyard 2026 List - Unified Layout` — Checklist view with progress hero + sections
- `Settings - Unified Layout Fixed Sync` — Settings screen with row-based navigation

---

## Content Fundamentals

### Tone & Voice
- **Composed, efficient, and inviting** — bridges high-utility productivity with warmth
- Bridges Apple Reminders-style simplicity with power-user robustness
- Short, direct copy; no marketing fluff
- Action-first labels: "Add List", "Sign In", "Reset" — not "Create a New List"

### Casing Rules
- **UI Labels:** Title Case — "Today", "Scheduled", "Add List"
- **Section Titles:** ALL CAPS with tracking — "TODAY'S FOCUS", "RAD & ANTRIEB"
- **Status Badges:** ALL CAPS — "SYNCED", "LOCAL STORAGE ACTIVE"
- **Button text:** Title Case — "Sign In", "Forgot password?"
- **Body copy:** Sentence case — "Sign in to continue."

### Emoji Usage
- Used sparingly and contextually in list section labels (e.g. "🚴 RAD & ANTRIEB")
- Never used in navigation, buttons, or status indicators
- Purpose: tactile categorization for user-defined lists only

### Language Notes
- Default: English
- Historical iteration used German (Packliste, Erledigt) — design supports i18n
- "Solytiq Cloud" always written verbatim with this exact casing

### Examples of Copy in the Product
- Header subtitle: "Sign in to continue."
- Sidebar footer status: "Local Storage Active"
- Sync badge: "SYNCED"
- Placeholder: "Search lists, tasks, or settings..."
- Quick add: "Add a new task for Today..."

---

## Visual Foundations

### Color
The palette is anchored by **deep lavender** (`#5e4dbb`) as the primary interactive color, balanced by a warm **lavender-white** surface (`#fdf8ff`) that makes the interface feel luminous. A **soft yellow** secondary (`#6e5e0d` / `#f6df84`) provides contextual warmth for highlights. **Emerald green** (`#10B981`) handles success states including the live sync indicator.

Neutral grays are intentionally lavender-tinted rather than pure gray — `#484552` for body text, `#787584` for placeholders and icons.

See: `colors_and_type.css` and `preview/` cards.

### Typography
**Dual-font system:**
- **Hanken Grotesk** — Headings, labels, navigation items, buttons. Modern geometric feel, high legibility. Weights: 600 (SemiBold) and 700 (Bold).
- **Inter** — Body text, captions, notes. Utilitarian and highly readable. Weights: 400 (Regular) and 500 (Medium).

Hierarchy is established through weight shifts, not dramatic size changes. Section titles use ALL CAPS + expanded tracking as structural anchors.

### Backgrounds & Surfaces
- No full-bleed photography or illustrations
- No repeating patterns or textures
- Tonal layering: `#fdf8ff` (page) → `#f7f2fc` (sidebar) → `#f1ecf6` (hover) → `#ffffff` (cards)
- Glassmorphism: `backdrop-blur-md` + `bg-surface/80` exclusively for sticky top bar

### Animation & Motion
- **Hover states:** 200ms `ease-in-out` on all interactive elements
- **Page transitions:** Fade + 20px vertical slide-up
- **Checkbox toggle:** 150ms scale transform (0.95 → 1.0)
- **Wizard entrance:** `cubic-bezier(0.34, 1.56, 0.64, 1)` spring bounce, scale 0.95 → 1.0
- **Sync pulse:** 2s `animate-ping` on the green dot
- No aggressive bounce; animations are quick and purposeful

### Hover / Press States
- **Nav items (hover):** Background shifts to `#f1ecf6` (surface-container)
- **Cards (hover):** Border shifts from `border-subtle` to `primary` color
- **Buttons (hover):** Opacity 90%, subtle scale-up (scale-[1.02])
- **Active/pressed:** `scale-[0.98]` compression
- **Task rows (hover):** Background → `lavender-tint` (`#F5F3FF`)

### Borders & Elevation
Rejects traditional box shadows in favor of **tonal borders**:
- **Level 0:** `#fdf8ff` page background
- **Level 1:** `#F9FAFB` cards with `1px` border `#E5E7EB`
- **Active/focus:** 2px `primary` border replaces shadow
- **Glassmorphism:** Sticky top bar only — `backdrop-blur-md` + `rgba(253,248,255,0.8)`
- Shadows are extremely subtle when used: `0 1px 2px rgba(0,0,0,0.05)` only

### Corner Radii
- **8px (ROUND_EIGHT):** Default — buttons, inputs, modals, task rows, small cards
- **12px:** Dashboard bento grid cards
- **`rounded-xl` (12px/16px):** Settings row items, modals
- **`9999px` (Pill):** Search bar, status badges (SYNCED), filter chips

### Cards
- White (`#FFFFFF`) or surface-muted (`#F9FAFB`) background
- `1px solid #E5E7EB` border
- No drop shadow (or `0 1px 2px rgba(0,0,0,0.05)` maximum)
- Hover: border color → primary lavender
- Radius: 8–16px depending on context

### Imagery & Color Vibe
- No photography in core UI
- Brand logo: rounded square with three-layer gradient (yellow top → lavender middle → dark bottom with white checkmark)
- Color palette is cool-toned (lavender, purple) with warm yellow accent
- No grain, no noise, no heavy texture

### Layout Rules
- Sidebar: 256px wide, fixed left, `bg-surface-container-low` (`#f7f2fc`), `border-r`
- Content: max-width 680px centered in main area
- Top bar: sticky, `z-50`, glassmorphism blur
- Page horizontal padding: 24px
- Mobile: sidebar becomes bottom nav bar + hamburger

### Iconography
See ICONOGRAPHY section below.

---

## ICONOGRAPHY

### System: Material Symbols Outlined
The app exclusively uses **Google Material Symbols Outlined** loaded via CDN:
```
https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap
```
Usage: `<span class="material-symbols-outlined">icon_name</span>`
Fill variant: `font-variation-settings: 'FILL' 1` for active/filled states.

### Icons Used
| Icon Name | Usage |
|-----------|-------|
| `search` | Top bar search input |
| `settings` | Top bar settings button |
| `today` | Today nav item |
| `calendar_month` | Scheduled nav item |
| `inventory_2` | All lists nav item |
| `flag` | Flagged nav item |
| `add` | Add List button |
| `format_list_bulleted` | User list items |
| `check_circle` | Completed nav item |
| `delete` | Trash nav item |
| `more_vert` | Task row action menu |
| `arrow_upward` | Quick add submit |
| `chevron_right` | Settings row indicator |
| `person`, `palette`, `cloud_sync`, `manage_accounts` | Settings items |

### Copied SVGs (from Figma)
Located in `assets/icons/` — raw SVG extracts for key icons used in the Figma file.

### No custom icon set — all icons are Material Symbols
Emoji is used only in user-defined list section headers for categorical labeling.

---

## File Index

```
/
├── README.md                  ← This file
├── SKILL.md                   ← Agent skill definition
├── colors_and_type.css        ← All CSS custom properties (tokens)
├── assets/
│   ├── solytiq-todo-logo.svg  ← Primary logo (SVG, preferred)
│   ├── solytiq-todo-logo.png  ← Primary logo (PNG)
│   ├── solytiq-logo.png       ← Full-size logo (from Figma)
│   ├── solytiq-logo-sm.png    ← Small logo (from Figma)
│   └── icons/                 ← SVG icons extracted from Figma
├── preview/                   ← Design System tab cards
│   ├── colors-brand.html
│   ├── colors-surfaces.html
│   ├── colors-semantic.html
│   ├── type-scale.html
│   ├── type-specimens.html
│   ├── spacing-tokens.html
│   ├── shape-radius.html
│   ├── elevation-borders.html
│   ├── component-buttons.html
│   ├── component-inputs.html
│   ├── component-checkboxes.html
│   ├── component-badges.html
│   ├── component-task-item.html
│   ├── component-sidebar.html
│   ├── component-topbar.html
│   ├── component-cards.html
│   ├── brand-logo.html
│   └── brand-motion.html
└── ui_kits/
    └── solytiq-cloud/
        ├── README.md
        ├── index.html          ← Interactive app prototype
        ├── Sidebar.jsx
        ├── TopBar.jsx
        ├── TaskItem.jsx
        ├── DashboardCards.jsx
        ├── LoginScreen.jsx
        └── ListScreen.jsx
```
