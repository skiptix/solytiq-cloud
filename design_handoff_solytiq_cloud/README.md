# Handoff: Solytiq Cloud — Full App Implementation

> **Design reference files are in `design_files/`.**
> Open `design_files/index.html` in a browser to see the complete, fully-interactive prototype. 
> These HTML files are **design references only** — do not ship them. Recreate every screen in React + TypeScript using the specs below.

---

## Overview

**Solytiq Cloud** is a cloud, self-hosted productivity app combining the simplicity of Apple Reminders with power-user robustness. It is a task and list manager with cloud-sync capability.

**Design language: "Luminous List"** — minimalist layouts, subtle glassmorphism, lavender-white surfaces that feel lit from within.

---

## Fidelity

**High-fidelity.** The prototype is pixel-perfect. Recreate colors, typography, spacing, border radii, shadows, hover states, animations, and all interactions exactly as designed.

---

## Target Repository

`github.com/skiptix/solytiq-cloud` — push to `main` branch.

---

## Recommended Tech Stack

| Concern | Choice |
|---|---|
| Framework | Vite + React 18 + TypeScript |
| Styling | Tailwind CSS v4 |
| State | Zustand with `persist` middleware (localStorage) |
| Routing | React Router v6 |
| Icons | Material Symbols Outlined (Google Fonts CDN) |
| Fonts | Hanken Grotesk + Inter (Google Fonts CDN) |
| Date utils | `date-fns` |
| Build | Vite |

---

## Project Structure

```
src/
├── main.tsx
├── App.tsx
├── index.css               ← Tailwind + CSS custom properties
├── store/
│   ├── useAppStore.ts      ← Zustand store (tasks, lists, trash)
│   └── useAuthStore.ts     ← Auth state (admin registered, logged in)
├── components/
│   ├── Sidebar.tsx
│   ├── TopBar.tsx          ← includes GlobalSearch
│   ├── TaskItem.tsx
│   ├── QuickAdd.tsx
│   ├── EditModal.tsx
│   ├── DeleteConfirmModal.tsx
│   ├── TaskDetailPopup.tsx
│   ├── CalendarPicker.tsx
│   └── Icon.tsx            ← thin wrapper around Material Symbol spans
├── screens/
│   ├── LoginScreen.tsx
│   ├── SetupWizard.tsx
│   ├── DashboardScreen.tsx
│   ├── ListScreen.tsx
│   ├── ScheduledScreen.tsx
│   └── SettingsScreen.tsx
└── modals/
    ├── AddListWizard.tsx
    ├── CompletedModal.tsx
    └── TrashModal.tsx
```

---

## Design Tokens

### Colors

```css
/* Primary */
--color-primary:        #5e4dbb;
--color-primary-light:  #9d8dff;
--color-primary-bg:     #F5F3FF;
--color-primary-hover:  #5044aa;

/* Surfaces (light → dark) */
--color-page:           #fdf8ff;
--color-sidebar:        #f7f2fc;
--color-hover:          #f1ecf6;
--color-card:           #F9FAFB;
--color-border:         #E5E7EB;
--color-border-soft:    #e8e4f0;

/* Text */
--color-text-primary:   #1c1b22;
--color-text-body:      #484552;
--color-text-muted:     #787584;
--color-text-faint:     #b0acbe;

/* Semantic */
--color-success:        #10B981;
--color-warning:        #ea580c;
--color-danger:         #ba1a1a;
--color-info:           #1D4ED8;

/* Priority */
--color-priority-high:   #ea580c;
--color-priority-medium: #f59e0b;
--color-priority-low:    #787584;
```

### Typography

```css
/* Headings, labels, buttons, nav */
font-family: 'Hanken Grotesk', sans-serif;
/* weights: 500, 600, 700 */

/* Body, notes, captions */
font-family: 'Inter', sans-serif;
/* weights: 400, 500 */
```

| Role | Font | Size | Weight |
|---|---|---|---|
| Page h1 | Hanken Grotesk | 28px | 700 |
| Section header | Hanken Grotesk | 22px | 700 |
| Card title | Hanken Grotesk | 17px | 700 |
| Nav label | Hanken Grotesk | 13.5px | 500 |
| Button | Hanken Grotesk | 13px | 600 |
| Eyebrow / ALL CAPS label | Hanken Grotesk | 9–11px | 700, tracking 0.08em |
| Task title | Inter | 14px | 400 |
| Task note | Inter | 12px | 400 |
| Caption / sub | Inter | 11px | 400 |

### Spacing & Radii

| Token | Value |
|---|---|
| Sidebar width | 256px (collapsible to 60px) |
| Content max-width | 680px (lists/settings) |
| Content max-width | 1080px (dashboard) |
| Page padding | 32px |
| Card padding | 16–20px |
| Radius: default | 8px |
| Radius: cards | 12px |
| Radius: modals | 14–16px |
| Radius: pill | 9999px |

### Shadows

```css
/* Cards — use border instead of shadow */
border: 1px solid #E5E7EB;

/* Modals */
box-shadow: 0 12px 40px rgba(0,0,0,0.18);

/* Dropdowns / popups */
box-shadow: 0 8px 32px rgba(0,0,0,0.14);

/* Input focus ring */
box-shadow: 0 0 0 4px rgba(94,77,187,0.12);
```

### Animations

```css
/* Standard hover/transition */
transition: all 180ms ease-in-out;

/* Spring bounce (modals, wizard) */
animation: modalIn 280ms cubic-bezier(0.34, 1.56, 0.64, 1);

/* Checkbox toggle */
transition: all 150ms ease-in-out;

/* Sync dot ping */
animation: ping 2s ease-in-out infinite;
```

---

## Screens

### 1. Login Screen

**Purpose:** Returning users sign in with username + password.

**Layout:** Full viewport, centered card (max-width 400px), lavender gradient background (`linear-gradient(135deg, #f0ebff 0%, #fdf8ff 60%, #f5f0ff 100%)`).

**Elements:**
- Logo (44×44px, rounded-xl, `solytiq-todo-logo.png`) + "Solytiq Cloud" (Hanken Grotesk 24px 700, `#5e4dbb`) + tagline "Your lists. Your cloud." (Inter 12px, `#b0acbe`)
- Username input (label: "Username")
- Password input (label: "Password") with show/hide toggle
- "Sign In" button — full width, `#5e4dbb` bg, white text, 48px tall, radius 10px
- "Forgot password?" link — right-aligned, Inter 12px, `#787584`
- Credentials stored in `localStorage` via `useAuthStore`

**Behavior:**
- Validate against stored admin credentials on submit
- Shake animation on wrong credentials
- On success → navigate to Dashboard

---

### 2. Setup Wizard

**Purpose:** First-time setup — creates admin account.

**Layout:** Full viewport, same lavender gradient as Login. Centered card, max-width 420px.

**Steps (3-step progress dots):**

**Step 1 — Welcome**
- Logo + "Welcome to Solytiq Cloud" heading
- "Create your admin account to get started." subtitle
- "Get Started" button

**Step 2 — Create Account**
- "Username" input
- "Email" input
- "Password" input (min 8 chars)
- "Create Account" button (disabled until all fields valid)

**Step 3 — Done**
- Checkmark animation
- "You're all set!" heading
- "Go to Dashboard" button

**Progress dots:** 3 dots at bottom of card. Active dot is wider (28px), done dots are `#5e4dbb`, pending are `#ebe6f0`.

---

### 3. Dashboard Screen

**Purpose:** Overview of all tasks with stats, due-today/this-week panels, quick add, and the full todo list.

**Layout:** `margin-left: sidebarWidth`, scrollable, `maxWidth: 1080px` centred, 32px padding.

**Sections top → bottom:**

#### Header
- Date string (e.g. "Tuesday, May 20") — Inter 12px 600 uppercase, `#9d8dff`
- "Dashboard" h1 — Hanken Grotesk 28px 700
- Subtitle: "{N} tasks due today and {M} more this week." — Inter 13.5px, `#787584`
- Overdue badge (right): red pill with warning icon — only shown when overdue tasks exist

#### Stats row (4-column grid)
Each stat card: `#F9FAFB` bg, `1px solid #E5E7EB` border, 12px radius.
- **Open Tasks** — count, "N total" sub-badge, inventory icon (`#5e4dbb`)
- **Completed** — count, "N%" sub-badge, check_circle icon (green `#10B981`)
- **Due Today** — count, "Focus" or "Clear", today icon (orange `#ea580c`)
- **Due This Week** — count, "Upcoming", calendar icon (`#1D4ED8`)

#### Progress bar
Label "This week's progress" + "N done · M open". Bar: 8px tall, `#ebe6f0` track, gradient fill `#9d8dff → #5e4dbb`, 100% = `#10B981`.

#### Observer panels (2-column grid)
**Due Today** (left) + **Due This Week** (right).
Each panel: up to 5 task rows (`MiniTaskRow`), then a "+ N more" dashed button that opens `TasksDetailModal`.

`MiniTaskRow`: checkbox (18×18px, radius 5px) + title + list name + deadline chip. Clicking row title opens `TaskDetailPopup`.

#### Quick Add
Full-width text input. On Enter or → button: adds task to dashboard tasks. Pencil icon reveals `EditModal` for full details before saving.

#### Todos section
Header: "TODOS" eyebrow + filter pills (All / Dashboard / [list dropdown]) + sort button.
Shows first 5 tasks as `TaskItem` rows. If more exist: "+ N more" button → opens `TasksDetailModal`.

`TasksDetailModal`: full-screen overlay (backdrop-blur, zIndex 1000), scrollable task list with search + filter pills (All / Open / Completed) + sort menu. All task rows use `TaskItem`.

---

### 4. List Screen

**Purpose:** Manage a specific user-created list, grouped by sections.

**Layout:** `maxWidth: 680px`, centred, 32px padding.

**Elements:**

#### Hero card
- List name (Hanken Grotesk 22px 700) + subtitle + "N of M done"
- Completion % (Hanken Grotesk 40px 700, `#5e4dbb`) — top right
- Progress bar (6px, same style as Dashboard)
- "N completed / M remaining" meta row

#### Sections
Each section:
- Section header: emoji + ALL CAPS label (Hanken Grotesk 12px 700, `#5e5e5e`) + horizontal rule
- `TaskItem` rows (drag-to-reorder within section)

#### Quick Add
"Add new item…" input at bottom, same component as Dashboard but scoped to this list.

---

### 5. Scheduled Screen

**Purpose:** Calendar view of all tasks with deadlines. Drag unscheduled tasks onto calendar days.

**Layout:** Full height, horizontal split: calendar (flex: 1) + resize handle + unscheduled sidebar (240px default, resizable).

#### Calendar
- Month navigation (← Month Year →) + "Today" button
- 7-column CSS grid, 6 rows
- Each day cell: min-height 96px, today cell has `#faf8ff` bg + `1.5px solid #c8bfff` border
- Tasks shown as small chips (title truncated, colored dot for priority)
- Clicking chip → `TaskDetailPopup`
- Up to 3 chips per cell; "+N more" text if overflow

#### Unscheduled sidebar
- Search input
- Draggable task rows (`UnscheduledItem`) — drag onto day cells to assign deadline

---

### 6. Settings Screen

**Purpose:** Edit profile, manage sync preferences, danger zone.

**Layout:** `maxWidth: 680px`, centred, 32px padding, section-by-section cards.

**Sections:**

#### Profile
- Avatar (56×56px circle, gradient bg, initials) + name + email
- "Full Name" text field
- "Email Address" email field
Fields have bottom-border focus style (no box border).

#### Sync
- Status card: cloud_sync icon + "Local Storage Active" + last synced time + "Sync Now" button
- "Automatic Sync" toggle row
- "Storage Location" info row ("This device" pill)

#### Sign Out button
Full width, red (`#ba1a1a`), 48px tall.

#### Danger Zone (admin only, hidden by default)
"Nuke Everything" — 3-step confirmation modal: (1) warning list, (2) type "NUKE", (3) password confirm.

---

## Components

### Icon

```tsx
// Renders a Material Symbol
function Icon({ name, size = 20, color }: { name: string; size?: number; color?: string }) {
  return (
    <span
      className="material-symbols-outlined"
      style={{ fontSize: size, color, lineHeight: 1 }}
    >
      {name}
    </span>
  );
}
```

Load via `index.html`:
```html
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">
```

### Sidebar

- Fixed left, 256px wide (resizable via drag handle on right edge, snap to 60px mini mode)
- Background: `#f7f2fc`, right border: `1px solid #E5E7EB`
- **Header:** Logo (44px) + "Solytiq Cloud" + tagline (hidden in mini mode)
- **Nav items:** today (Dashboard), calendar_month (Scheduled)
- **Divider**
- **Add List button** → opens `AddListWizard`
- **User lists** — draggable to reorder, each shows emoji + name
- **Footer:** check_circle (Completed) + delete (Trash) → open respective modals
- Mini mode (≤72px): icons only, tooltip on hover

### TopBar

- `position: sticky; top: 0; z-index: 50`
- Glassmorphism: `background: rgba(253,248,255,0.92); backdrop-filter: blur(12px)`
- **GlobalSearch** (centred, max-width 440px):
  - Pill input expands on focus to rectangular with purple border
  - Dropdown folds out below when typing with results grouped:
    - **Tasks** (purple group header, up to 5)
    - **Lists** (blue group header, up to 3)
    - **Settings** (green group header, up to 3)
  - Each result: icon/emoji + title (match highlighted) + subtitle + type tag pill
  - Keyboard: ↑↓ navigate, ↵ open, Esc close
  - ⌘K shortcut focuses the bar
  - Match text highlighted: `background: #ede9ff; color: #5e4dbb; font-weight: 700`
- **Settings icon button** (right)
- **Synced badge** — green dot (ping animation) + "SYNCED" text

### TaskItem

Full task row component used in Dashboard, List, and TasksDetailModal.

```
[drag-handle] [checkbox] [title + meta] [more ⋮]
```

- **Checkbox:** 20×20px, radius 5px, `#c9c4d5` border → `#5e4dbb` fill + white checkmark on check
- **Content area** (clickable → TaskDetailPopup): title + optional note + meta row
- **Meta row:** list badge + deadline + priority flag + tag badge
- **More button** (visible on hover): context menu with Edit / Delete
- **Drag handle** (visible on hover, left of more button)
- Checked state: title opacity 0.4 + strikethrough
- `draggable` only when drag handler props are passed (prevents modal close bug)
- Hover: background `#F5F3FF`

### TaskDetailPopup

Floating card (320px wide) anchored near click point. `zIndex: 1100` (above TasksDetailModal at 1000).

- 4px colored top stripe (priority color or `#5e4dbb`)
- Title + close button
- Meta: deadline, priority, badge, note, source list
- Actions: "Edit Task" button + "Go to task" button (list tasks only)
- Backdrop: full-screen transparent overlay, click to close

### EditModal / CreateModal

Centred overlay modal, max-width 440px.

Fields: Task Name (text), Notes (textarea), Deadline (CalendarPicker dropdown), Priority (3-button toggle: High / Medium / Low), Tag (pill toggles: Work / Personal / Urgent / Tip).

### CalendarPicker

Inline calendar widget (month grid). Previous/next month nav. Today highlighted. Selected date highlighted `#5e4dbb`.

### AddListWizard

Multi-step wizard modal (max-width 480px):
1. List name + emoji picker
2. Add sections (optional)
3. Done

### CompletedTrashModal

Full-screen overlay with tab switcher (Completed | Trash). Scrollable list of tasks. Trash tasks have "Restore" + "Delete permanently" actions.

---

## State Management

### useAppStore (Zustand + persist)

```ts
interface AppState {
  // Tasks
  dashTasks: Task[];
  setDashTasks: (tasks: Task[] | ((prev: Task[]) => Task[])) => void;

  // Lists
  lists: List[];
  setLists: (lists: List[] | ((prev: List[]) => List[])) => void;
  updateListTask: (listId: string, taskId: number, updates: Partial<Task>) => void;
  deleteListTask: (listId: string, taskId: number) => void;

  // Trash
  trashTasks: TrashedTask[];
  addToTrash: (task: Task, meta: TrashMeta) => void;
  restoreFromTrash: (taskId: number) => void;
  deleteFromTrash: (taskId: number) => void;
}
```

### useAuthStore (Zustand + persist)

```ts
interface AuthState {
  adminRegistered: boolean;
  loggedIn: boolean;
  username: string;
  email: string;
  register: (admin: AdminCredentials) => void;
  signIn: (username: string, password: string) => boolean;
  signOut: () => void;
}
```

### TypeScript interfaces

```ts
interface Task {
  id: number;
  title: string;
  checked: boolean;
  deadline?: string;         // ISO date YYYY-MM-DD
  time?: string;
  priority?: 'High' | 'Medium' | 'Low';
  badge?: string;            // tag label
  note?: string;
  // runtime-added (not persisted)
  _source?: 'dash' | 'list';
  _listId?: string;
  _listName?: string;
}

interface Section {
  id: string;
  label: string;
  emoji?: string;
  tasks: Task[];
}

interface List {
  id: string;
  name: string;
  emoji?: string;
  color?: string;
  colorBg?: string;
  subtitle?: string;
  sections: Section[];
}
```

---

## Navigation / Routing

```
/               → redirect to /dashboard (if logged in) or /login
/login          → LoginScreen
/setup          → SetupWizard (first-time only, redirect away if admin exists)
/dashboard      → DashboardScreen
/scheduled      → ScheduledScreen
/list/:listId   → ListScreen
/settings       → SettingsScreen
```

Use `React Router v6` with a protected route wrapper that checks `useAuthStore().loggedIn`.

---

## Interactions & Behaviour

### Task toggle (checkbox)
- Immediate optimistic update in store
- 150ms transition on checkbox fill
- Checked tasks: opacity 0.4, strikethrough on title

### Drag to reorder
- Dashboard tasks: reorder within `dashTasks` array
- List tasks: reorder within section (or move between sections)
- Drag handle visible on hover only
- Drop indicator: `2px solid #9d8dff` top border on target row

### TasksDetailModal ("+N more")
- Opens over Dashboard with `zIndex: 1000`, backdrop-blur
- Internal filter: All / Open / Completed
- Internal sort: Date asc/desc, Name A-Z/Z-A
- Backdrop click only closes if `e.target === e.currentTarget`
- Checking a task does NOT close the modal

### TaskDetailPopup
- Appears at `zIndex: 1100` (above TasksDetailModal)
- Positioned near click coordinates, auto-flips if near viewport edge
- Clicking anywhere outside closes it

### Global search
- ⌘K or Ctrl+K focuses search input
- Results appear only when query length ≥ 1
- Groups: Tasks (max 5), Lists (max 3), Settings (max 3)
- Each result navigates on click / Enter

### Sidebar resize
- Drag the right edge handle
- Snap to 60px mini mode if dragged below 140px
- Persist width to localStorage

---

## Assets

| File | Usage |
|---|---|
| `design_files/../../assets/solytiq-todo-logo.png` | Sidebar logo, Login logo |
| `design_files/../../assets/solytiq-todo-logo.svg` | SVG version (preferred) |

Copy both into `public/assets/` in the Vite project.

---

## Design Reference Files

| File | Contents |
|---|---|
| `design_files/index.html` | **Full interactive prototype** — open this in a browser |
| `design_files/DashboardCards.jsx` | Dashboard screen implementation |
| `design_files/TaskItem.jsx` | TaskItem + QuickAdd + EditModal + DeleteConfirmModal |
| `design_files/TopBar.jsx` | TopBar + GlobalSearch |
| `design_files/ListScreen.jsx` | List screen |
| `design_files/ScheduledScreen.jsx` | Scheduled screen + TaskDetailPopup |
| `design_files/LoginScreen.jsx` | Login screen |
| `design_files/SetupWizard.jsx` | Setup wizard |
| `design_files/CompletedTrashModal.jsx` | Completed + Trash modal |
| `design_files/AddListWizard.jsx` | Add list wizard |
| `design_files/CalendarPicker.jsx` | Calendar picker widget |
| `design_files/Icons.jsx` | Icon component |
| `design_files/Sidebar.jsx` | Sidebar component |

The JSX files use vanilla React + Babel (no build step). Read them for component logic, interaction patterns, exact CSS values, and animation specs. Then reimplement cleanly in TypeScript.
