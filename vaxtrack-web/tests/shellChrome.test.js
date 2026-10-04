import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// One sidebar and one top bar for every web role.
//
// The three role shells had drifted apart: Admin had no top bar (each page drew
// its own large heading), Sales Rep's bar was 72px with a search box of its own
// size, and Dispatcher's was 64px with a 16px title, a decorative "VaxTrack
// Logistics" chip and its wordmark marked up as a second <h1>. The rails were
// 280 / 250 / 260px wide, nav items 40–54px tall, and only two of the three
// showed who was signed in.
//
// Source-shape assertions, like the other suites here (no jsdom/RTL in this
// repo). The geometry itself was measured in the browser at 1440, 1000, 900
// and 390px against all three shells.

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");
// Strip comments so prose that mentions "<h1>" never satisfies or breaks an
// assertion about markup.
const code = (...p) =>
  read(...p)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SHELLS = {
  admin: ["src/components/admin/AdminShell.jsx", "src/components/admin/AdminSidebar.jsx"],
  salesrep: ["src/pages/salesRep/SalesRepShell.jsx"],
  dispatcher: ["src/pages/dispatcher/DispatcherLayout.jsx"],
};
const shellCode = (role) => SHELLS[role].map((f) => code(f)).join("\n");

const chrome = read("src", "styles", "shell-chrome.css");

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

test("every role renders the same top bar, and it owns the page's one <h1>", () => {
  for (const role of Object.keys(SHELLS)) {
    const src = shellCode(role);
    assert.match(src, /<header className="[^"]*\bm-topbar\b[^"]*">/, `${role}: shared top bar`);
    const h1s = src.match(/<h1\b[^>]*>/g) || [];
    assert.deepEqual(h1s, ['<h1 className="m-topbar-title">'], `${role}: exactly one <h1>, in the top bar`);
  }
});

test("only working controls sit in the top bar", () => {
  // Sales Rep and Dispatcher have a real global search and notification feed.
  for (const role of ["salesrep", "dispatcher"]) {
    const src = shellCode(role);
    assert.match(src, /className="[^"]*\bm-topbar-actions\b/, role);
    assert.match(src, /<form\s+className="[^"]*\bm-topbar-search\b[^"]*"\s+onSubmit=/, `${role}: search submits`);
    assert.match(src, /className=\{?[`"][^`"]*\bm-topbar-icon-btn\b/, `${role}: bell`);
  }
  // Admin has neither, so it gets the title alone — no decorative search/bell.
  const admin = shellCode("admin");
  assert.doesNotMatch(admin, /m-topbar-search|m-topbar-icon-btn|m-topbar-actions/);
  // The decorative chip on the Dispatcher bar is gone, and an unknown route
  // falls back to a real page title like Sales Rep does, not the old slogan.
  const dispatcher = code("src/pages/dispatcher/DispatcherLayout.jsx");
  assert.doesNotMatch(dispatcher, /dispatcher-hub|VaxTrack Logistics/);
  assert.match(dispatcher, /\{ key: "dashboard", title: "Dashboard" \}/);
});

test("Admin titles every route from the URL, including nested invoices", () => {
  const shell = code("src/components/admin/AdminShell.jsx");
  for (const [path, title] of [
    ["/admin", "Dashboard"],
    ["/admin/inventory", "Inventory"],
    ["/admin/deliveries", "Deliveries"],
    ["/admin/riders", "Riders"],
    ["/admin/clinics", "Clinics"],
    ["/admin/invoices", "Invoices"],
    ["/admin/analytics", "Analytics"],
    ["/admin/alerts", "Alerts"],
    ["/admin/settings", "Settings"],
  ]) {
    assert.ok(shell.includes(`"${path}": "${title}"`), `${path} → ${title}`);
  }
  assert.match(shell, /pathname\.startsWith\("\/admin\/invoices\/"\)\) return "Invoice";/);
  // A unique class: `.admin-topbar` is an old styles.css name that forced a
  // 34px heading onto the new bar below 1000px.
  assert.match(shell, /className="m-topbar admin-shell-topbar"/);
  assert.doesNotMatch(chrome, /\.admin-topbar\b/);
});

test("routed Admin pages no longer repeat the title as a second heading", () => {
  for (const page of [
    "AdminDashboard", "Inventory", "AddStock", "AddVaccine", "Deliveries", "Riders",
    "Alerts", "Analytics", "Settings", "Clinics", "Invoices", "InvoiceEditor",
  ]) {
    assert.doesNotMatch(code("src/pages/admin", `${page}.jsx`), /<h1\b/, page);
  }
  assert.doesNotMatch(code("src/components/admin/AdminLayout.jsx"), /<h1\b/);
});

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

test("every rail has the same brand, role chip, profile card and pinned logout", () => {
  for (const [role, fallback, logout] of [
    ["admin", "Administrator", "sidebar-logout"],
    ["salesrep", "Sales Representative", "salesrep-logout"],
    ["dispatcher", "Dispatcher", "dispatcher-logout"],
  ]) {
    const src = shellCode(role);
    assert.match(src, /className="[^"]*\bm-brand\b[^"]*">VaxTrack</, `${role}: brand`);
    assert.match(src, /className="m-role-chip"/, `${role}: chip`);
    assert.ok(src.includes(`<SidebarProfile fallbackRole="${fallback}" />`), `${role}: profile card`);
    assert.match(src, new RegExp(`className="${logout}"`), `${role}: logout`);
    assert.ok(chrome.includes(`aside .${logout}`) || chrome.includes(`.${logout}`), `${role}: logout styled`);
  }
});

test("the shared stylesheet states one rail and one bar, and loads last", () => {
  assert.match(chrome, /--shell-sidebar-width: 240px;/);
  assert.match(chrome, /--shell-topbar-height: 64px;/);
  assert.match(chrome, /--shell-title-size: clamp\(20px, 2\.4vw, 24px\);/);
  assert.match(chrome, /--shell-gutter: clamp\(16px, 2\.4vw, 26px\);/);
  // Admin's rail width variable points at the shared value.
  assert.match(chrome, /--admin-sidebar-width: var\(--shell-sidebar-width\);/);
  // 40px nav items for all three rails.
  for (const nav of ["aside.inventory-sidebar nav a", "aside.dispatcher-sidebar .dispatcher-nav a", "aside.salesrep-sidebar .salesrep-nav a"]) {
    assert.ok(chrome.includes(nav), nav);
  }
  assert.match(chrome, /height: 40px !important;\s*min-height: 40px !important;\s*max-height: 40px !important;/);

  const main = read("src", "main.jsx");
  const cssImports = main.match(/^import "[^"]+\.css";/gm);
  assert.equal(cssImports.at(-1), 'import "./styles/shell-chrome.css";');
});

test("the shell layer stays inside the role shells", () => {
  // Every rule must be anchored on #root (to outweigh the legacy !important
  // declarations) or be the :root token block — nothing global, nothing that
  // could reach Login.
  const selectors = chrome
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@[^{]+\{/g, "{") // drop @media preludes; their bodies are checked
    .match(/[^{};]+(?=\{)/g)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("@") && !s.startsWith("("));
  // Split a selector list on top-level commas only (`:has(> a, > b)` is one).
  const parts = (sel) => {
    const out = [];
    let depth = 0;
    let cur = "";
    for (const ch of sel) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === "," && depth === 0) {
        out.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  for (const sel of selectors) {
    for (const part of parts(sel)) {
      assert.ok(part === ":root" || part.startsWith("#root"), `unscoped selector: ${part}`);
    }
  }
  assert.doesNotMatch(chrome, /vlogin|\.login/);
});

test("the shell work added no lint suppressions", () => {
  for (const f of [
    "src/components/shell/SidebarProfile.jsx",
    "src/components/admin/AdminShell.jsx",
    "src/components/admin/AdminLayout.jsx",
  ]) {
    assert.doesNotMatch(read(f), /eslint-disable/, f);
  }
  // These two each carry one pre-existing, documented suppression (closing a
  // dropdown / drawer on route change); the shell work must not add another.
  for (const f of ["src/pages/salesRep/SalesRepShell.jsx", "src/pages/dispatcher/DispatcherLayout.jsx"]) {
    assert.equal(read(f).match(/eslint-disable/g).length, 1, f);
  }
});
