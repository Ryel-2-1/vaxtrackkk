import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Shared Admin sidebar layout.
//
// The sidebar had two shells: AdminLayout (a fixed rail + a mobile drawer) used
// by 3 of the 13 Admin pages, and a raw <AdminSidebar> used by the other 10
// with no drawer at all and a `position: sticky` that could not work. These
// tests pin the single-system result: one drawer, one breakpoint, one width.
//
// Source-shape assertions: this repo has no jsdom/RTL and adding one would be a
// dependency change, matching the other suites here. Runtime behaviour was
// measured in the browser and is recorded in the commit message.

const here = dirname(fileURLToPath(import.meta.url));
const src = (...p) => readFileSync(join(here, "..", "src", ...p), "utf8");

const sidebarJsx = src("components", "admin", "AdminSidebar.jsx");
const sidebarCss = src("components", "admin", "AdminSidebar.css");
const layoutJsx = src("components", "admin", "AdminLayout.jsx");
const layoutCss = src("components", "admin", "AdminLayout.css");
const polishCss = src("pages", "admin", "admin-polish.css");

// ---------------------------------------------------------------------------
// One drawer, not two
// ---------------------------------------------------------------------------

test("the drawer lives in the sidebar, which every Admin page renders", () => {
  assert.match(sidebarJsx, /className="admin-nav-toggle"/);
  assert.match(sidebarJsx, /className="admin-nav-backdrop"/);
  assert.match(sidebarJsx, /useState\(false\)/, "the sidebar owns the open state");
});

test("AdminLayout renders no second toggle, overlay or open state", () => {
  // Two implementations would stack two scrims and two controls.
  for (const gone of [
    "adl-menu-btn",
    "adl-overlay",
    "useState",
    "menuBtnRef",
    "adl-open",
    "Menu",
  ]) {
    assert.ok(!layoutJsx.includes(gone), `${gone} must no longer be in AdminLayout`);
  }
  assert.ok(!layoutCss.includes("adl-menu-btn"), "its styles must go too");
  assert.ok(!layoutCss.includes("adl-overlay"));
  // What it still owns:
  assert.match(layoutJsx, /<AdminSidebar active=\{active\} onLogout=\{handleLogout\} \/>/);
  assert.match(layoutJsx, /<h1>\{title\}<\/h1>/, "the topbar still owns the page h1");
});

test("the legacy rail block was removed from admin-polish rather than left to drift", () => {
  assert.ok(
    !polishCss.includes(".inventory-page:not(.adl-root) aside.inventory-sidebar"),
    "the shell-split rail rule must be gone"
  );
  assert.ok(
    !polishCss.includes("padding-left: 280px"),
    "the hard-coded 280px reserve must be gone — it drifted from the 240px rail"
  );
});

// ---------------------------------------------------------------------------
// One breakpoint
// ---------------------------------------------------------------------------

test("markup and stylesheet agree on a single 1000px breakpoint", () => {
  assert.match(sidebarJsx, /matchMedia\("\(max-width: 1000px\)"\)/);
  assert.match(sidebarCss, /@media \(max-width: 1000px\)/);
  assert.match(sidebarCss, /@media \(min-width: 1001px\)/);
});

test("the 900/901 boundary that left 901-1000px with neither shell is gone", () => {
  for (const file of [sidebarCss, layoutCss, sidebarJsx, layoutJsx]) {
    assert.ok(!file.includes("max-width: 900px"), "no drawer at 900px");
    assert.ok(!file.includes("min-width: 901px"), "no rail at 901px");
  }
});

// ---------------------------------------------------------------------------
// One width
// ---------------------------------------------------------------------------

test("the rail and the content offset read the same variable", () => {
  assert.match(sidebarCss, /--admin-sidebar-width: 280px/);
  assert.match(
    sidebarCss,
    /width: var\(--admin-sidebar-width\) !important/,
    "the rail is sized from the variable"
  );
  assert.match(
    sidebarCss,
    /padding-left: var\(--admin-sidebar-width\) !important/,
    "and the page reserves exactly that much"
  );
  // The old fallback let the rail render 240px against a 280px reserve.
  assert.ok(
    !sidebarCss.includes("--admin-sidebar-width, 240px"),
    "no divergent fallback width"
  );
});

test("AdminLayout's own margin offset cannot stack on top of the reserve", () => {
  assert.ok(
    !layoutCss.includes("margin-left: var(--admin-sidebar-width)"),
    "AdminLayout must not add a second offset"
  );
  assert.match(sidebarCss, /\.adl-root > \.adx-main \{\s*margin-left: 0 !important;/);
});

// ---------------------------------------------------------------------------
// Desktop: the rail stays in the viewport
// ---------------------------------------------------------------------------

test("the desktop rail is fixed, not sticky", () => {
  // sticky is inert here: `overflow-x: hidden` on html/body/#root makes #root a
  // scroll container that never scrolls internally, so a sticky rail scrolls
  // away with the document and takes the brand, account card and Logout with it.
  const desktop = sidebarCss.slice(sidebarCss.indexOf("@media (min-width: 1001px)"));
  assert.match(desktop, /position: fixed !important/);
  assert.match(desktop, /height: 100dvh !important/);
  assert.ok(!/position: sticky/.test(desktop), "sticky must not return");
});

test("only nav scrolls — the rail itself never becomes a second scroll box", () => {
  assert.match(sidebarCss, /aside\.inventory-sidebar \{[\s\S]*?overflow: hidden !important/);
  assert.match(
    sidebarCss,
    /aside\.inventory-sidebar nav \{[\s\S]*?overflow-y: auto !important/
  );
});

test("Logout stays pinned to the bottom and outranks the 8px rule", () => {
  // admin-polish.css sets `margin-top: 8px !important` on the same element at
  // equal specificity, and the two files' order is bundler-decided.
  assert.match(
    sidebarCss,
    /\.inventory-page > aside\.inventory-sidebar \.sidebar-logout \{[\s\S]*?margin-top: auto !important/
  );
});

// ---------------------------------------------------------------------------
// Mobile: a real drawer, and nothing focusable behind it
// ---------------------------------------------------------------------------

test("the closed drawer is removed from the tab order, not just moved off-screen", () => {
  const mobile = sidebarCss.slice(sidebarCss.indexOf("@media (max-width: 1000px)"));
  assert.match(mobile, /transform: translateX\(-100%\)/);
  assert.match(mobile, /visibility: hidden/, "translation alone leaves it focusable");
  assert.match(mobile, /\.admin-nav-open \{[\s\S]*?visibility: visible/);
});

test("visibility is stepped so the drawer can take focus the moment it opens", () => {
  // Easing visibility means `focus()` lands on a still-hidden node and does
  // nothing; delaying it on close keeps the panel on screen while it slides out.
  assert.match(sidebarCss, /transition: transform 180ms ease, visibility 0s linear 180ms/);
  assert.match(sidebarCss, /transition: transform 180ms ease, visibility 0s;/);
});

test("the drawer never exceeds the viewport it slides over", () => {
  const mobile = sidebarCss.slice(sidebarCss.indexOf("@media (max-width: 1000px)"));
  assert.match(mobile, /width: min\(var\(--admin-sidebar-width\), 86vw\) !important/);
  assert.match(mobile, /min-width: 0 !important/, "the 280px min-width must be released");
});

test("page content clears the fixed toggle instead of sitting under it", () => {
  const mobile = sidebarCss.slice(sidebarCss.indexOf("@media (max-width: 1000px)"));
  assert.match(mobile, /padding-top: 64px !important/);
  assert.match(mobile, /padding-left: 0 !important/, "no desktop reserve on mobile");
});

// ---------------------------------------------------------------------------
// The toggle's contract
// ---------------------------------------------------------------------------

test("the toggle is labelled, and announces the state of the panel it controls", () => {
  assert.match(sidebarJsx, /aria-expanded=\{open\}/);
  assert.match(sidebarJsx, /aria-controls="admin-nav"/);
  assert.match(sidebarJsx, /id="admin-nav"/, "aria-controls must resolve to the aside");
  assert.match(
    sidebarJsx,
    /aria-label=\{open \? "Close navigation menu" : "Open navigation menu"\}/
  );
});

test("every documented way of dismissing the drawer is wired", () => {
  assert.match(sidebarJsx, /e\.key === "Escape"/, "Escape");
  assert.match(sidebarJsx, /className="admin-nav-backdrop" onClick=\{close\}/, "backdrop");
  assert.match(sidebarJsx, /\}, \[location\.pathname\]\)/, "selecting a destination");
  assert.match(sidebarJsx, /if \(!mq\.matches\) setOpen\(false\)/, "growing to desktop");
  assert.match(sidebarJsx, /onClick=\{\(\) => setOpen\(\(v\) => !v\)\}/, "the toggle itself");
});

test("focus moves into the drawer and returns to the control that opened it", () => {
  assert.match(sidebarJsx, /asideRef\.current\?\.querySelector\("a, button"\)\?\.focus\(\)/);
  assert.match(sidebarJsx, /toggle\?\.focus\(\)/, "restored on close");
  assert.match(sidebarJsx, /document\.body\.style\.overflow = "hidden"/, "scroll locked");
  assert.match(
    sidebarJsx,
    /document\.body\.style\.overflow = prevOverflow/,
    "and restored, not hard-coded back to a guess"
  );
});

test("listeners are removed when the drawer closes or unmounts", () => {
  assert.match(sidebarJsx, /document\.removeEventListener\("keydown", onKey\)/);
  assert.match(sidebarJsx, /mq\.removeEventListener\("change", sync\)/);
});

// ---------------------------------------------------------------------------
// Horizontal overflow and the desktop-width root
// ---------------------------------------------------------------------------

test("the Admin page is 100% wide, not 100vw", () => {
  // 100vw includes the classic scrollbar — 1440 against a 1425 content box —
  // so the page always overflowed and `overflow-x: hidden` only hid it.
  assert.match(sidebarCss, /#root > \.inventory-page \{[\s\S]*?width: 100% !important/);
});

test("the 1126px root is corrected for Admin only, not globally", () => {
  // index.css pins `#root { width: 1126px }` and styles.css uncaps it with
  // `max-width: none !important`, so a 390px viewport laid out as a desktop.
  assert.match(sidebarCss, /#root:has\(> \.inventory-page\) \{/);
  assert.match(sidebarCss, /max-width: 100% !important/);
  // Scoped: Sales Rep / Dispatcher / Login must be untouched by this fix.
  assert.ok(!sidebarCss.includes("salesrep"), "no cross-role reach");
  assert.ok(!sidebarCss.includes("dispatcher"));
});

// ---------------------------------------------------------------------------
// Scope: the navigation itself is unchanged
// ---------------------------------------------------------------------------

test("all nine destinations and Logout survive, with their active styling", () => {
  for (const to of [
    "/admin",
    "/admin/inventory",
    "/admin/deliveries",
    "/admin/riders",
    "/admin/clinics",
    "/admin/invoices",
    "/admin/analytics",
    "/admin/alerts",
    "/admin/settings",
  ]) {
    assert.ok(sidebarJsx.includes(`to="${to}"`), `${to} must still be linked`);
  }
  assert.match(sidebarJsx, /aria-current=\{active === "dashboard" \? "page" : undefined\}/);
  assert.match(sidebarJsx, /className=\{active === "inventory" \? "active" : ""\}/);
  assert.match(sidebarJsx, /className="sidebar-logout" onClick=\{onLogout\}/);
});

test("no Admin page had to change to get the drawer", () => {
  // The whole point of moving it into the sidebar: pages keep rendering
  // <AdminSidebar> inside `.inventory-page` exactly as before.
  const dir = join(here, "..", "src", "pages", "admin");
  const pages = readdirSync(dir).filter((f) => f.endsWith(".jsx"));
  const raw = pages.filter((f) => {
    const body = readFileSync(join(dir, f), "utf8");
    return body.includes("<AdminSidebar") && !body.includes("AdminLayout");
  });
  assert.ok(raw.length >= 10, `expected the legacy pages to be untouched, saw ${raw.length}`);
  for (const f of raw) {
    const body = readFileSync(join(dir, f), "utf8");
    // Three of them append their own shell class (`inventory-page clinics-shell`),
    // so this checks for the class token the selectors key on, not an exact
    // attribute string — the selectors are class-based and match either form.
    assert.match(
      body,
      /className="inventory-page(?:[ "])/,
      `${f} must keep the wrapper the layout selectors depend on`
    );
  }
});
