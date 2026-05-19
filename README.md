# Solytiq Cloud: High-Fidelity Master Specification
Version: 1.1.0
Status: ACTIVE / SOURCE OF TRUTH

## 1. Brand Identity & Product Vision

### 1.1 Core Mission
Solytiq Cloud is a premium, self-hosted productivity ecosystem designed for high-performance users. It mimics the effortless simplicity of Apple Reminders while providing the robustness of a self-hosted cloud suite. The focus is on "Local-First" speed with "Cloud-Sync" reliability.

### 1.2 Visual Metaphor: "Luminous List"
The design language, titled **Luminous List**, is defined by:
- **Clarity:** Minimalist layouts that prioritize content over chrome.
- **Depth:** Subtle use of glassmorphism (backdrop blurs) and 1px borders instead of heavy shadows.
- **Luminosity:** A palette built on extremely light lavender whites that feel "lit from within" rather than flat gray.
- **Precision:** Perfect geometric alignment, especially in the 1080x1920 login view.

### 1.3 Brand Assets
- **Product Name:** Solytiq Cloud (Verbatim casing and spacing required).
- **Primary Brand Mark:** `{{DATA:IMAGE:IMAGE_6}}`.
  - **Visual Composition:** Rounded square with a three-layer gradient.
  - **Top Layer:** Soft Yellow (`#FFF2AC`).
  - **Middle Layer:** Signature Lavender (`#9D8DFF`).
  - **Bottom Layer:** Deep Charcoal/Black (`#111111`) with a centered white checkmark.
  - **Usage:** Always rendered with `rounded-2xl` or `ROUND_EIGHT` depending on context.

---

## 2. Design Tokens (The Atomic Layer)

### 2.1 Color Palette
The system uses a refined lavender-based neutral system to avoid the sterile "enterprise blue" or "dead gray" of typical apps.

#### 2.1.1 Core Brand Colors
| Token | Hex | Usage |
| :--- | :--- | :--- |
| `primary` | `#9D8DFF` | CTAs, Active States, Logo Middle-band |
| `on-primary` | `#FFFFFF` | Text/Icons on Primary backgrounds |
| `primary-container` | `#E8E4FF` | Soft highlights, Active menu item tints |
| `on-primary-container` | `#3A2D80` | High-contrast text on primary-container |

#### 2.1.2 Surface & Backgrounds
| Token | Hex | Usage |
| :--- | :--- | :--- |
| `surface` | `#FDF8FF` | Main application background (Lavender White) |
| `surface-dim` | `#DDD8E2` | Subtle section backgrounds, disabled states |
| `surface-container-low` | `#F7F2FC` | Sidebar background |
| `surface-container` | `#F0EBF5` | Hover states in sidebar |
| `surface-bright` | `#FFFFFF` | Card backgrounds, search bar fill |

#### 2.1.3 Functional Colors (Status)
| Token | Hex | Usage |
| :--- | :--- | :--- |
| `success` | `#1A7A3C` | "Synced" status, completed checkboxes |
| `warning` | `#E8500A` | Low progress, "Achtung" badges, sync errors |
| `info` | `#1D4ED8` | "Empfehlung" / Tips, blue system badges |
| `outline-variant` | `#EEEEEE` | Standard 1px borders |
| `outline` | `#CCCCCC` | Checkbox borders (inactive) |

### 2.2 Typography (The Hanken System)
The primary typeface is **Hanken Grotesk**. It provides a modern, geometric feel with high legibility.

#### 2.2.1 Heading Scale
- **Display (Hero):** 32px / 2rem, Bold, -0.02em tracking. Used for Login "Welcome Back".
- **Headline (Page Title):** 24px / 1.5rem, Bold, #111111. Used for "Dashboard", "Settings".
- **Section Title:** 12px / 0.75rem, Bold, Uppercase, 0.08em letter-spacing, #333333.

#### 2.2.2 Body & Labels
- **Body Large:** 16px, Regular, #444444. Main task titles.
- **Body Medium:** 14px, Medium, #666666. Sub-navigation, notes.
- **Caption:** 11px, Medium, #999999. Metadata, "0 von 7 Punkten", Footer text.
- **Badge Text:** 11px, Semi-Bold, Uppercase. Inside Status Pills.

### 2.3 Shapes & Spacing
- **Corner Radius:**
  - `ROUND_EIGHT` (8px): Default for Cards, Buttons, Inputs, Modals.
  - `Pill` (9999px): Search bars, Status badges, Filter buttons.
- **Spacing Grid:** 4px baseline.
  - `px-margin-page`: 24px (standard horizontal padding).
  - `gap-stack-item`: 12px (vertical spacing between tasks).
  - `sidebar-width`: 256px.

---

## 3. Component Architecture

### 3.1 Sidebar (The Navigator)
- **Structure:**
  - **Header:** Brand Logo (32px size) + "Solytiq Cloud" (Headline-sm) + "Local Storage Active" (Caption).
  - **Primary Actions:** Large Button "Add List" with Lavender Tint.
  - **System Lists:** Today, Scheduled, All, Flagged.
  - **Divider:** 1px line separating system lists from user lists.
  - **User Lists:** Dynamic section (e.g., "Backyard 2026").
  - **Footer:** "Completed" and "Trash" fixed at the bottom.
- **States:**
  - **Active:** `bg-primary-container`, `text-primary`, `font-bold`.
  - **Inactive:** `text-on-surface-variant`, hover `bg-surface-container`.

### 3.2 Top Navigation Bar
- **Behavior:** `sticky top-0`, `z-50`, `bg-surface/80`, `backdrop-blur-md`.
- **Search Bar:**
  - Pill-shaped, centered.
  - Icon: `search` (Material Symbols).
  - Placeholder: "Search lists, tasks, or settings...".
- **Status Area (Right):**
  - Settings Cog (`settings` icon).
  - Sync Badge: Pill with green dot + "● SYNCED" text.

### 3.3 Task Items (The Data Units)
- **Layout:** Flex row, `items-start`.
- **Checkbox:**
  - Fixed 20x20px.
  - Position: Left-aligned, next to the title.
  - Radius: 5px.
  - Color: `#1A7A3C` (Checked), `#CCCCCC` (Unchecked).
- **Content:**
  - Title: `font-medium`, 14px.
  - Note: `text-caption`, sits below title.
  - Badges: Placed below notes. `bg-amber-100` for warnings, `bg-blue-100` for tips.

### 3.4 Modals & Wizards
- **Overlay:** `bg-black/20`, `backdrop-blur-sm`.
- **Wizard Card:**
  - `max-w-[440px]`, `rounded-xl`, `shadow-2xl`.
  - Content: Header with title + Close icon (X).
  - Form: Input fields with 8px radius, consistent borders.
- **Action Menu (Item-level):**
  - Appears on click of vertical dots.
  - Options: Edit, Share, Delete (Red text).

---

## 4. Screen-Specific Logic

### 4.1 Dashboard Overview
- **Header Grid:** 4 key cards summarizing Today, Scheduled, All, Flagged.
  - Large numbers (Display-md).
  - Subtle icons in circles.
- **Today's Focus:** A preview list of high-priority tasks.

### 4.2 List View (Packliste / Checklist)
- **Hero Area:**
  - Large Percentage Display (e.g., "0%").
  - Progress Bar: Lavender or Success green when 100%.
  - Contextual Metadata: "Hamburg's Backyard Ultra".
- **Sections:** Groups tasks by icon + Uppercase label (e.g., "🚴 RAD & ANTRIEB").

### 4.3 Login Screen (1080x1920 Viewport)
- **Alignment:** Absolute geometric center using `flex items-center justify-center min-h-screen`.
- **Flow:** Logo → "Welcome Back" → Email Input → Password Input → Sign In Button → "Forgot Password?" link.

---

## 5. Motion & Interaction

### 5.1 Transitions
- **Hover States:** 200ms `ease-in-out` on all buttons and nav items.
- **Page Transitions:** Fade-in with 20px vertical slide-up.
- **Checkbox Toggle:** 150ms transform scale (95% -> 100%) on click.

### 5.2 Micro-interactions
- **Sync Pulse:** The green dot in the sync badge has a subtle 2s opacity pulse.
- **Wizard Entrance:** Scale-up from 95% with `cubic-bezier(0.34, 1.56, 0.64, 1)`.

---

## 6. Implementation Notes for Agents

### 6.1 Logic for Creating New Screens
- **Constraint 1:** Never use colors outside the Luminous List palette.
- **Constraint 2:** Checkboxes MUST always be fixed to the left of the item title.
- **Constraint 3:** All page headers must include the Glassmorphism Top Bar.
- **Constraint 4:** Sidebar is mandatory on all authenticated screens.

### 6.2 Verbatim Dictionary
- Brand: `Solytiq Cloud`
- Status: `SYNCED`, `LOCAL STORAGE ACTIVE`
- Buttons: `Add List`, `Sign In`, `Reset`

---

## 7. Extended Component Library (JSON-Ready)

### 7.1 Sidebar Detail
```json
{
  "name": "SideNavBar",
  "width": "256px",
  "bg": "#F7F2FC",
  "header": {
    "logo": "IMAGE_6",
    "title": "Solytiq Cloud",
    "subtext": "Local Storage Active"
  },
  "items": ["Today", "Scheduled", "All", "Flagged"],
  "user_lists": ["Backyard 2026"],
  "footer": ["Completed", "Trash"]
}
```

### 7.2 Top Bar Detail
```json
{
  "name": "TopAppBar",
  "height": "64px",
  "blur": "10px",
  "search_placeholder": "Search lists, tasks, or settings...",
  "sync_indicator": {
    "text": "SYNCED",
    "color": "#1A7A3C"
  }
}
```

## 8. State Matrix

| Component | State | Style |
| :--- | :--- | :--- |
| Button | Default | bg-primary, text-white |
| Button | Hover | bg-primary/90, scale-102 |
| Checkbox | Open | border-outline, bg-transparent |
| Checkbox | Done | border-success, bg-success |
| Nav Item | Active | bg-primary-container, font-bold |
| Input | Focus | border-primary, shadow-sm |

---

## 9. Accessibility & Internationalization

- **Contrast:** Maintain WCAG AA compliance (4.5:1) for all body text against surface.
- **Localization:** Default English. Previous iterations used German (`Packliste`, `Erledigt`). Ensure logic supports dynamic string replacement.
- **Focus States:** 2px solid primary ring for keyboard navigation.

## 10. Design Consistency Checklist
- [ ] Is the Lavender palette maintained?
- [ ] Are all corner radii 8px?
- [ ] Is the sidebar width 256px?
- [ ] Is the Hanken Grotesk font applied?
- [ ] Are checkboxes on the left?
- [ ] Is the sync status badge in the top right?

---
*End of Master Specification*
