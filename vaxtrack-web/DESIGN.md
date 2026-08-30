---
name: VaxTrack
description: The Cold-Chain Console — an instrument-grade operations UI for vaccine delivery logistics
colors:
  green-950: "#0b211a"
  green-900: "#123126"
  green-800: "#1a4534"
  green-700: "#1f5c41"
  green-600: "#27714f"
  green-100: "#dbeee3"
  green-50: "#f1f8f4"
  gray-900: "#111827"
  gray-600: "#4b5563"
  gray-500: "#6b7280"
  gray-300: "#d1d5db"
  gray-200: "#e5e7eb"
  gray-100: "#f3f4f6"
  gray-50: "#f9fafb"
  surface: "#ffffff"
  sidebar-item: "#9db8ac"
  active-rail: "#8fd4b0"
  success-text: "#15803d"
  success-bg: "#e7f4ec"
  success-border: "#bbdecb"
  warning-text: "#b45309"
  warning-bg: "#fef6e7"
  warning-border: "#f2dbae"
  danger-text: "#b42318"
  danger-bg: "#fef1f0"
  danger-border: "#f5c6c0"
  info-text: "#0f766e"
  info-bg: "#e8f4f2"
  info-border: "#b9dcd7"
  transit-text: "#0d5f58"
  transit-bg: "#dceeeb"
  transit-border: "#a7d3cc"
typography:
  display:
    fontFamily: "Inter, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "normal"
  headline:
    fontFamily: "Inter, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
    fontSize: "clamp(20px, 2.4vw, 24px)"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Inter, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "normal"
rounded:
  control: "8px"
  admin: "10px"
  card: "12px"
  pill: "999px"
components:
  button-primary:
    backgroundColor: "{colors.green-700}"
    textColor: "{colors.surface}"
    rounded: "{rounded.admin}"
    padding: "0 14px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.green-800}"
    textColor: "{colors.surface}"
    rounded: "{rounded.admin}"
    height: "40px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.gray-900}"
    rounded: "{rounded.admin}"
    padding: "0 14px"
    height: "40px"
  button-danger:
    backgroundColor: "{colors.danger-bg}"
    textColor: "{colors.danger-text}"
    rounded: "{rounded.admin}"
    padding: "0 14px"
    height: "40px"
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.gray-900}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "42px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.sidebar-item}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "40px"
  nav-item-active:
    backgroundColor: "{colors.green-700}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    height: "40px"
  badge-delivered:
    backgroundColor: "{colors.success-bg}"
    textColor: "{colors.success-text}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  badge-warning:
    backgroundColor: "{colors.warning-bg}"
    textColor: "{colors.warning-text}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  badge-danger:
    backgroundColor: "{colors.danger-bg}"
    textColor: "{colors.danger-text}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  badge-info:
    backgroundColor: "{colors.info-bg}"
    textColor: "{colors.info-text}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  badge-neutral:
    backgroundColor: "{colors.gray-100}"
    textColor: "{colors.gray-600}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  kpi-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.gray-900}"
    rounded: "{rounded.card}"
    padding: "16px 20px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.gray-900}"
    rounded: "{rounded.card}"
    padding: "18px"
---

# Design System: VaxTrack

## Overview

**Creative North Star: "The Cold-Chain Console"** *(internal design metaphor, not a customer-facing product name)*

VaxTrack should feel like instrument-grade monitoring equipment entrusted with temperature-sensitive cargo — calm, precise, trustworthy, and operational. The chrome is a deep-pine console that frames the work; the work itself lives on quiet white surfaces over a soft gray field. Color is never decoration: it is a signal reserved for *state* — a delivery's status, a batch nearing expiry, a genuine exception. When every screen is mostly neutral, the one amber pill or red rail that appears is read instantly. This is the product's whole reason to exist made visible: cold-chain integrity for a pharmaceutical logistics operation, where being able to trust the interface at a glance matters.

The density is **balanced and operational** — enough information per screen for staff coordinating riders and stock under time pressure, without cramming. It is deliberately *not* the oversized, decorative, generic-SaaS look: no hero gradients, no marketing-scale cards, no ornamental motion. Depth is flat — structure comes from hairline borders and background contrast, not from stacked shadows. Motion exists only to clarify: a state change, a navigation, a loading moment, or an urgent exception, always short (140–220ms) and calmly eased.

This visual system is an **evolving foundation**, not yet uniformly applied. The dark-green "Meridian" direction is furthest along on the **Admin** pilot surfaces — Dashboard, Analytics, and Inventory — and is being unified across Sales Rep and Dispatcher. Where legacy styling still contradicts the rules below (conflicting sidebar widths, `!important` layering, dead map CSS), that is current-state drift to retire, not intended design. Document the rules here; treat the drift as anti-reference.

**Key Characteristics:**
- Deep-pine console chrome; quiet white-on-gray work surfaces.
- Color reserved for state (green normal, amber attention, red exception, teal cold-chain).
- Flat depth: hairline borders and tonal contrast, near-invisible card shadow.
- Balanced operational density — informative, never oversized or decorative.
- Tabular figures on every count, quantity, temperature, and timestamp.
- Motion only for state, navigation, loading, and exceptions.

## Colors

A restrained two-family palette — deep pine greens for identity and "normal", true (blue-free) grays for structure — with four semantic accents used sparingly for state.

### Primary
- **Deep Pine** (`#0b211a` → `#1f5c41`, the `green-950`–`green-700` ramp): The console identity. `green-950` (`#0b211a`) is the sidebar ground; `green-700` (`#1f5c41`) is the working primary — active navigation, primary buttons, links, focus, and "healthy operations". `green-800` (`#1a4534`) is the primary hover. `green-50/100` (`#f1f8f4` / `#dbeee3`) are the faint green washes for row hover and focus glow.

### Secondary — Semantic State
- **Cold-Chain Teal** (`info-text #0f766e` on `info-bg #e8f4f2`, border `#b9dcd7`; deeper in-transit variant `transit-text #0d5f58` on `transit-bg #dceeeb`): Reserved for cold-chain / live monitoring / "assigned" and "in transit" state. A muted teal, deliberately **not** blue.
- **Attention Amber** (`warning-text #b45309` on `warning-bg #fef6e7`, border `#f2dbae`): Warning only — a batch loading, stock expiring, an item needing attention. Used sparingly.
- **Exception Red** (`danger-text #b42318` on `danger-bg #fef1f0`, border `#f5c6c0`): Critical / error only — delayed, cancelled, rejected, urgent, genuine exceptions.
- **Normal Green** (`success-text #15803d` on `success-bg #e7f4ec`, border `#bbdecb`): Normal / success — delivered, approved, active, healthy.

### Neutral
- **Ink** (`gray-900 #111827`): Primary text and figures.
- **Muted / Secondary** (`gray-600 #4b5563`, `gray-500 #6b7280`): Labels, secondary text, table-header text, captions.
- **Lines & Fields** (`gray-300 #d1d5db` field borders, `gray-200 #e5e7eb` card/divider borders, `gray-100 #f3f4f6` dividers): Hairline structure.
- **Surfaces** (`surface #ffffff` cards/panels, `gray-50 #f9fafb` page field and table-header bar).

### Named Rules
**The State-Only Color Rule.** Color signals state, never decorates chrome. Navigation, page structure, and data text stay pine/neutral; a saturated accent appears only to mark a status, a warning, or an exception. Test: on a healthy screen, colored pixels should be a small minority.

**The Semantic Mapping Rule.** Green = normal / success / delivered / approved. Amber = warning / attention / expiring. Red = critical / error / delayed / cancelled / urgent. Teal = cold-chain / monitoring / assigned / in-transit. These meanings are fixed; never swap them for aesthetic reasons and never use raw hex reds/greens that bypass the semantic tokens.

## Typography

**UI Font:** Inter (with `-apple-system, "Segoe UI", Roboto, Arial, sans-serif` fallback). One family, no display or serif face.

**Character:** Neutral, legible, and quietly technical — the type equivalent of clean equipment labeling. Weight and size, not decoration, carry hierarchy.

### Hierarchy
- **Display** (Inter 700, 28px, line-height 1.15, tabular figures): KPI values and headline figures only — the numbers staff scan first.
- **Headline** (Inter 600, clamp(20px, 2.4vw, 24px), line-height ~1.2, letter-spacing −0.01em): The page `<h1>`, owned by the topbar.
- **Title** (Inter 600, ~15–16px, letter-spacing −0.01em): Card and section headings, often prefixed by a thin tick rather than an icon tile.
- **Body** (Inter 400, 15px, line-height ~1.5): Table cells and content text in ink gray.
- **Label** (Inter 500, 13–14px): Navigation items (14px), KPI/field labels (13px), secondary controls — sentence case.

### Named Rules
**The Section-Marker Rule.** UPPERCASE is reserved exclusively for tiny structural markers — sidebar nav-group labels and the page eyebrow (10–11px, weight 700, letter-spacing 0.06–0.07em). Data labels, table headers, status text, and buttons stay sentence case. Uppercasing a data label is a defect.

**The Tabular-Figures Rule.** Every count, quantity, temperature, currency, and timestamp uses `font-variant-numeric: tabular-nums` (the `.tnum` utility) so figures align in columns and don't jitter as they update.

## Layout

**Shell.** A persistent deep-pine sidebar (canonical **240px**) frames a white/gray content column; the topbar owns the page `<h1>` and any page-level actions/filters. The sidebar is a flex column — brand, role chip, profile, scrolling nav, logout pinned to the bottom (`margin-top: auto`).

**Canonical desktop rail (intended behavior).** The Admin console uses a 240px viewport-pinned desktop rail. The rail remains visible for the full viewport height while the main content scrolls independently. Its navigation may scroll internally when necessary, while Logout remains anchored at the bottom.

**Content.** A card-based operations console on a `gray-50` field: KPI row, then working cards, tables, and detail panels. Horizontal padding is a single responsive system, `clamp(16px, 2.4vw, 26px)` — no per-page offsets, no negative margins. Spacing rhythm is built on ~4px steps, with 12/16/20px the common gaps; the goal is a balanced, operational density, never oversized.

**Responsive.**
- Desktop (>900px): the 240px rail stays pinned for the full viewport height while the main column scrolls independently (the canonical desktop rail described above).
- ≤900px: sidebar becomes an off-canvas drawer (Escape, overlay scrim, body scroll-lock, focus management); a topbar menu button (44px touch target) toggles it.
- Toolbars wrap rather than clip (search grows with a min-width; filter controls and selects wrap beneath).
- Tables live inside a dedicated scroll wrapper (`overflow-x: auto`, table `min-width`) so a wide table scrolls **inside its card** — the page itself never scrolls horizontally.

**The No-Horizontal-Scroll Rule.** At every width, the page body must not scroll sideways; wide content scrolls inside its own container.

## Elevation & Depth

Flat by default. Depth is communicated by **1px neutral borders** (`gray-200` on cards, `gray-300` on fields) and quiet background contrast (`gray-50` field behind `#ffffff` surfaces), not by stacked shadows. Cards carry only a near-invisible lift; heavier elevation is reserved for temporary layers that sit above the page.

### Shadow Vocabulary
- **Card whisper** (`box-shadow: 0 1px 2px rgba(16,24,40,0.05)` — token `--shadow-card`): The only shadow on resting surfaces (cards, KPI tiles). Almost imperceptible — presence over drama.
- **Float** (`box-shadow: 0 12px 32px rgba(16,24,40,0.12)` — token `--shadow-float`): Temporary layers only — modals, drawers, dropdowns, tooltips, the open mobile sidebar.

### Named Rules
**The Flat-Surface Rule.** Resting surfaces are flat with hairline borders. If a surface has a strong shadow, it must be a temporary layer (modal/drawer/dropdown/tooltip); otherwise the shadow is decoration and does not belong.

**The No-Stacking Rule.** Do not stack cards on shadows to fake hierarchy. Group with spacing, borders, and background contrast instead.

## Shapes

Restrained, squared-ish corners — nothing pill-soft except badges and avatars. Three working radii: **8px** (`--radius-control`) for inputs and small controls; **10px** (`--admin-radius`) for buttons and operations-console cards; **12px** (`--radius-card`) for cards, modals, and banners; and **999px** (`--radius-pill`) for badges, chips, and avatars. Borders are hairline (1px) and neutral. No skeuomorphism, no heavy rounding, no clipped/angled silhouettes. (The 8/10/12 spread is a mild real variance; keep controls at 8, buttons at 10, cards at 12 rather than inventing new radii.)

## Components

### Buttons
- **Shape:** Gently rounded (10px), 40px tall, `0 14px` padding, inline-flex with an optional leading icon.
- **Primary:** Deep-pine fill (`green-700 #1f5c41`), white text, card-whisper shadow; hover darkens to `green-800 #1a4534`.
- **Secondary:** White fill, `gray-300` border, ink text; hover fills `gray-50`.
- **Danger:** Tinted, not loud — `danger-bg` fill with `danger-text` label, reserved for destructive actions.
- **Focus:** Visible green focus ring (`2px` outline in `green-600`/`green-100`, `1px` offset). Never remove focus styling.

### Status Badges
- **Style:** Pill (999px), `4px 10px`, 12px weight-600 **sentence-case** text, 1px transparent border tinted per state, a 6px leading status dot.
- **State map:** delivered → green (`success`), assigned → teal (`info`), in-transit → deeper teal (`transit`), loading → amber (`warning`), delayed → red (`danger`), pending/cancelled → neutral gray. One shared badge component owns these; pages do not hand-roll status chips.

### KPI Cards
- **Style:** White, 12px radius, 1px `gray-200` border, card-whisper shadow, `16px 20px` padding, min-height ~104px.
- **Value:** 28px weight-700 ink, tabular figures. **Label:** 13px weight-500 `gray-600`, sentence case.
- **Attention variant:** a 3px `danger-text` top border (`.m-kpi-attention`) — the only accent a KPI carries. Clickable KPIs get a subtle border/`gray-50` hover and a green focus ring.

### Cards / Containers
- **Corner:** 12px. **Background:** white on the `gray-50` field. **Border:** 1px `gray-200`. **Shadow:** card-whisper only (see Elevation). **Padding:** ~18px. Section headings inside may carry a thin left tick, not an icon tile.

### Inputs / Fields
- **Style:** White fill, 1px `gray-300` border, 8px radius, ~42px tall; the visible border lives on the field wrapper so the inner `<input>` is borderless/transparent.
- **Focus:** `green-700` border + a soft 3px `green-100` glow (`box-shadow: 0 0 0 3px`). Consistent green focus across all fields — no blue.
- **Disabled/Error:** lean on the semantic tokens (neutral for disabled, `danger` set for error); never introduce new field colors.

### Navigation
- **Style:** Deep-pine rail; items are muted sage (`sidebar-item #9db8ac`), 14px weight-500, 40px tall, 8px radius, with a leading icon.
- **States:** hover fills `green-900` and lightens text; **active** fills `green-700` with white text, weight 600, plus a 3px mint precision rail (`active-rail #8fd4b0`) on the left edge and `aria-current="page"`. Group markers (Operations / Records / System) are 10px uppercase muted pine-gray.
- **Focus:** `2px green-600` outline. **Mobile (≤900px):** off-canvas drawer with overlay, Escape-to-close, and focus return to the menu button.

### Tables
- **Header:** sits on a quiet `gray-50` bar; **sentence-case** `gray-600` 12px labels, left-aligned, `15px 12px` padding — never uppercase.
- **Cells:** 15px ink, `16px 12px` padding, 1px `gray-200` bottom divider.
- **Rows:** hover fills faint `green-50`; a critical row carries a left inset rail. Long IDs truncate/wrap with the full value accessible.

## Do's and Don'ts

### Do:
- **Do** reserve color for state: green = normal/success, amber = warning, red = critical/error, teal = cold-chain/in-transit/monitoring — via the semantic tokens, not raw hex.
- **Do** keep chrome and data neutral (pine + gray); let a single accent do the signaling on an otherwise quiet screen.
- **Do** keep surfaces flat — hairline `gray-200`/`gray-300` borders and `gray-50` contrast for structure; card-whisper shadow only.
- **Do** reserve the float shadow (`0 12px 32px / 12%`) for temporary layers — modals, drawers, dropdowns, tooltips.
- **Do** use tabular figures (`.tnum`) on every count, quantity, temperature, and timestamp.
- **Do** keep motion short (140–220ms), calmly eased, and purposeful — state change, navigation, loading, urgent exception only.
- **Do** use one 240px sidebar width everywhere, with logout pinned bottom and the full-height rail independent of page length.
- **Do** contain wide tables inside their own scroll wrapper so the page never scrolls horizontally.
- **Do** treat accessibility, responsiveness, and performance as system requirements: visible green focus rings, `aria-current` on active nav, honored `prefers-reduced-motion`, WCAG-legible text contrast, working ≤900px drawer, and route-scoped CSS (no global page-CSS bloat, no heavy shadow/animation cost).

### Don't:
- **Don't** apply generic-SaaS styling: no hero gradients, decorative animation, oversized/marketing-scale cards, or unnecessary color.
- **Don't** flood green as a decorative brand color — it means "normal/success", and its restraint is what makes state readable.
- **Don't** uppercase data labels, table headers, status text, or buttons; uppercase is only for tiny nav-group markers and the page eyebrow.
- **Don't** add decorative shadows or stack cards on shadows to fake hierarchy.
- **Don't** introduce blue as an accent (the "info" role is muted teal) or invent field/status colors outside the semantic set.

### Known legacy inconsistencies — do not canonize
These exist in the code today and must be treated as anti-reference, not as design rules to preserve:
- **Conflicting sidebar widths.** `styles.css` declares `.inventory-sidebar` at 245 / 248 / 280px in several places; the **canonical rail is 240px** in the shared `AdminSidebar`. Do not reuse the legacy widths.
- **Duplicated / page-specific sidebar rules.** The sidebar must come from one shared component, not re-declared per page; do not canonize the duplicated declarations.
- **Desktop sidebar scroll defect (open).** The global `overflow-x: hidden` on `html/body/#root` plus `.inventory-page { width: 100vw }` defeats `position: sticky`, so on long pages (e.g. Analytics) the rail can scroll away and reveal white space beneath it. The canonical target is the viewport-pinned fixed rail described in Layout; do not document the current sticky-then-scroll-away behavior as intended, and do not assume the fixed rail is already reliably in place.
- **`!important` layering.** The `!important` flags in `meridian-shell.css`, `ui.css`, and `admin-polish.css` exist only to beat legacy broad selectors; they are transitional, to be dropped as pages migrate — not a styling technique to imitate.
- **Class-name misnomers & raw hex.** `.v2-blue-action` is now green; some rows use raw `#ef4444` instead of `danger-text`. Follow the semantic tokens, not the legacy names/values.
- **Uneven role coverage.** Admin (Dashboard/Analytics/Inventory) leads; Sales Rep and Dispatcher are still being unified. Consistency across roles is a goal, and current gaps are drift, not intent.
