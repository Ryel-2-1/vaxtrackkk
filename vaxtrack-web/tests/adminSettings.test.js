import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Admin Settings and the Inventory drawer state only what is true.
 *
 * Negative controls were run first against the unfixed code and all five
 * passed, proving: "Save Settings" wrote nothing, no settingsService or
 * `settings` collection existed, none of the eleven fields had a consumer
 * anywhere, the regional card advertised a date format the app never used, and
 * both drawer actions were toast-only.
 *
 * Nothing was persisted to resolve that. A stored setting no reader consumes is
 * the same false promise relocated into Firestore, and it would then need
 * rules, an audit trail and a migration to maintain a value that changes
 * nothing. These are the permanent assertions that replaced those controls.
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const code = (p) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");

const SETTINGS_FIELDS = [
  "organizationName", "registrationId", "primaryContact",
  "timeZone", "language", "dateFormat",
  "inventoryAlerts", "lowStockAlerts", "expiryAlerts",
  "routeDeviationAlerts", "deliveryStatusNotifications",
];

// --------------------------------------------------------- no false save

test("Admin Settings has no save action and no saved confirmation", () => {
  const src = code("src/pages/admin/Settings.jsx");

  assert.equal(/handleSave\b/.test(src), false, "the save handler must be gone");
  assert.equal(/handleDiscard/.test(src), false, "discard implied a save");
  assert.equal(/Save Settings/.test(src), false, "no Save button");
  assert.equal(
    /settings saved/i.test(src),
    false,
    "nothing may claim settings were saved"
  );
});

test("no editable field exists without a persistence and consumer path", () => {
  const src = code("src/pages/admin/Settings.jsx");

  // The eleven inert fields are gone entirely — not merely disabled, which
  // would still imply a setting exists somewhere.
  for (const field of SETTINGS_FIELDS) {
    assert.equal(
      src.includes(field),
      false,
      `${field} had no consumer, so it must not be a field at all`
    );
  }

  // And the General tab holds no input, select or toggle of any kind.
  const general = /function GeneralSettings\(\) \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(general, "GeneralSettings must exist");
  for (const control of ["<input", "<select", "<textarea", "onChange"]) {
    assert.equal(
      general[1].includes(control),
      false,
      `the read-only General tab must contain no ${control}`
    );
  }
});

test("no settings document, service or rule was invented", () => {
  // Requirement: do not persist fields merely to make a Save button work. The
  // condition that would have justified a canonical settings document — org
  // info consumed by invoices or reports — is NOT met: the invoice carries its
  // own COMPANY_NAME constant plus per-invoice company fields.
  let hasService = true;
  try {
    read("src/services/settingsService.js");
  } catch {
    hasService = false;
  }
  assert.equal(hasService, false, "no settingsService was created");
  assert.equal(
    /match \/settings\//.test(read("firestore.rules")),
    false,
    "no settings collection was added to the rules"
  );
});

// ---------------------------------------------------- the facts it states

test("the invoice issuer is shown from the real source, not a copy", () => {
  const src = read("src/pages/admin/Settings.jsx");
  // Rendered from the actual constant the invoice uses, so the two cannot
  // drift. A typed-in duplicate would be wrong the moment either changed.
  assert.match(src, /import \{ COMPANY_NAME \} from "\.\.\/\.\.\/services\/invoiceModel"/);
  assert.match(src, /\{COMPANY_NAME\}/);
  assert.match(read("src/services/invoiceModel.js"), /export const COMPANY_NAME =/);
});

test("the date format shown is derived, not asserted", () => {
  const src = read("src/pages/admin/Settings.jsx");

  // The old card hardcoded "DD/MM/YYYY", which the app has never rendered.
  // Checked against comment-stripped source: the code comment explaining the
  // correction may name the old value, but nothing rendered may.
  assert.equal(
    /DD\/MM\/YYYY/.test(code("src/pages/admin/Settings.jsx")),
    false,
    "the false format claim is gone from everything rendered"
  );
  // The replacement formats a real date with the same options used throughout,
  // so it cannot describe a format the app does not produce.
  assert.match(src, /toLocaleDateString\("en-US", \{/);
  assert.match(src, /\{sampleDateDisplay\}/);
});

test("the time zone claim is the one the code actually enforces", () => {
  const src = read("src/pages/admin/Settings.jsx");
  assert.match(src, /Asia\/Manila \(UTC\+8\)/);
  // Load-bearing elsewhere: the expiry cutoff really is Manila date-only.
  assert.match(read("functions/src/policy.js"), /MANILA_OFFSET_MINUTES = 8 \* 60/);
  assert.match(read("src/pages/salesRep/SalesRepRequestOrder.jsx"), /Asia\/Manila/);
});

test("System Features toggles are gone, along with their warning dialog", () => {
  const src = code("src/pages/admin/Settings.jsx");

  assert.equal(/FeatureToggle/.test(src), false, "the toggle component must be gone");
  assert.equal(/handleFeatureToggle/.test(src), false);
  assert.equal(/pendingDisable/.test(src), false);
  // The dialog warned that disabling route-deviation alerts "may prevent admins
  // from receiving rider route warnings" — something it had no power to do.
  assert.equal(/may prevent admins from receiving/.test(src), false);
  assert.equal(/ConfirmModal/.test(src), false, "its only caller is gone");
});

// -------------------------------------------------------- inventory drawer

test("no toast-only action remains in the Inventory drawer", () => {
  const src = code("src/pages/admin/Inventory.jsx");

  for (const claim of ["Batch history opened.", "Batch flagged for review."]) {
    assert.equal(src.includes(claim), false, `"${claim}" must be gone`);
  }
  assert.equal(/View Batch History/.test(src), false);
  assert.equal(/Flag for Review/.test(src), false);
});

test("no history source or review flag was invented", () => {
  const src = code("src/pages/admin/Inventory.jsx");
  for (const token of ["batchHistory", "reviewStatus", "flaggedAt", "flaggedByUid"]) {
    assert.equal(src.includes(token), false, `${token} must not have been added`);
  }
  assert.equal(
    /match \/batchHistory\/|match \/inventoryHistory\//.test(read("firestore.rules")),
    false,
    "no history collection was added to the rules"
  );
});

test("genuine batch actions and information remain", () => {
  const src = read("src/pages/admin/Inventory.jsx");

  // Add Stock really navigates.
  assert.match(src, /onClick=\{\(\) => navigate\("\/admin\/add-stock"\)\}/);
  // Set/Edit price still writes, and its toast still follows the await.
  assert.match(src, /updateStockPrice\(\{/);
  assert.match(src, /Set price/);
  assert.match(src, /Edit price/);
  const save = /const handleSavePrice = async \(\) => \{([\s\S]*?)\n {2}\};/.exec(src);
  assert.ok(save, "the price handler must exist");
  assert.ok(
    save[1].indexOf("showToast(") > save[1].indexOf("await updateStockPrice"),
    "the price toast must follow the write"
  );
  // The drawer still shows the batch's real details.
  for (const field of ["Location", "Manufacturer", "selectedVaccine.batch"]) {
    assert.ok(src.includes(field), `${field} must still be shown`);
  }
});

// ---------------------------------------------------------------- shared

test("no admin page reports success without an awaited write", () => {
  // Settings joins the rule now that its false save is gone, and the Inventory
  // drawer's two toast-only actions were the last exclusion. What remains on
  // Settings are informational chips that state a fact rather than claim work.
  const CLAIM = /\b(saved|generated|exported|created|deleted|flagged)\b/i;

  for (const p of [
    "src/pages/admin/Alerts.jsx",
    "src/pages/admin/Inventory.jsx",
    "src/pages/admin/Settings.jsx",
  ]) {
    const src = read(p);
    const messages = [...src.matchAll(/showToast\(\s*["']([^"']*)["']/g)].map((m) => m[1]);
    for (const message of messages) {
      assert.equal(
        CLAIM.test(message),
        false,
        `${p}: "${message}" claims completed work — it needs a real writer or must go`
      );
    }
  }
});
