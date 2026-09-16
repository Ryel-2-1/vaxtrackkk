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
  // with nothing behind it.
  //
  // Admin Settings' false save and its inert org/regional/feature controls are
  // asserted in tests/adminSettings.test.js, whose own copy of this rule covers
  // all three admin pages. Admin Inventory's export was once a fake toast and
  // was guarded here by banning success words like "exported"; it is now a
  // real, AWAITED download, so its behaviour is verified directly in the
  // Inventory-specific test below rather than by forbidding a word. This keyword
  // sweep therefore stays on Alerts — the one surface here with no legitimate
  // success-word feedback of its own.
  for (const p of ["src/pages/admin/Alerts.jsx"]) {
    const src = read(p);
    const toasts = [...src.matchAll(/showToast\((["'`])(.*?)\1/g)].map((m) => m[2]);

    for (const message of toasts) {
      assert.equal(
        /\b(saved|generated|exported|updated)\b/i.test(message),
        false,
        `${p}: "${message}" claims completed work — it needs a real writer or must go`
      );
    }
  }
});

test("Inventory export shows feedback only after a real, awaited download", () => {
  // Replaces the old success-word ban on Inventory. The export is genuine now:
  // it runs through the export service, awaits it, and only then reports — and
  // it cannot be double-fired. Those are the properties worth protecting, not
  // the wording of the toast (requirement: do not depend on exact wording).
  const src = read("src/pages/admin/Inventory.jsx");

  // 1. The page drives the export through the real service, not a fake toast.
  assert.match(
    src,
    /from ["']\.\.\/\.\.\/services\/inventoryExport["']/,
    "Inventory must import the real export service"
  );
  assert.match(src, /downloadInventoryWorkbook/, "it must call the export service");

  // The export handler body, isolated so the checks below are about it alone.
  const handler = /const handleExport = async \(\) => \{([\s\S]*?)\n {2}\};/.exec(src);
  assert.ok(handler, "the export handler must exist");
  const body = handler[1];

  // 5. It cannot fire a second export while one is running: an in-flight guard
  //    inside the handler, backed by a disabled button (asserted below).
  assert.match(body, /if \(exporting\b[\s\S]*?\breturn;/, "a re-entrancy guard must exist");
  assert.match(body, /setExporting\(true\)/, "the in-flight flag must be raised");
  assert.match(body, /setExporting\(false\)/, "and cleared when done");

  // 2. Success feedback lives INSIDE the try and AFTER awaiting the download,
  //    so it can only report work that actually completed. The message text is
  //    intentionally not asserted.
  const tryBlock = /try \{([\s\S]*?)\} catch/.exec(body);
  assert.ok(tryBlock, "the handler must await inside a try");
  const awaitAt = tryBlock[1].indexOf("await downloadInventoryWorkbook");
  const successAt = tryBlock[1].indexOf("showToast(");
  assert.ok(awaitAt !== -1, "the download must be awaited");
  assert.ok(
    successAt !== -1 && successAt > awaitAt,
    "success feedback must follow the awaited download"
  );

  // 3. Failure feedback travels the handler's own error path.
  const catchBlock = /catch \(\w+\) \{([\s\S]*?)\n {4}\} finally/.exec(body);
  assert.ok(catchBlock, "the handler must handle failure in a catch");
  assert.match(catchBlock[1], /showToast\(/, "failure must surface through feedback");

  // 4 (+5). The button invokes the real handler and is disabled while exporting.
  assert.match(src, /onClick=\{handleExport\}/, "the button must call the real handler");
  assert.match(src, /Export to Excel/, "the export control must be present");
  assert.match(
    src,
    /disabled=\{[^}]*\bexporting\b[^}]*\}/,
    "the button must be disabled while an export is in flight"
  );
});
