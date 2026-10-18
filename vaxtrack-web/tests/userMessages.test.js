// User-facing messages: what reaches the screen when something fails, how it
// is presented, and the controls around it.
//
// Two layers, as elsewhere in this repo (no DOM renderer is installed):
//   1. Behaviour of the pure modules — the error mapper and its trust rule,
//      the technical-content filter, load states, the single-flight guard,
//      field-validation helpers, dialog keyboard logic and toast tones.
//   2. Source contracts for page wiring that cannot run without a DOM: no
//      native dialogs, no raw `.message` rendering, confirmations that name a
//      target and a consequence, dialogs that stay open on failure, disabled
//      placeholder controls, accessible field errors.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GENERIC_FAILURE_MESSAGE,
  errorKind,
  friendlyErrorMessage,
  isOutcomeUnknown,
  isSafeUserMessage,
  isTrustedAppError,
  kpiValue,
  liveErrorKind,
  liveErrorMessage,
  loadStateOf,
  logSafeError,
  messageForKind,
  safeErrorContext,
} from "../src/services/liveDataErrors.js";
import { UserMessageError, isUserMessageError } from "../src/services/userMessageError.js";
import { createSingleFlight } from "../src/services/singleFlight.js";
import { errorIdFor, fieldA11y, firstInvalidField, focusFirstInvalid, hasErrors } from "../src/services/formValidation.js";
import { dialogKeyAction, nextFocusIndex } from "../src/components/ui/dialogFocus.js";
import { TOAST_DURATION_MS, liveRoleFor, normalizeTone } from "../src/components/ui/feedbackModel.js";
import { RouteServiceError } from "../src/services/routeService.js";
import { OrderDraftError } from "../src/services/orderDraftRequest.js";
import { WorkflowError } from "../src/services/orderWorkflow.js";
import { EmptyInventoryExportError } from "../src/services/inventoryExport.js";
import { validateStockCorrection } from "../src/services/stockCorrection.js";
import { registrationErrorField, validateApplication } from "../src/services/registration.js";
import { analyticsConfigPayload } from "../src/services/inventoryAnalytics.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
// Comments stripped, so a sentence in a comment never satisfies (or trips) a check.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const SRC = walk(join(root, "src")).filter((p) => /\.(jsx?|mjs)$/.test(p));
const UI = SRC.filter((p) => /[\\/](pages|components)[\\/]/.test(p));
const rel = (p) => relative(root, p).replace(/\\/g, "/");
// A developer-only diagnostic, mounted only behind VITE_GOOGLE_MAPS_FEASIBILITY.
const DEV_ONLY = new Set(["src/pages/dev/GoogleMapsFeasibility.jsx"]);

const fbError = (code, message = `raw firebase text for ${code}`) => {
  const e = new Error(message);
  e.name = "FirebaseError";
  e.code = code;
  return e;
};
const TECHNICAL = /firebase|firestore|googleapis|projects\/|databases\/|documents\/|https?:\/\/|\bat\s+\S+\s*\(|\.jsx?:\d+|Missing or insufficient|INTERNAL|PERMISSION_DENIED|[a-z]+[A-Z][a-zA-Z]*With[A-Z]|\(\s*[45]\d\d\s*\)/i;

// ======================================================================
// 1. The mapper
// ======================================================================

test("no raw Firebase message reaches the UI — load or write, any code", () => {
  const codes = [
    "permission-denied", "unauthenticated", "unavailable", "deadline-exceeded", "not-found",
    "already-exists", "aborted", "resource-exhausted", "failed-precondition", "internal",
    "unknown", "invalid-argument", "data-loss", "functions/internal", "functions/permission-denied",
    "auth/network-request-failed", "storage/unauthorized", "storage/retry-limit-exceeded",
  ];
  for (const code of codes) {
    const err = fbError(code, `FirebaseError: [code=${code}] Missing or insufficient permissions. projects/vaxtrack-bef1b/databases/(default)/documents/orders/abc`);
    for (const msg of [friendlyErrorMessage(err, "The order could not be saved."), liveErrorMessage(err, "orders")]) {
      assert.doesNotMatch(msg, TECHNICAL, `${code}: ${msg}`);
      assert.doesNotMatch(msg, /vaxtrack-bef1b|orders\/abc|\[code=/, code);
    }
  }
});

test("only an explicit UserMessageError is trusted — innocent-looking untrusted text is suppressed", () => {
  const fallback = "Fallback sentence.";
  const untrusted = [
    new Error("Order saved successfully."), // plain Error: never trusted, however harmless
    new Error("Batch ID already exists."),
    new TypeError("Your order was placed."),
    new RangeError("Stock updated."),
    Object.assign(new Error("Everything is fine."), { name: "AssignmentError" }), // spoofed class name
    { name: "AxiosError", message: "Request completed." },
    { message: "Saved." },
    "Saved.",
    fbError("internal", "Your invoice was issued."),
  ];
  for (const err of untrusted) {
    assert.equal(isTrustedAppError(err), false, String(err?.message ?? err));
    assert.equal(friendlyErrorMessage(err, fallback), fallback, String(err?.message ?? err));
  }
  // Trusted: the app's own type and its subclasses.
  class AssignmentError extends UserMessageError {}
  for (const err of [new UserMessageError("That rider is gone."), new AssignmentError("That rider is gone.")]) {
    assert.equal(isUserMessageError(err), true);
    assert.equal(friendlyErrorMessage(err, fallback), "That rider is gone.");
  }
  // Every domain error class in the app is a UserMessageError.
  for (const err of [
    new RouteServiceError("route-unreachable", "x"),
    new OrderDraftError("c", "x"),
    new WorkflowError("c", "x"),
    new EmptyInventoryExportError(),
  ]) {
    assert.equal(err instanceof UserMessageError, true, err.name);
  }
  for (const [file, cls] of [
    ["inventoryCallables.js", "InventoryCallableError"],
    ["orderService.js", "AssignmentError"],
    ["userService.js", "UserStatusError"],
    ["userService.js", "TerritoryAssignmentError"],
  ]) {
    assert.match(read("src", "services", file), new RegExp(`export class ${cls} extends UserMessageError`), cls);
  }
});

test("the technical-content filter is defence in depth: a trusted error carrying technical text is suppressed", () => {
  const fallback = "Fallback sentence.";
  for (const text of [
    "Missing or insufficient permissions.",
    "TypeError: Cannot read properties of undefined (reading 'id')",
    "Error at createOrderWithReservation (index.js:212)",
    "projects/vaxtrack-bef1b/databases/(default)/documents/orders/abc",
    "Routing service error (404).",
    "MISSING_KEY",
    "See https://console.firebase.google.com/…",
    "Status pending_dispatch is invalid.",
  ]) {
    assert.equal(isSafeUserMessage(text), false, text);
    assert.equal(friendlyErrorMessage(new UserMessageError(text), fallback), fallback, text);
  }
  for (const text of [
    "That rider is no longer available. Choose another rider.",
    "Only 4 left in batch HEP-001. Adjust the quantity and try again.",
    "The standard price of batch HEP-001 changed from ₱1,250.00 to ₱1,300.00 while you were ordering.",
  ]) {
    assert.equal(isSafeUserMessage(text), true, text);
  }
});

test("every message the server or the app writes for an operator passes the filter", () => {
  const dirs = [join(root, "functions", "src"), join(root, "src", "services")];
  const re = /new (?:PolicyError|UserMessageError|AssignmentError|WorkflowError|UserStatusError|InventoryCallableError)\(\s*(?:"[a-z-]+",\s*)?"((?:[^"\\]|\\.)*)"/g;
  let checked = 0;
  for (const dir of dirs) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const m of src.matchAll(re)) {
        checked += 1;
        assert.equal(isSafeUserMessage(m[1].replace(/\\"/g, '"')), true, `${f}: ${m[1]}`);
      }
    }
  }
  assert.ok(checked > 150, `expected the server and service messages to be scanned (${checked})`);
});

test("stable server codes map to their message — decided by code, never by prose", () => {
  // An untrusted error with only a code still gets the right mapped sentence.
  const cases = {
    "permission-denied": "permission",
    "unauthenticated": "signed-out",
    "unavailable": "offline",
    "network-request-failed": "offline",
    "service-unavailable": "offline",
    "deadline-exceeded": "timeout",
    "not-found": "not-found",
    "order-not-found": "not-found",
    "workflow-updated": "changed",
    "destination-changed": "changed",
    "invoice-base-mismatch": "changed",
    "already-exists": "conflict",
    "batch-id-exists": "conflict",
    "idempotency-conflict": "conflict",
    "order-already-assigned": "already-assigned",
    "invalid-status-transition": "transition",
    "reservation-already-settled": "transition",
    "insufficient-stock": "stock",
    "batch-expired": "stock",
    "order-not-fully-reserved": "stock",
    "price-changed": "price",
    "price-not-confirmed": "price",
    "invalid-agreed-price": "pricing",
    "negotiation-reason-required": "pricing",
    "statutory-discount-exceeds-line": "pricing",
    "discount-recorded-per-line": "pricing",
    "vat-classification-required": "pricing",
    "eligibility-not-confirmed": "attestation",
    "delivery-outside-geofence": "geofence-outside",
    "rider-location-stale": "geofence-stale",
    "rider-location-inaccurate": "geofence-inaccurate",
    "rider-location-unavailable": "geofence-unavailable",
    "proof-missing": "proof",
    "invoice-already-issued": "invoice-issued",
    "resource-exhausted": "rate-limited",
  };
  const seen = new Set();
  for (const [code, kind] of Object.entries(cases)) {
    assert.equal(errorKind({ code }), kind, code);
    const msg = friendlyErrorMessage({ code, message: "raw text that must not show" }, "fallback");
    assert.equal(msg, messageForKind(kind), code);
    assert.doesNotMatch(msg, /raw text/);
    assert.equal(isSafeUserMessage(msg), true, msg);
    seen.add(msg);
  }
  assert.ok(seen.size >= 20, "each category reads differently");
  // A missing Firestore index, as Firestore reports it.
  assert.equal(errorKind(fbError("failed-precondition", "The query requires an index.")), "index");
  // Prose never decides: a message that SAYS "permission" with no code is generic.
  assert.equal(errorKind(new Error("permission denied")), "generic");
  // Prefixed codes are understood.
  assert.equal(errorKind({ code: "functions/permission-denied" }), "permission");
});

test("a timeout is 'outcome unknown', never 'nothing was saved'", () => {
  const msg = friendlyErrorMessage(fbError("deadline-exceeded"), "x");
  assert.equal(isOutcomeUnknown(fbError("deadline-exceeded")), true);
  assert.match(msg, /can't confirm whether this was saved/);
  assert.doesNotMatch(msg, /nothing was saved/i);
  assert.equal(isOutcomeUnknown(fbError("unavailable")), false);
  assert.match(friendlyErrorMessage(fbError("unavailable"), "x"), /nothing was saved/);
});

test("unknown errors use the safe fallback", () => {
  assert.equal(friendlyErrorMessage(fbError("internal"), "The order could not be saved."), "The order could not be saved.");
  assert.equal(friendlyErrorMessage({ code: "something-new" }, "Fallback."), "Fallback.");
  assert.equal(friendlyErrorMessage(null), GENERIC_FAILURE_MESSAGE);
  assert.equal(friendlyErrorMessage(undefined, "F."), "F.");
  assert.equal(liveErrorMessage(new Error("boom"), "orders"), "Orders could not be loaded. Please try again.");
});

test("logging keeps only context, code and type — never the message", () => {
  const err = fbError("permission-denied", "secret@example.com https://proof.example/photo.jpg");
  assert.deepEqual(safeErrorContext(err), { code: "permission-denied", type: "FirebaseError" });
  const calls = [];
  const original = console.error;
  console.error = (...args) => calls.push(args);
  try {
    logSafeError("Save order", err);
  } finally {
    console.error = original;
  }
  assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(calls), /secret@example\.com|proof\.example|photo\.jpg/);
  assert.match(JSON.stringify(calls), /Save order/);
  // No page or service logs a whole error object any more.
  for (const f of SRC) {
    if (rel(f) === "src/services/liveDataErrors.js") continue;
    const code = strip(readFileSync(f, "utf8"));
    assert.equal(/console\.(error|warn|log)\(/.test(code), false, `${rel(f)}: use logSafeError`);
  }
});

// ======================================================================
// 2. Load states
// ======================================================================

test("loading, empty, permission, offline and generic-error states are distinct", () => {
  const states = [
    loadStateOf({ loading: true }),
    loadStateOf({ loading: false, isEmpty: true }),
    loadStateOf({ loading: false, isEmpty: false }),
    loadStateOf({ error: fbError("permission-denied") }),
    loadStateOf({ error: fbError("unavailable") }),
    loadStateOf({ error: fbError("unauthenticated") }),
    loadStateOf({ error: fbError("failed-precondition", "requires an index") }),
    loadStateOf({ error: fbError("internal") }),
  ];
  assert.deepEqual(states, ["loading", "empty", "ready", "permission", "offline", "signed-out", "index", "error"]);
  // An error always wins over "empty": a failed query never reads as "no records".
  assert.equal(loadStateOf({ error: fbError("internal"), isEmpty: true }), "error");
  const msgs = ["permission-denied", "unavailable", "unauthenticated", "internal"].map((c) => liveErrorMessage(fbError(c), "orders"));
  assert.equal(new Set(msgs).size, 4);
  for (const m of msgs) assert.doesNotMatch(m, /no orders|no records|nothing/i);
  assert.equal(liveErrorKind(fbError("permission-denied")), "permission");
});

test("KPIs show a dash — never a false zero — while loading or after a failed read", () => {
  assert.equal(kpiValue(0, { loading: true }), "—");
  assert.equal(kpiValue(0, { error: "Orders could not be loaded." }), "—");
  assert.equal(kpiValue(0, {}), 0);
  assert.equal(kpiValue(12, { loading: false, error: "" }), 12);
  const pages = {
    "src/pages/admin/Clinics.jsx": /value=\{kpiValue\(clinics\.length, \{ loading, error: loadError \}\)\}/,
    "src/pages/admin/Deliveries.jsx": /value=\{kpiValue\(deliveryList\.length, kpiState\)\}/,
    "src/pages/admin/Invoices.jsx": /value=\{kpiValue\(summary\.pending, \{ loading, error \}\)\}/,
    "src/pages/admin/Riders.jsx": /value=\{kpiValue\(riders\.length, kpiState\)\}/,
    "src/pages/admin/AdminAllocation.jsx": /value=\{kpiValue\(awaiting, kpiState\)\}/,
    "src/pages/salesRep/SalesRepDashboard.jsx": /value=\{kpiValue\(metrics\.total\.toLocaleString\(\), \{ error: ordersError \}\)\}/,
  };
  for (const [p, re] of Object.entries(pages)) assert.match(read(p), re, p);
});

test("a Retry re-opens the listener instead of only clearing the message", () => {
  const invoices = read("src/pages/admin/Invoices.jsx");
  assert.match(invoices, /setRetryKey\(\(k\) => k \+ 1\)/);
  assert.match(invoices, /\}, \[retryKey\]\);/);
});

// ======================================================================
// 3. Repeated taps, dialogs, confirmations
// ======================================================================

test("repeated taps cause one request; the next tap after it settles runs again", async () => {
  const flight = createSingleFlight();
  let calls = 0;
  let release;
  const action = () => {
    calls += 1;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const a = flight.run(action);
  const b = flight.run(action);
  const c = flight.run(action);
  assert.equal(calls, 1, "three taps, one request");
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(flight.busy, true);
  release("done");
  assert.equal(await a, "done");
  assert.equal(flight.busy, false);
  flight.run(() => {
    calls += 1;
    return Promise.reject(new Error("x"));
  }).catch(() => {});
  assert.equal(calls, 2);
  // A synchronous throw is captured and releases the guard.
  await flight.run(() => {
    throw new Error("sync");
  }).catch(() => {});
  assert.equal(flight.busy, false);
});

test("the shared confirmation stays open on failure, shows the reason inside, and ignores repeat presses", () => {
  const dialog = strip(read("src/components/ui/ConfirmDialog.jsx"));
  assert.match(dialog, /if \(flight\.current\.busy\) return;/);
  assert.match(dialog, /\.run\(\(\) => onConfirm\(\)\)/);
  assert.match(dialog, /\.catch\(\(failure\) => \{\s*if \(mounted\.current\) setError\(friendlyErrorMessage\(failure, failureMessage\)\);/);
  // The failure path never closes the dialog.
  const catchBlock = /\.catch\(\(failure\) => \{([\s\S]*?)\}\)/.exec(dialog)[1];
  assert.equal(/onCancel\(/.test(catchBlock), false);
  assert.match(dialog, /<p id=\{errorId\} className="m-dialog-error" role="alert">/);
  assert.match(dialog, /disabled=\{busy\}/);
  // Cancel has initial focus, so Enter on open never confirms by accident.
  assert.match(dialog, /useDialogFocus\(\{ dialogRef, initialRef: cancelRef, onDismiss: onCancel, busy \}\)/);
});

test("every page that confirms through the shared dialog rethrows on failure, so the dialog stays open", () => {
  const rethrowing = {
    "src/pages/admin/Riders.jsx": /logSafeError\("Update rider status", error\);\s*throw error;/,
    "src/pages/admin/Settings.jsx": /logSafeError\("Update user status", error\);\s*throw error;/,
    "src/pages/admin/Alerts.jsx": /logSafeError\("Resolve alert", error\);\s*throw error;/,
    "src/pages/admin/AdminAllocation.jsx": /logSafeError\("Confirm return disposition", error\);\s*throw error;/,
    "src/pages/admin/DoctorAddressesPanel.jsx": /logSafeError\("Remove legacy doctor address", error\);\s*throw error;/,
    "src/pages/admin/InvoiceEditor.jsx": /logSafeError\("Issue invoice", err\);\s*throw new UserMessageError\(/,
    "src/pages/dispatcher/DispatcherCargoLoading.jsx": /logSafeError\("Finalize dispatch", err\);\s*throw err;/,
    "src/pages/salesRep/SalesRepOrderTracking.jsx": /logSafeError\("Review destination change", failure\);\s*throw failure;/,
  };
  for (const [p, re] of Object.entries(rethrowing)) assert.match(strip(read(p)), re, p);
  // The cancel / reassign dialogs show the failure inside themselves too.
  const shipments = strip(read("src/pages/dispatcher/DispatcherShipments.jsx"));
  assert.match(shipments, /setError\(friendlyErrorMessage\(failure, "The order could not be cancelled\. Please try again\."\)\);/);
  assert.match(shipments, /setError\(friendlyErrorMessage\(failure, "The order could not be returned to the queue\. Please try again\."\)\);/);
});

test("success appears only after the authoritative write", () => {
  const order = [
    ["src/pages/admin/Riders.jsx", "await updateRiderStatus(", 'showToast(meta.done(rider.name), "success")'],
    ["src/pages/admin/Alerts.jsx", "await resolveAlert(alertId);", 'showToast("Alert marked as resolved.", "success")'],
    ["src/pages/admin/Settings.jsx", "await updateUserStatus(uid, firestoreStatus);", "showToast(`User status updated to"],
    ["src/pages/dispatcher/DispatcherCargoLoading.jsx", "await finalizeRiderDispatch(", "showToast(`Dispatch finalized for"],
    ["src/pages/salesRep/SalesRepOrderTracking.jsx", "await reviewOrderDestinationChange(", '"Destination approved. The order now uses the new address."'],
    ["src/pages/admin/AddStock.jsx", "const report = await addStockBatch(", 'showMessage("Stock added successfully.", "success")'],
  ];
  for (const [p, write, success] of order) {
    const src = read(p);
    const w = src.indexOf(write);
    const s = src.indexOf(success);
    assert.ok(w !== -1 && s !== -1 && s > w, `${p}: success must follow the awaited write`);
  }
  // A failed clipboard copy is never reported as "ready".
  const tracking = read("src/pages/salesRep/SalesRepOrderTracking.jsx");
  assert.equal(/ready to share/i.test(tracking), false);
  assert.match(tracking, /couldn't be copied/);
});

test("destructive and hard-to-reverse actions confirm, naming the target and the consequence", () => {
  const usages = [];
  for (const f of UI) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/<(?:ConfirmDialog|AppConfirmDialog)\b([\s\S]*?)\/>/g)) usages.push([rel(f), m[1]]);
  }
  const files = new Set(usages.map(([f]) => f));
  for (const required of [
    "src/pages/admin/Riders.jsx", // approve / reject / off duty / reactivate
    "src/pages/admin/Settings.jsx", // approve / deactivate / reactivate / reject
    "src/pages/admin/Alerts.jsx", // resolve
    "src/pages/admin/AdminAllocation.jsx", // return disposition (stock)
    "src/pages/admin/DoctorAddressesPanel.jsx", // remove legacy address
    "src/pages/admin/InvoiceEditor.jsx", // issue invoice, leave with unsaved changes
    "src/pages/dispatcher/DispatcherCargoLoading.jsx", // finalize dispatch
    "src/pages/salesRep/SalesRepOrderTracking.jsx", // destination approve / reject
  ]) {
    assert.ok(files.has(required), `${required} must confirm through the shared dialog`);
  }
  for (const [f, props] of usages) {
    if (f === "src/pages/StyleGuide.jsx") continue;
    assert.match(props, /\btarget=\{/, `${f}: names the target`);
    assert.match(props, /\bconsequence=/, `${f}: states the consequence`);
  }
  // Cancel order keeps its own reasoned dialog, which names order and clinic and says it cannot be undone.
  assert.match(read("src/pages/dispatcher/DispatcherShipments.jsx"), /will\s+be cancelled\. This cannot be undone\./);
  // Stock correction is its own dialog naming the batch and what it does not change.
  assert.match(read("src/pages/admin/Inventory.jsx"), /it does not change reservations or any\s+order already placed\./);
});

// ======================================================================
// 4. Keyboard, focus, live regions
// ======================================================================

test("dialog keyboard: Escape closes unless busy; Tab wraps inside", () => {
  assert.equal(dialogKeyAction({ key: "Escape" }), "dismiss");
  assert.equal(dialogKeyAction({ key: "Escape", busy: true }), null, "never abandons a running write");
  assert.equal(dialogKeyAction({ key: "Escape", dismissible: false }), null);
  assert.equal(dialogKeyAction({ key: "Tab" }), "trap");
  assert.equal(dialogKeyAction({ key: "Enter" }), null);
  assert.equal(nextFocusIndex({ count: 3, current: 2, shift: false }), 0, "Tab on the last wraps to the first");
  assert.equal(nextFocusIndex({ count: 3, current: 0, shift: true }), 2, "Shift+Tab on the first wraps to the last");
  assert.equal(nextFocusIndex({ count: 3, current: 1, shift: false }), null, "the browser moves normally inside");
  assert.equal(nextFocusIndex({ count: 3, current: -1, shift: false }), 0, "focus outside is pulled back in");
  assert.equal(nextFocusIndex({ count: 0, current: -1, shift: false }), -1);
  const hook = strip(read("src/components/ui/useDialogFocus.js"));
  assert.match(hook, /window\.addEventListener\("keydown", onKeyDown, true\)/, "handled before document-level modals");
  assert.match(hook, /if \(openDialogs\[openDialogs\.length - 1\] !== token\) return;/, "only the top-most dialog reacts");
  assert.match(hook, /opener\.focus\(\)/, "focus returns to the opener");
});

test("errors are alerts, everything else is polite; toasts stay long enough and errors persist", () => {
  assert.equal(liveRoleFor("error"), "alert");
  for (const t of ["success", "warning", "info"]) assert.equal(liveRoleFor(t), "status");
  assert.equal(TOAST_DURATION_MS.error, null, "an error toast stays until dismissed");
  assert.ok(TOAST_DURATION_MS.success >= 5000 && TOAST_DURATION_MS.info >= 5000 && TOAST_DURATION_MS.warning >= 8000);
  assert.equal(normalizeTone("bogus"), "info");
  const feedback = strip(read("src/components/ui/Feedback.jsx"));
  assert.match(feedback, /<div className="m-toast-region" aria-live="polite" aria-atomic="true">/);
  assert.match(feedback, /role=\{live \? liveRoleFor\(t\) : undefined\}/);
  assert.match(feedback, /<span className="m-visually-hidden">\{TONE_LABELS\[t\]\}: <\/span>/, "tone is not carried by colour alone");
  assert.match(feedback, /aria-label="Dismiss message"/);
  // No page keeps a 2-second toast any more.
  for (const f of UI) assert.equal(/setTimeout\(\(\) => setToast\(""\), \d+\)/.test(readFileSync(f, "utf8")), false, rel(f));
});

test("layout holds at 320 px and 200% text: no fixed widths, text wraps, actions stack", () => {
  const css = read("src/components/ui/feedback.css");
  assert.match(css, /width: min\(420px, calc\(100vw - 32px\)\)/, "toasts fit a 320 px viewport");
  assert.match(css, /width: min\(480px, 100%\)/, "dialogs never exceed the viewport");
  assert.match(css, /max-height: calc\(100vh - 32px\);\s*overflow-y: auto;/, "tall dialogs scroll at 200% text");
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /@media \(max-width: 480px\) \{[\s\S]*?\.m-dialog-actions \{ flex-direction: column-reverse; \}/);
  assert.equal(/white-space: nowrap/.test(css.replace(/\.m-visually-hidden \{[\s\S]*?\}/, "")), false);
  assert.equal(/(?<![-\w])width: \d{3,}px/.test(css), false, "no fixed pixel widths");
});

// ======================================================================
// 5. Forms
// ======================================================================

test("field validation is associated accessibly, and focus goes to the first invalid field", () => {
  assert.equal(errorIdFor("new-clinic", "name"), "new-clinic-name-error");
  assert.deepEqual(fieldA11y("f", "name", { name: "Required." }, { hint: "f-hint" }), {
    "aria-invalid": "true",
    "aria-describedby": "f-name-error f-hint",
  });
  assert.deepEqual(fieldA11y("f", "name", {}, { hint: "f-hint" }), { "aria-invalid": undefined, "aria-describedby": "f-hint" });
  assert.deepEqual(fieldA11y("f", "name", {}), { "aria-invalid": undefined, "aria-describedby": undefined });
  const order = ["name", "contact", "phone"];
  assert.equal(firstInvalidField(order, { phone: "x", contact: "y" }), "contact", "screen order, not object order");
  assert.equal(firstInvalidField(order, {}), null);
  assert.equal(hasErrors({ a: undefined }), false);
  const focused = [];
  const el = (id) => ({ focus: () => focused.push(id), scrollIntoView: () => {} });
  assert.equal(focusFirstInvalid(order, { phone: "x", contact: "y" }, el), "contact");
  assert.deepEqual(focused, ["contact"]);

  // The validators say which field failed (no English parsing in the pages).
  assert.equal(validateStockCorrection({ newQuantity: -1, reason: "x" }).field, "quantity");
  assert.equal(validateStockCorrection({ newQuantity: 5, reservedQuantity: 0, reason: "" }).field, "reason");
  assert.equal(validateApplication({ name: "", email: "a@b.co" }).field, "name");
  assert.equal(validateApplication({ name: "A", email: "a@b.co", role: "salesrep", password: "12345678", confirmPassword: "x" }).field, "confirmPassword");
  assert.equal(registrationErrorField("auth/email-already-in-use"), "email");
  assert.equal(analyticsConfigPayload("v1", { leadTimeDays: "0", safetyMode: "quantity", safetyValue: "1" }).field, "leadTimeDays");
  assert.equal(analyticsConfigPayload("v1", { leadTimeDays: "5", safetyMode: "quantity", safetyValue: "-1" }).field, "safetyValue");

  // Each major form wires aria-invalid + aria-describedby and moves focus.
  const forms = {
    "src/pages/Register.jsx": [/\{\.\.\.a11y\("email"\)\}/, /id="register-error"/, /document\.getElementById\(REGISTER_FIELD_IDS\[field\]\)\?\.focus\(\)/],
    "src/pages/ForgotPassword.jsx": [/aria-invalid=\{error \? "true" : undefined\}/, /aria-describedby=\{error \? "forgot-error" : undefined\}/, /getElementById\("forgot-email"\)\?\.focus\(\)/],
    "src/pages/admin/AddStock.jsx": [/\{\.\.\.a11y\("batchId"\)\}/, /return failField\("batchId"/, /el\?\.focus\(\)/],
    "src/pages/admin/AddVaccine.jsx": [/\{\.\.\.a11y\("vaccineName"\)\}/, /return failField\("internalSku"/, /el\?\.focus\(\)/],
    "src/pages/admin/Clinics.jsx": [/\{\.\.\.fieldA11y\("new-clinic", "name", errors\)\}/, /focusFirstInvalid\(CLINIC_FIELD_ORDER/],
    "src/components/profile/MyProfile.jsx": [/aria-describedby=\{errors\.name \? "my-profile-name-error" : undefined\}/, /focusFirstInvalid\(\["name", "phone"\]/],
    "src/pages/admin/AiInventoryAnalytics.jsx": [/\{\.\.\.a11y\("leadTimeDays"\)\}/, /getElementById\(ids\[checked\.field\]\)\?\.focus\(\)/],
    "src/pages/admin/Inventory.jsx": [/aria-invalid=\{correctErrorField === "quantity" \? "true" : undefined\}/, /getElementById\(pre\.field === "reason" \? "inv-correct-reason" : "inv-correct-input"\)\?\.focus\(\)/],
  };
  for (const [p, patterns] of Object.entries(forms)) {
    const src = read(p);
    for (const re of patterns) assert.match(src, re, `${p}: ${re}`);
  }
});

test("values survive a failed submission — failure paths never reset the form", () => {
  const clinics = strip(read("src/pages/admin/Clinics.jsx"));
  const catchBlock = /logSafeError\("Register clinic", error\);([\s\S]*?)\} finally/.exec(clinics)[1];
  assert.equal(/setNewClinic\(|closeNewClinic\(/.test(catchBlock), false, "the dialog keeps the typed clinic");
  assert.match(catchBlock, /Your entries are still here/);
  const addStock = strip(read("src/pages/admin/AddStock.jsx"));
  const stockCatch = /logSafeError\("Add stock", error\);([\s\S]*?)\} finally/.exec(addStock)[1];
  assert.equal(/set(BatchId|Quantity|UnitPrice|ExpiryDate|ArrivalDate|ManufacturingDate)\(/.test(stockCatch), false);
  const register = strip(read("src/pages/Register.jsx"));
  const regCatch = /\} catch \(err\) \{([\s\S]*?)\} finally/.exec(register)[1];
  assert.equal(/set(FullName|Email|Password|ConfirmPassword)\(/.test(regCatch), false);
  // Place Order keeps the cart on failure.
  assert.match(read("src/pages/salesRep/SalesRepPlaceOrder.jsx"), /Your cart and entries are still here/);
});

// ======================================================================
// 6. Sweeps
// ======================================================================

test("no native alert, confirm or prompt, and no page reload", () => {
  for (const f of SRC) {
    const code = strip(readFileSync(f, "utf8"));
    // ("alert(s)" in visible text such as "3 unread alert(s)" is not a call.)
    assert.equal(/(?:^|[^.\w])(?:window\.)?(?:alert|confirm|prompt)\((?!s\))/.test(code), false, `${rel(f)}: native dialog`);
    assert.equal(/location\.reload\(/.test(code), false, `${rel(f)}: page reload`);
  }
});

test("no err.message / error.message is rendered except through the approved mapper", () => {
  for (const f of UI) {
    if (DEV_ONLY.has(rel(f))) continue;
    const code = strip(readFileSync(f, "utf8"));
    assert.equal(
      /\b(?:err|error|e|ex|failure|reason)\??\.message\b/.test(code),
      false,
      `${rel(f)}: route the error through friendlyErrorMessage / liveErrorMessage`
    );
  }
  // The callable wrappers never pass an unexpected failure's text through.
  for (const f of ["inventoryCallables.js", "invoiceCallables.js", "scheduleCallables.js"]) {
    const src = read("src", "services", f);
    assert.match(src, /"service-unavailable",/);
  }
  assert.doesNotMatch(read("src/services/invoiceCallables.js"), /return error\?\.message/);
  assert.doesNotMatch(read("src/services/assignmentQueue.js"), /return \{ message: error\.message/);
});

test("no raw provider HTTP status or provider text reaches the routing UI", () => {
  const route = strip(read("src/services/routeService.js"));
  assert.equal(/Routing service error|res\.status\}|error\?\.message \|\| e\?\.error|MISSING_KEY/.test(route), false);
  assert.match(route, /res\.status === 429 \? "route-rate-limited" : "route-provider-error"/);
  const err = new RouteServiceError("route-provider-error", "The routing service couldn't plan this route right now. Nothing was saved — try again in a moment.");
  assert.equal(friendlyErrorMessage(err, "x"), err.message);
  const geo = strip(read("src/pages/dispatcher/DispatcherGeofence.jsx"));
  assert.equal(/MISSING_KEY|API key not configured/.test(geo), false);
});

test("placeholder controls are disabled with an explanation — they cannot trigger false progress", () => {
  const pages = {
    // Alerts' "View Route" placeholder became a real "Open delivery" link
    // (tests/alertPresentation.test.js); only "Contact Rider" is still unbuilt.
    "src/pages/admin/Alerts.jsx": ["alert-unavailable-actions", ["Contact Rider"]],
    "src/pages/admin/Riders.jsx": ["rider-unavailable-actions", ["Contact Rider", "View Route"]],
    "src/pages/admin/Clinics.jsx": ["clinic-edit-unavailable", ["Edit Clinic"]],
  };
  for (const [p, [noteId, labels]] of Object.entries(pages)) {
    const src = read(p);
    assert.match(src, new RegExp(`id="${noteId}"`), `${p}: the explanation exists`);
    for (const label of labels) {
      const at = src.indexOf(label);
      const tag = src.lastIndexOf("<button", at);
      const button = src.slice(tag, src.indexOf(">", src.indexOf(`aria-describedby="${noteId}"`, tag)) + 1);
      assert.match(button, /\bdisabled\b/, `${p}: ${label} is disabled`);
      assert.match(button, new RegExp(`aria-describedby="${noteId}"`), `${p}: ${label} is described`);
      assert.equal(/onClick/.test(button), false, `${p}: ${label} has no click handler`);
    }
    // No toast pretends the action happened.
    assert.equal(/Contacting |Opening route|Editing \$\{|Grid view can be added|No new (clinic|rider) notifications/.test(src), false, p);
  }
  // Removed outright: notification bells with no feed, and the old toast-only
  // grid button. Clinics now has a REAL List/Grid toggle (tests/clinicsView.test.js);
  // the fake one must not come back.
  assert.equal(/clinics-view-btn|Grid3X3|Grid view can be added/.test(read("src/pages/admin/Clinics.jsx")), false);
  assert.equal(/<Bell\b/.test(read("src/pages/admin/Riders.jsx")) || /<Bell\b/.test(read("src/pages/admin/Clinics.jsx")), false);
});

test("the false-success Register Clinic page is gone; its paths go to the real registration", () => {
  const app = read("src/App.jsx");
  assert.match(app, /<Route path="\/admin\/register-clinic" element=\{<Navigate to="\/admin\/clinics" replace \/>\} \/>/);
  assert.match(app, /<Route path="\/admin\/clinic-success" element=\{<Navigate to="\/admin\/clinics" replace \/>\} \/>/);
  assert.equal(/RegisterClinic|ClinicSuccess/.test(app), false);
  assert.equal(SRC.some((f) => /RegisterClinic\.jsx|ClinicSuccess\.jsx/.test(f)), false);
});

test("existing business-domain messages remain intact", () => {
  const placeOrder = read("src/pages/salesRep/SalesRepPlaceOrder.jsx");
  for (const text of [
    "while you were ordering. Nothing was placed. Accept the new standard price on that line, check your agreed price, and confirm again.",
    "Give a reason for every negotiated price that differs from the standard price. Nothing was placed.",
    "An earlier attempt of this checkout was already placed with different details.",
    "One of these batches has expired and can no longer be ordered.",
  ]) {
    assert.ok(placeOrder.includes(text), text);
  }
  // SC/PWD attestation, negotiated pricing and geofence sentences survive the mapper.
  const pricing = read("src/services/negotiatedPricing.js");
  assert.match(pricing, /Confirm that you verified the customer's eligibility for each statutory discount\./);
  const attest = new UserMessageError("Confirm that you verified the customer's eligibility for each statutory discount.", { code: "eligibility-not-confirmed" });
  assert.equal(friendlyErrorMessage(attest, "x"), attest.message);
  const geofence = new UserMessageError("You are 420 m from the clinic. Move within 300 m and try again.", { code: "delivery-outside-geofence" });
  assert.equal(friendlyErrorMessage(geofence, "x"), geofence.message);
  // Assignment conflicts keep their wording.
  assert.match(read("src/services/assignmentQueue.js"), /This order no longer exists\. The list has been updated\./);
  // Invoice domain messages keep theirs.
  assert.match(read("src/services/invoiceCallables.js"), /This invoice has already been issued and can no longer be edited\./);
});
