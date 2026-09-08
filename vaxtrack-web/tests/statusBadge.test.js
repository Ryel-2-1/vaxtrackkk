import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServiceLoader } from "./serviceHarness.js";
import { ORDER_STATUSES, STATUS_LABELS } from "../src/services/orderWorkflow.js";

/**
 * The shared StatusBadge shows "Unknown" for a status the system cannot resolve.
 *
 * It used to fall back to `{ tone: "pending", label: "Pending" }`, so a document
 * with no status field, a typo, or any value this system does not define
 * rendered as a normal early-lifecycle order — in a badge visually identical to
 * a genuinely pending one. Every call site inherited that.
 *
 * Two callers additionally replaced an unresolvable status with a real state
 * BEFORE the badge could see it: Dispatcher Assign Rider substituted
 * `pending_dispatch`, and Sales Rep Order Tracking's label mapper defaulted to
 * "Processing" and passed it in as a label override.
 *
 * These tests execute the component's REAL resolution logic, lifted from its
 * source, rather than re-describing it. Rendering is verified separately in a
 * browser harness — this repository has no React test renderer.
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const SRC = read("src/components/ui/StatusBadge.jsx");
const CSS = read("src/components/ui/ui.css");

const loader = createServiceLoader();
const { normalizeStatusKey, UNKNOWN_STATUS_KEY, UNKNOWN_STATUS_LABEL } =
  await loader.load("deliveryService.js");

/**
 * Rebuilds the badge's decision from the shipped source: its STATUS_META table,
 * its UNKNOWN_META fallback, and the three statements that resolve a prop set
 * into a tone and the text that is rendered. Nothing here is transcribed.
 */
function buildResolver() {
  const metaSrc = /const STATUS_META = \{[\s\S]*?\n\};/.exec(SRC);
  const unknownSrc = /const UNKNOWN_META = \{[^}]*\};/.exec(SRC);
  const keyLine = /const key = [^\n]+/.exec(SRC);
  const metaLine = /const meta = [^\n]+/.exec(SRC);
  const textLine = /const text = [^\n]+/.exec(SRC);
  assert.ok(metaSrc && unknownSrc && keyLine && metaLine && textLine,
    "the component's resolution logic must be locatable in source");

  const body = `
    ${metaSrc[0]}
    ${unknownSrc[0]}
    return function ({ statusKey, status, label }) {
      ${keyLine[0]}
      ${metaLine[0]}
      ${textLine[0]}
      return { tone: meta.tone, text, className: \`m-badge m-badge-\${meta.tone}\` };
    };`;
  return new Function(
    "normalizeStatusKey", "UNKNOWN_STATUS_KEY", "UNKNOWN_STATUS_LABEL", body
  )(normalizeStatusKey, UNKNOWN_STATUS_KEY, UNKNOWN_STATUS_LABEL);
}

const badge = buildResolver();

/** The tones the stylesheet actually defines, so no badge can be unstyled. */
const definedTones = new Set(
  [...CSS.matchAll(/^\.m-badge-([a-z]+) \{/gm)].map((m) => m[1])
);

// ------------------------------------------------- every canonical status

test("every canonical delivery status keeps its own label and tone", () => {
  for (const key of ORDER_STATUSES) {
    const r = badge({ statusKey: key });
    assert.equal(r.text, STATUS_LABELS[key], `${key} must show its own label`);
    assert.notEqual(r.tone, "unknown", `${key} is a real status, not unknown`);
    assert.ok(definedTones.has(r.tone), `${key} tone "${r.tone}" must be styled`);
  }
  // The one most easily lost: it shares the danger tone with `delayed` but is
  // a different state and must keep its own words.
  const failed = badge({ statusKey: "delivery_failed" });
  assert.equal(failed.text, "Delivery Failed");
  assert.equal(failed.tone, badge({ statusKey: "delayed" }).tone);
  assert.notEqual(failed.text, badge({ statusKey: "delayed" }).text);
});

test("supported non-canonical labels and legacy aliases are preserved", () => {
  // `pending` is not in ORDER_STATUSES but the badge has always labelled it.
  assert.equal(badge({ statusKey: "pending" }).text, "Pending");
  assert.equal(badge({ statusKey: "pending" }).tone, "pending");
  // Legacy read-only aliases seen on historical documents.
  assert.equal(badge({ statusKey: "completed" }).text, "Delivered");
  assert.equal(badge({ statusKey: "completed" }).tone,
    badge({ statusKey: "delivered" }).tone);
  assert.equal(badge({ statusKey: "canceled" }).text, "Cancelled");
  assert.equal(badge({ statusKey: "canceled" }).tone,
    badge({ statusKey: "cancelled" }).tone);
});

// --------------------------------------------------------------- unknown

test("an explicitly unknown status renders Unknown", () => {
  const r = badge({ statusKey: UNKNOWN_STATUS_KEY });
  assert.equal(r.text, UNKNOWN_STATUS_LABEL);
  assert.equal(r.tone, "unknown");
});

test("absent, malformed and unrecognised values all render Unknown", () => {
  const cases = [
    ["missing statusKey", {}],
    ["null", { statusKey: null }],
    ["undefined", { statusKey: undefined }],
    ["empty string", { statusKey: "" }],
    ["whitespace only", { statusKey: "   " }],
    ["tab and newline", { statusKey: "\t\n" }],
    ["unrecognised word", { statusKey: "picked_up" }],
    ["typo", { statusKey: "delivred" }],
    ["not a status", { statusKey: "not-a-status" }],
    ["number", { statusKey: 12345 }],
    ["boolean", { statusKey: true }],
    ["object", { statusKey: {} }],
    ["array", { statusKey: [] }],
    ["raw status prop, unrecognised", { status: "zzz" }],
    ["raw status prop, absent", { status: null }],
  ];
  for (const [name, props] of cases) {
    const r = badge(props);
    assert.equal(r.text, UNKNOWN_STATUS_LABEL, `${name} must read Unknown`);
    assert.equal(r.tone, "unknown", `${name} must use the neutral tone`);
  }
});

test("no unresolvable status is ever shown as a real state", () => {
  const realWords = ["Pending", "Pending Dispatch", "Assigned", "Loading",
    "In Transit", "Delayed", "Delivery Failed", "Delivered", "Cancelled",
    "Approved", "Processing"];
  for (const bad of [undefined, null, "", "   ", "picked_up", "approved", 7, {}]) {
    const r = badge({ statusKey: bad });
    assert.equal(realWords.includes(r.text), false,
      `${JSON.stringify(bad)} must not read as "${r.text}"`);
  }
  // And the neutral tone is not shared with any real status.
  const realTones = new Set(ORDER_STATUSES.map((k) => badge({ statusKey: k }).tone));
  assert.equal(realTones.has("unknown"), false);
});

test("a label override cannot resurrect a real state for an unknown status", () => {
  for (const override of ["Pending", "Processing", "Delivered", "Approved"]) {
    const r = badge({ statusKey: "picked_up", label: override });
    assert.equal(r.text, UNKNOWN_STATUS_LABEL,
      `override "${override}" must not survive on an unresolvable status`);
    assert.equal(r.tone, "unknown");
  }
  // The override still works for a status the badge CAN resolve — the existing
  // API is unchanged for every supported case.
  assert.equal(badge({ statusKey: "in_transit", label: "Out for Delivery" }).text,
    "Out for Delivery");
  assert.equal(badge({ statusKey: "in_transit", label: "Out for Delivery" }).tone,
    badge({ statusKey: "in_transit" }).tone);
});

// ------------------------------------------------- normalization and style

test("normalization is applied before resolution", () => {
  for (const variant of ["IN_TRANSIT", " in transit ", "in-transit", "In-Transit"]) {
    assert.equal(badge({ statusKey: variant }).text, "In Transit",
      `${JSON.stringify(variant)} must normalize to in_transit`);
  }
});

test("the neutral tone is styled, and distinct from the real ones", () => {
  assert.ok(definedTones.has("unknown"), ".m-badge-unknown must exist");
  // Distinguishable from the two other grey badges rather than just grey too.
  const rule = /\.m-badge-unknown \{[\s\S]*?\}/.exec(CSS);
  assert.ok(rule, "the unknown tone needs its own rule");
  assert.match(rule[0], /border-style:\s*dashed/);
  assert.match(CSS, /\.m-badge-unknown \.m-badge-dot/);
});

test("the visible text is the accessible name", () => {
  // The badge renders one text node inside a span and sets no aria-label or
  // title, so what is read is exactly what is shown. A hidden override here is
  // how a badge starts announcing something other than its own words.
  assert.equal(/aria-label=/.test(SRC), false, "no aria-label may shadow the text");
  assert.equal(/title=/.test(SRC), false, "no title may shadow the text");
  assert.match(SRC, /\{text\}/, "the resolved text is what is rendered");
  assert.match(SRC, /className=\{`m-badge m-badge-\$\{meta\.tone\}`\}/);
});

// ----------------------------------------------------- caller behaviour

test("no caller substitutes a real status before the badge sees it", () => {
  const pages = [
    "src/pages/admin/AdminDashboard.jsx",
    "src/pages/admin/Deliveries.jsx",
    "src/pages/dispatcher/DispatcherAssignRider.jsx",
    "src/pages/dispatcher/DispatcherCargoLoading.jsx",
    "src/pages/dispatcher/DispatcherGeofence.jsx",
    "src/pages/dispatcher/DispatcherShipments.jsx",
    "src/pages/salesRep/SalesRepDashboard.jsx",
    "src/pages/salesRep/SalesRepOrderTracking.jsx",
  ];
  for (const p of pages) {
    const code = read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    for (const m of code.matchAll(/<StatusBadge[^>]*>/g)) {
      assert.equal(
        /statusKey=\{[^}]*\|\|[^}]*"/.test(m[0]),
        false,
        `${p}: ${m[0].trim()} defaults an unresolvable status to a literal state`
      );
    }
  }
});

test("the Sales Rep tracking label falls back to Unknown, not a real state", () => {
  const tracking = read("src/pages/salesRep/SalesRepOrderTracking.jsx");
  const fn = /function mapTrackingLabel\(statusKey\) \{[\s\S]*?\n\}/.exec(tracking);
  assert.ok(fn, "the label mapper must exist");
  const dflt = /default:\s*\n\s*return "([^"]+)";/.exec(fn[0]);
  assert.ok(dflt, "it must have a default branch");
  assert.equal(dflt[1], "Unknown",
    `unresolvable statuses must not read as "${dflt[1]}"`);
  // Its explicit aliases are untouched.
  assert.match(fn[0], /case "delivery_failed":\s*\n\s*return "Delivery Failed";/);
  assert.match(fn[0], /case "out_for_delivery":/);
});

// ------------------------------------------------------- domain boundary

test("the shared badge serves order statuses only", () => {
  // Invoices has its OWN local badge for the invoice-status domain and does not
  // import this one. Account status is rendered by its own page chips. Changing
  // the order-status fallback therefore cannot reach another domain.
  const invoices = read("src/pages/admin/Invoices.jsx");
  assert.equal(
    /import StatusBadge from ".*components\/ui\/StatusBadge"/.test(invoices),
    false,
    "Invoices must keep its own badge"
  );
  assert.match(invoices, /function StatusBadge\(\{ status \}\)/);
  assert.match(invoices, /inv-status-badge/);
  // The shared table contains no account or invoice status.
  for (const foreign of ["approved", "disabled", "rejected", "issued", "draft"]) {
    assert.equal(
      new RegExp(`^\\s*${foreign}:`, "m").test(SRC),
      false,
      `${foreign} belongs to another domain and must not be in the shared table`
    );
  }
});
