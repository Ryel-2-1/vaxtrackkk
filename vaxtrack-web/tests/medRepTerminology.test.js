import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import {
  LOGIN_PATH,
  ROLES,
  normalizeRole,
  resolveAccess,
  resolveLoginDestination,
} from "../src/services/authorization.js";
import { roleLabelOf } from "../src/services/profileModel.js";
import { APPLICABLE_ROLES } from "../src/services/registration.js";

// "Sales Rep" → "Med Rep" is a USER-FACING rename only.
//
// Shown to people: "Med Rep" for compact labels (chips, table cells, nav,
// filters), "Medical Representative" for formal text. Never "Sales Rep".
// Kept unchanged on purpose: the stored role value `salesrep`, the
// `/sales-rep/*` routes, SalesRep* file/component names, Firestore fields such
// as `salesRepName`/`salesRepCode`, and the legacy spellings the role
// normaliser still accepts from old documents.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (p) => readFileSync(join(root, p), "utf8");
// Code without comments, so prose about history can never pass or fail a test.
const code = (p) =>
  read(p)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/.*$/gm, "");

const SALES_WORDING = /sales[ ]rep|sales representative/i;

// ---------------------------------------------------------------------------
// Shells and profile
// ---------------------------------------------------------------------------

test("all three shells show their role names; the Med Rep shell says Med Rep", () => {
  const sales = code("src/pages/salesRep/SalesRepShell.jsx");
  assert.match(sales, /<span className="m-role-chip">\s*<span className="m-role-dot" \/>\s*Med Rep\s*<\/span>/);
  assert.ok(sales.includes('<SidebarProfile fallbackRole="Med Rep" />'));

  // Admin and Dispatcher keep their own names.
  const admin = code("src/components/admin/AdminSidebar.jsx");
  assert.match(admin, /<span className="m-role-dot" \/>\s*Admin Console/);
  assert.ok(admin.includes('<SidebarProfile fallbackRole="Administrator" />'));
  const dispatcher = code("src/pages/dispatcher/DispatcherLayout.jsx");
  assert.ok(dispatcher.includes('<SidebarProfile fallbackRole="Dispatcher" />'));
  assert.match(dispatcher, /<span className="m-role-dot" \/>\s*Dispatch\b/);
});

test("My Profile and every sidebar card label the stored salesrep role as Med Rep", () => {
  assert.equal(roleLabelOf("salesrep"), "Med Rep");
  // Legacy stored spellings resolve to the same label.
  assert.equal(roleLabelOf("sales-rep"), "Med Rep");
  assert.equal(roleLabelOf("Sales Representative"), "Med Rep");
  // Other roles are untouched.
  assert.equal(roleLabelOf("admin"), "Administrator");
  assert.equal(roleLabelOf("dispatcher"), "Dispatcher");
  assert.equal(roleLabelOf("rider"), "Rider");
});

test("Staff Directory shows Med Rep while still writing the stored role value", () => {
  const settings = code("src/pages/admin/Settings.jsx");
  assert.match(settings, /salesrep: "Med Rep",/);
  assert.match(settings, /\{ value: "salesrep", label: "Med Rep" \}/);
  assert.match(settings, /\{ value: "dispatcher", label: "Dispatcher" \}/);
  assert.match(settings, /\{ value: "rider", label: "Rider" \}/);
});

test("the public application form offers Medical Representative under the same stored value", () => {
  const rep = APPLICABLE_ROLES.find((r) => r.value === "salesrep");
  assert.deepEqual(rep, { value: "salesrep", label: "Medical Representative" });
  assert.deepEqual(APPLICABLE_ROLES.map((r) => r.value), ["salesrep", "dispatcher", "rider"]);
});

// ---------------------------------------------------------------------------
// Ordering, tracking, invoices, dashboards
// ---------------------------------------------------------------------------

test("order, tracking and invoice surfaces use Med Rep wording", () => {
  const invoices = code("src/pages/admin/Invoices.jsx");
  assert.match(invoices, /"Med Rep",/, "CSV export column");
  assert.match(invoices, /placeholder="Search order, customer, or Med Rep\.\.\."/);
  assert.match(invoices, /<th>Med Rep<\/th>/);

  const editor = code("src/pages/admin/InvoiceEditor.jsx");
  assert.match(editor, /<span className="sit-lbl">Med Rep Code<\/span>/, "printable invoice label");
  assert.match(editor, /aria-label="Med Rep code"/);
  // The stored field name is internal and unchanged.
  assert.match(editor, /form\.salesRepCode/);

  assert.match(code("src/pages/admin/Deliveries.jsx"), /Orders are created by Med Reps and dispatched by a Dispatcher\./);
  assert.match(code("src/pages/admin/Deliveries.jsx"), /created by Medical Representatives\./);
  assert.equal(code("src/pages/admin/AdminDashboard.jsx").split("Orders appear here as Med Reps place them.").length - 1, 2);
  assert.match(code("src/components/schedule/DeliveryCalendar.jsx"), /the date the Med Rep requested/);
});

test("no visible Sales Rep wording remains anywhere in the web source", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(jsx?|html)$/.test(name)) {
        const rel = relative(root, full).replace(/\\/g, "/");
        code(rel).split(/\r?\n/).forEach((line, i) => {
          if (SALES_WORDING.test(line) || />\s*Sales\s*</.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
      }
    }
  };
  walk(join(root, "src"));
  code("index.html").split(/\r?\n/).forEach((l, i) => SALES_WORDING.test(l) && offenders.push(`index.html:${i + 1}`));

  // The ONLY permitted match: the role normaliser's list of legacy stored
  // spellings. It reads old documents; it is never displayed.
  const allowed = offenders.filter((o) => !/^src\/services\/authorization\.js:\d+: "sales representative",$/.test(o));
  assert.deepEqual(allowed, []);
});

// ---------------------------------------------------------------------------
// Internal identifiers and behaviour stay exactly as they were
// ---------------------------------------------------------------------------

test("the stored role value, routes and guards are unchanged", () => {
  assert.equal(ROLES.SALES_REP, "salesrep");
  for (const spelling of ["salesrep", "sales_rep", "sales-rep", "Sales Representative"]) {
    assert.equal(normalizeRole(spelling), "salesrep", spelling);
  }
  // The display words are NOT accepted as stored roles — renaming the label
  // must not widen what the role check matches.
  assert.equal(normalizeRole("Med Rep"), null);
  assert.equal(normalizeRole("Medical Representative"), null);

  const app = code("src/App.jsx");
  for (const path of ["/sales-rep", "/sales-rep/inventory", "/sales-rep/request-order", "/sales-rep/place-order", "/sales-rep/order-confirmation", "/sales-rep/order-tracking", "/sales-rep/alerts", "/sales-rep/settings"]) {
    assert.ok(app.includes(`path="${path}"`), path);
  }
  assert.match(code("src/components/SalesRepRoute.jsx"), /requiredRole: ROLES\.SALES_REP/);
  assert.match(read("firestore.rules"), /'salesrep'/);
});

test("role access decisions are unchanged for every role", () => {
  const approved = (role) => ({ role, status: "approved" });
  // Login still lands each role in its own app.
  assert.equal(resolveLoginDestination(approved("salesrep")).redirectTo, "/sales-rep");
  assert.equal(resolveLoginDestination(approved("dispatcher")).redirectTo, "/dispatcher");
  assert.equal(resolveLoginDestination(approved("admin")).redirectTo, "/admin");
  assert.equal(resolveLoginDestination(approved("rider")).allowed, false);

  const rep = resolveAccess({ profile: approved("salesrep"), requiredRole: ROLES.SALES_REP });
  assert.equal(rep.allowed, true);
  const repAtAdmin = resolveAccess({ profile: approved("salesrep"), requiredRole: ROLES.ADMIN });
  assert.equal(repAtAdmin.allowed, false);
  assert.equal(repAtAdmin.redirectTo, "/sales-rep");
  const dispatcherAtRep = resolveAccess({ profile: approved("dispatcher"), requiredRole: ROLES.SALES_REP });
  assert.equal(dispatcherAtRep.allowed, false);
  assert.equal(dispatcherAtRep.redirectTo, "/dispatcher");
  const unknown = resolveAccess({ profile: { role: "Med Rep", status: "approved" }, requiredRole: ROLES.SALES_REP });
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.redirectTo, LOGIN_PATH);
});
