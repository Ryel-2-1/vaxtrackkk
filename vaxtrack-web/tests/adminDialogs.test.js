// Admin dialogs and the transformed-ancestor bug.
//
// Every Admin page's <main> keeps `transform: translateY(0)` after its
// entrance animation (shell-transitions.css: `.inventory-page > main {
// animation: routeViewIn … both }`). A transformed ancestor is the containing
// block for `position: fixed`, so a dialog rendered INSIDE <main> was centred
// in the whole long page, opened off-screen once the page was scrolled, and
// sat under the sidebar/top bar. Audit (2026-10-18), measured live:
//
//   Affected (inside a transformed <main>) — now portaled:
//     Inventory › Edit price            (−847 px, overlay 2584 px tall)
//     Analytics › metric detail modal   (−1323 px)
//     Allocation › disposition confirm  (−448 px)
//     Settings › Staff details, Status confirm, Reject confirm, Role change,
//                Manage territory       (−587 / −191 / same / −280 / −374 px)
//     Delivery calendar › Change delivery schedule (bottom below the screen)
//   Safe (rendered after </main>, not under a transform) — left as they are:
//     Alerts (review, alert delivery, resolve confirm), Clinics (all five
//     modals + the doctor-address confirm inside one), Deliveries drawer,
//     Riders (details + confirm), Invoice editor (issue / leave confirms),
//     Inventory batch details + Correct stock (portaled in c9c744c).
//
// Two layers (no DOM renderer in this suite): behaviour of the pure pieces
// (route scope, shared page lock) and source contracts for the wiring. The
// layout itself was verified in a real browser at 1366×768, 1280×600 and
// 390×844.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { adminWrapperClassFor } from "../src/components/admin/adminShellClasses.js";
import { enterDialog, leaveDialog } from "../src/components/ui/useDialogFocus.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");
const rule = (css, selector) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n)\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css);
  return m ? m[1] : null;
};
/** The source of one top-level function, from its declaration to the next one. */
const fnSource = (src, name) => {
  const start = src.search(new RegExp(`(^|\\n)(export (default )?)?function ${name}\\(`));
  assert.ok(start >= 0, `function ${name}`);
  const next = src.slice(start + 1).search(/\n(export (default )?)?function \w+\(/);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
};

// ------------------------------------------------------------ behaviour

test("the portal layer carries the same wrapper classes the Admin shell uses for the route", () => {
  assert.equal(adminWrapperClassFor("/admin/inventory"), "inventory-page adl-root");
  assert.equal(adminWrapperClassFor("/admin/analytics"), "inventory-page adl-root");
  assert.equal(adminWrapperClassFor("/admin/allocation"), "inventory-page adl-root");
  assert.equal(adminWrapperClassFor("/admin/delivery-calendar"), "inventory-page adl-root");
  assert.equal(adminWrapperClassFor("/admin/clinics"), "inventory-page clinics-shell");
  assert.equal(adminWrapperClassFor("/admin/settings"), "inventory-page");
  assert.equal(adminWrapperClassFor("/admin/invoices/abc"), "inventory-page");
  // One source of truth: the shell renders its wrapper from the same function.
  const shell = read("src/components/admin/AdminShell.jsx");
  assert.match(shell, /import \{ adminWrapperClassFor \} from "\.\/adminShellClasses";/);
  assert.match(shell, /<div className=\{adminWrapperClassFor\(location\.pathname\)\}>/);
  assert.doesNotMatch(shell, /const WRAPPER_CLASS =/, "no second copy of the map");
});

afterEach(() => {
  delete globalThis.window;
  delete globalThis.document;
});

test("the page lock keeps the scrollbar's space, so the page does not reflow (or move) behind a dialog", () => {
  const calls = [];
  globalThis.window = { scrollX: 0, scrollY: 1737, scrollTo: (o) => calls.push(o) };
  globalThis.document = {
    body: { style: { overflow: "" } },
    documentElement: { style: { overflow: "", scrollbarGutter: "auto" } },
  };
  const t = {};
  enterDialog(t);
  assert.equal(document.documentElement.style.scrollbarGutter, "stable");
  assert.equal(document.documentElement.style.overflow, "hidden");
  leaveDialog(t);
  assert.equal(document.documentElement.style.scrollbarGutter, "auto", "the previous inline value comes back");
  assert.deepEqual(calls, [{ left: 0, top: 1737, behavior: "instant" }]);
});

// ------------------------------------------------------------ the shared Admin portal

test("AdminDialogLayer portals to <body> with the route's shell classes (+ an optional page class)", () => {
  const layer = read("src/components/admin/AdminDialogLayer.jsx");
  assert.match(layer, /import DialogLayer from "\.\.\/ui\/DialogLayer";/);
  assert.match(layer, /const \{ pathname \} = useLocation\(\);/);
  assert.match(layer, /<DialogLayer scope=\{`\$\{adminWrapperClassFor\(pathname\)\} \$\{pageClass\}`\.trim\(\)\}>/);
  // DialogLayer: a box-less layer straight under <body>.
  assert.match(read("src/components/ui/DialogLayer.jsx"), /createPortal\([\s\S]*document\.body\s*\)/);
  assert.match(read("src/components/ui/DialogLayer.css"), /body > \.vt-dialog-layer \{\s*display: contents !important;/);
  // The entrance animation that causes the bug targets <main> only, never the layer.
  const transitions = read("src/styles/shell-transitions.css");
  assert.match(transitions, /\.inventory-page > main \{\s*animation: routeViewIn 0\.26s ease both;/);
});

// ------------------------------------------------------------ affected dialogs, each portaled

test("Inventory › Edit price uses the portaled Inventory dialog (Escape blocked while saving, backdrop click kept)", () => {
  const page = read("src/pages/admin/Inventory.jsx");
  assert.match(page, /\{pricing && \(\s*<InventoryDialog\s*labelledBy="inv-price-title"\s*onClose=\{closePriceDialog\}\s*busy=\{savingPrice\}\s*className="inv-price-modal"\s*>/);
  assert.doesNotMatch(page, /className="v2-inventory-modal-backdrop"/, "no in-<main> overlay left on the page");
  const frame = read("src/pages/admin/InventoryBatchDialog.jsx");
  const dialog = fnSource(frame, "InventoryDialog");
  assert.match(dialog, /useDialogFocus\(\{ dialogRef, onDismiss: onClose, busy \}\);/);
  assert.match(dialog, /<DialogLayer scope=\{INVENTORY_DIALOG_SCOPE\}>/);
  assert.match(dialog, /<div className="v2-inventory-modal-backdrop" onClick=\{onClose\}>/);
});

test("Analytics › metric detail modal is portaled, a real dialog, and fits the screen", () => {
  const src = read("src/pages/admin/Analytics.jsx");
  const modal = fnSource(src, "AnalyticsModal");
  assert.match(modal, /useDialogFocus\(\{ dialogRef, onDismiss: onClose \}\);/);
  assert.match(modal, /return \(\s*<AdminDialogLayer>\s*<div className="analytics-modal-backdrop">/);
  assert.match(modal, /role="dialog"\s*aria-modal="true"\s*aria-labelledby="analytics-modal-title"/);
  assert.match(modal, /<h2 id="analytics-modal-title">\{modal\.title\}<\/h2>/);
  const box = rule(read("src/pages/admin/Analytics.css"), ".analytics-modal");
  assert.match(box, /max-height: calc\(100vh - 32px\);\s*max-height: calc\(100dvh - 32px\);\s*overflow-y: auto;/);
});

test("Allocation › disposition confirmation is portaled", () => {
  const src = read("src/pages/admin/AdminAllocation.jsx");
  assert.match(src, /\{pending && pendingChoice && \(\s*<AdminDialogLayer>\s*<ConfirmDialog/);
  assert.match(src, /onCancel=\{\(\) => setPending\(null\)\}\s*\/>\s*<\/AdminDialogLayer>/);
});

test("Settings › every User Management dialog is portaled with the page class it inherits from", () => {
  const src = read("src/pages/admin/Settings.jsx");
  for (const [cond, comp] of [
    ["rejectTarget", "ConfirmDialog"],
    ["statusChange", "ConfirmDialog"],
    ["selectedStaff", "StaffDetailsModal"],
    ["territoryTarget", "MedRepTerritoryDialog"],
    ["roleChangeTarget", "RoleChangeModal"],
  ]) {
    assert.match(
      src,
      new RegExp(`\\{${cond} && \\(\\s*<AdminDialogLayer pageClass="settings-v3-main">\\s*<${comp}\\b`),
      `${cond} → ${comp}`
    );
  }
  assert.equal((src.match(/<\/AdminDialogLayer>/g) || []).length, 5);
  // Staff details gains the shared hook (page lock, Escape — never mid-write — focus) and dialog semantics.
  const staff = fnSource(src, "StaffDetailsModal");
  assert.match(staff, /useDialogFocus\(\{ dialogRef, onDismiss: onClose, busy \}\);/);
  assert.match(staff, /role="dialog"\s*aria-modal="true"\s*aria-labelledby="staff-details-title"/);
  assert.match(staff, /<h2 id="staff-details-title">\{person\.name\}<\/h2>/);
  // Role change already had it.
  assert.match(fnSource(src, "RoleChangeModal"), /useDialogFocus\(\{ dialogRef, onDismiss: onClose, busy: saving \}\);/);
  // Never taller or wider than the screen.
  const css = read("src/pages/admin/Settings.css");
  assert.match(rule(css, ".settings-modal"), /max-height: calc\(100vh - 48px\);\s*max-height: calc\(100dvh - 48px\);\s*overflow-y: auto;/);
  assert.match(rule(css, ".settings-modal-backdrop"), /grid-template-columns: minmax\(0, 1fr\);/);
});

test("Settings › Manage territory: Escape does what Cancel does, never while saving", () => {
  const src = read("src/pages/admin/MedRepTerritoryDialog.jsx");
  assert.match(src, /useDialogFocus\(\{\s*dialogRef,\s*onDismiss: confirmingOrders \? \(\) => setConfirmingOrders\(null\) : onClose,\s*busy: saving,\s*\}\);/);
  assert.match(src, /onClick=\{confirmingOrders \? \(\) => setConfirmingOrders\(null\) : onClose\}/, "the Cancel it mirrors");
  assert.match(src, /<div\s*ref=\{dialogRef\}\s*className="settings-modal territory-modal"/);
});

test("Delivery calendar › Change delivery schedule is portaled (Admin-only) and uses the shared dialog hook", () => {
  const src = read("src/components/schedule/DeliveryCalendar.jsx");
  assert.match(src, /\{isAdmin && editing \? \(\s*<AdminDialogLayer>\s*<RescheduleDialog/);
  const dialog = fnSource(src, "RescheduleDialog");
  assert.match(dialog, /useDialogFocus\(\{ dialogRef, initialRef: firstFieldRef, onDismiss: onClose, busy: saving \}\);/);
  // The hand-rolled document-level key handler is gone (one Escape owner, stack-aware).
  assert.doesNotMatch(dialog, /document\.addEventListener\("keydown"/);
  assert.match(rule(read("src/components/schedule/DeliveryCalendar.css"), ".dcal-dialog"), /max-height: calc\(100dvh - 32px\);/);
  // The Dispatcher never renders this dialog (rescheduling is Admin-only), so it is untouched there.
  assert.match(src, /const isAdmin = role === "admin";/);
});

// ------------------------------------------------------------ the guard: no new dialog inside a transformed <main>

test("pages whose dialogs render inside <main> keep every dialog portaled", () => {
  // These files render their dialogs inside the page's <main> (AdminLayout's
  // <main class="adx-main"> or Settings' own <main>), so every overlay or
  // ConfirmDialog in them must go through a portal.
  const files = [
    "src/pages/admin/AdminAllocation.jsx",
    "src/pages/admin/AdminDashboard.jsx",
    "src/pages/admin/AdminDeliveryCalendar.jsx",
    "src/pages/admin/AdminLiveTracking.jsx",
    "src/pages/admin/AdminOrderHistory.jsx",
    "src/pages/admin/AiInventoryAnalytics.jsx",
    "src/pages/admin/Analytics.jsx",
    "src/pages/admin/Inventory.jsx",
    "src/pages/admin/Settings.jsx",
    "src/components/schedule/DeliveryCalendar.jsx",
  ];
  for (const f of files) {
    const src = read(f);
    // Every ConfirmDialog sits directly inside a portal.
    for (const m of src.matchAll(/<ConfirmDialog\b/g)) {
      const before = src.slice(0, m.index).trimEnd();
      assert.ok(/<AdminDialogLayer( pageClass="[^"]*")?>$/.test(before), `${f}: a ConfirmDialog outside AdminDialogLayer`);
    }
    // Every overlay element is portaled: either its component returns it
    // inside a portal, or every place that component is rendered wraps it in one.
    for (const m of src.matchAll(/className="[^"]*(-backdrop|-overlay)\b[^"]*"/g)) {
      const ret = src.lastIndexOf("return (", m.index);
      const head = src.slice(ret + "return (".length, m.index).trim();
      if (/^<(AdminDialogLayer|DialogLayer)\b[^>]*>\s*<div$/.test(head)) continue;
      const owner = [...src.slice(0, m.index).matchAll(/function (\w+)\(/g)].pop()?.[1];
      const uses = [...src.matchAll(new RegExp(`<${owner}\\b`, "g"))];
      assert.ok(owner && uses.length > 0, `${f}: overlay "${m[0]}" is not rendered through a portal`);
      for (const u of uses) {
        assert.ok(
          /<AdminDialogLayer( pageClass="[^"]*")?>$/.test(src.slice(0, u.index).trimEnd()),
          `${f}: <${owner}> (overlay "${m[0]}") is rendered outside AdminDialogLayer`
        );
      }
    }
  }
});

test("pages whose dialogs render after </main> keep them there (the safe placement)", () => {
  const safe = {
    "src/pages/admin/Alerts.jsx": ["<AlertReviewModal", "<ConfirmDialog", "<AlertChannelsModal"],
    "src/pages/admin/Clinics.jsx": ["<ClinicDetailsModal", "<NewClinicModal", "<AreasModal", "<DoctorsModal", "<ManageLocationModal"],
    "src/pages/admin/Deliveries.jsx": ["<DeliveryModal"],
    "src/pages/admin/Riders.jsx": ["<RiderDetailsModal", "<ConfirmDialog"],
    "src/pages/admin/InvoiceEditor.jsx": ["<AppConfirmDialog"],
  };
  for (const [f, tags] of Object.entries(safe)) {
    const src = read(f);
    const close = src.lastIndexOf("</main>");
    assert.ok(close > 0, `${f}: </main>`);
    // The page returns a fragment, so the dialogs are siblings of <main>, not children.
    assert.match(src.slice(src.lastIndexOf("return (", close), close), /return \(\s*<>\s*<main/, `${f}: fragment around <main>`);
    for (const tag of tags) {
      const at = src.indexOf(tag, close);
      assert.ok(at > close, `${f}: ${tag} is rendered after </main>`);
      assert.equal(src.lastIndexOf(tag, close), -1, `${f}: no ${tag} inside <main>`);
    }
  }
});
