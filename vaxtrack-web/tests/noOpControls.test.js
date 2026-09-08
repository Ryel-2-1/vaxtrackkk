import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * No control may report success it did not perform.
 *
 * Two Admin surfaces claimed to do work they never did:
 *
 *   Alert Settings — six toggles and a "Save Settings" button that showed
 *   "Alert settings saved." Nothing in the app read `alertSettings`; no
 *   service, Firestore field or localStorage key existed for it. Two of the
 *   toggles offered to configure push and email delivery, which the system does
 *   not have at all.
 *
 *   Inventory bulk actions — checkboxes and a selected-count bar whose
 *   "Mark as Checked" and "Generate Report" buttons only raised a toast.
 *
 * These are source-shape assertions on purpose: the defect was the PRESENCE of
 * a control, so the regression to prevent is its return. Behaviour that does
 * exist (price writes, resolve, mark-read) is covered by the service suites.
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/** Source with comments stripped — the fixes explain the old code in prose. */
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "");

// ------------------------------------------------------------ alert settings

test("Alert delivery stores no preference nothing consumes", () => {
  const src = code("src/pages/admin/Alerts.jsx");

  // The state itself is gone. Persisting these instead would only have moved
  // the false promise from the toast into the database.
  assert.equal(/alertSettings/.test(src), false, "no alert-preference state may exist");
  assert.equal(/setAlertSettings/.test(src), false);
  for (const key of ["routeDeviation", "coldChain", "deliveryDelay"]) {
    assert.equal(
      new RegExp(`${key}\\s*:`).test(src),
      false,
      `${key} must not be stored as a preference`
    );
  }
});

test("no save action and no saved confirmation exist for alert delivery", () => {
  const src = code("src/pages/admin/Alerts.jsx");

  assert.equal(/handleSaveSettings/.test(src), false, "the save handler must be gone");
  assert.equal(
    /settings saved/i.test(src),
    false,
    "nothing may report that settings were saved"
  );
  assert.equal(/Save Settings/.test(src), false, "no Save button");
  assert.equal(/AlertSettingsModal/.test(src), false, "the editable modal must be gone");
  assert.match(src, /AlertChannelsModal/, "replaced by the read-only channel list");
});

test("the alert delivery modal is read-only and names unavailable channels", () => {
  const src = read("src/pages/admin/Alerts.jsx");
  const modal = /function AlertChannelsModal\(\{ onClose \}\) \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(modal, "the channel modal must exist");

  // No interactive control other than Close.
  assert.equal(
    /onChange=|setSettings|type="checkbox"/.test(modal[1]),
    false,
    "the channel list must contain no editable control"
  );
  // It states what is true rather than offering to change it.
  assert.match(modal[1], /Not configured/);
  assert.match(modal[1], /In-app alerts/);
  assert.match(modal[1], /Push notifications/);
  assert.match(modal[1], /Email notifications/);
  // And it does not claim a channel that does not exist is on. Checked per
  // channel object, not by proximity — the in-app entry legitimately carries
  // `available: true` a few lines above the push entry.
  for (const name of ["Push notifications", "Email notifications"]) {
    const entry = new RegExp(
      `\\{[^{}]*available:\\s*(true|false)[^{}]*title:\\s*"${name}"[\\s\\S]*?\\}`
    ).exec(modal[1]);
    assert.ok(entry, `${name} must be listed`);
    assert.match(entry[0], /available: false/, `${name} must not be marked available`);
  }
});

test("no push or email delivery was implemented by this change", () => {
  // The subtask removes a false claim; it does not build the channels.
  for (const p of ["src/pages/admin/Alerts.jsx", "src/services/alertService.js"]) {
    const src = code(p);
    for (const token of ["getMessaging", "firebase/messaging", "sendEmail", "nodemailer"]) {
      assert.equal(src.includes(token), false, `${p} must not implement ${token}`);
    }
  }
});

// -------------------------------------------------------- inventory bulk ops

test("inventory bulk selection and its fake actions are gone", () => {
  const src = code("src/pages/admin/Inventory.jsx");

  for (const token of [
    "selectedBatches", "toggleBatch", "toggleAll", "isAllSelected", "v2-bulk-bar",
  ]) {
    assert.equal(src.includes(token), false, `${token} must be gone`);
  }
  assert.equal(
    /type="checkbox"/.test(src),
    false,
    "no row or header checkbox may remain"
  );
  for (const claim of ["marked as checked", "Batch report generated", "Mark as Checked", "Generate Report"]) {
    assert.equal(
      src.includes(claim),
      false,
      `"${claim}" reported work that never happened`
    );
  }
});

test("genuine single-batch actions are preserved", () => {
  const src = read("src/pages/admin/Inventory.jsx");

  // Manage Price still writes, through the service, with its dialog intact.
  assert.match(src, /updateStockPrice\(\{/);
  assert.match(src, /openPriceDialog\(item\)/);
  assert.match(src, /Set price/);
  assert.match(src, /Edit price/);
  assert.match(src, /handleSavePrice/);
  // Its toast follows a real await, so it reports something that happened.
  const save = /const handleSavePrice = async \(\) => \{([\s\S]*?)\n {2}\};/.exec(src);
  assert.ok(save, "the price handler must exist");
  const awaitAt = save[1].indexOf("await updateStockPrice");
  const toastAt = save[1].indexOf("showToast(");
  assert.ok(awaitAt !== -1 && toastAt > awaitAt, "the toast must follow the write");

  // Rows still open their detail drawer.
  assert.match(src, /onClick=\{\(\) => setSelectedVaccine\(item\)\}/);
});

test("no delete, status-change or stock-adjustment writer was invented", () => {
  const src = code("src/pages/admin/Inventory.jsx");

  for (const token of ["deleteDoc", "adjustStock", "setQuantity", "updateStatus", "batchUpdate"]) {
    assert.equal(src.includes(token), false, `${token} must not have been added`);
  }
  // The page still reaches Firestore only through services.
  assert.equal(
    /from ["']firebase\/firestore["']/.test(src),
    false,
    "Inventory must not import the Firestore SDK directly"
  );
});

// ------------------------------------------------------------ shared rule

test("no admin page reports success without an awaited write", () => {
  // A toast that is not preceded by an `await` in its own handler is a claim
  // with nothing behind it. Both pages are checked as a pair so neither drifts.
  //
  // Both instances that were outstanding here have since been corrected:
  // Admin Settings' false save and its inert org/regional/feature controls, and
  // the Inventory drawer's "Batch history" / "Flag for review". Those are
  // asserted in tests/adminSettings.test.js, whose own copy of this rule now
  // covers all three admin pages — so this loop deliberately stays on the two
  // surfaces it was written for rather than duplicating that coverage.
  for (const p of ["src/pages/admin/Alerts.jsx", "src/pages/admin/Inventory.jsx"]) {
    const src = read(p);
    const toasts = [...src.matchAll(/showToast\((["'`])(.*?)\1/g)].map((m) => m[2]);

    for (const message of toasts) {
      assert.equal(
        /\b(saved|generated|exported|updated)\b/i.test(message) && !/Price updated/.test(message),
        false,
        `${p}: "${message}" claims completed work — it needs a real writer or must go`
      );
    }
  }
});
