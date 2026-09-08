import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CRITICAL_WITHIN_DAYS,
  WARNING_WITHIN_DAYS,
  daysUntilExpiry,
  deriveExpiryCondition,
  isExpiredOrUndated,
  isoDateOnly,
  manilaToday,
} from "../src/services/expiry.js";

/**
 * `inventory.status` is not the authority for expiry condition.
 *
 * Negative controls were run first against the unfixed code and all seven
 * passed, proving: a batch stored "Stable" stayed stable however close to
 * expiry it got; an EXPIRED batch stored "Stable" still displayed as stable
 * while the same row carried an "Expired" flag; a stale "Critical" on a
 * far-future batch drove both admin surfaces; a missing or malformed date
 * silently became "Stable" and was counted as safe stock; Admin Inventory mixed
 * local-midnight and Manila conventions on one row; and the one Manila helper
 * that existed was trapped inside Sales Rep Request Order.
 *
 * The stored field is left exactly as it is. No migration, scheduled job, cron
 * task, collection or write was added — a corrected value written back would
 * need its own writer to stay true, which is the arrangement that produced the
 * stale field in the first place.
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const INV = read("src/pages/admin/Inventory.jsx");
const DASH = read("src/pages/admin/AdminDashboard.jsx");
const SRI = read("src/pages/salesRep/SalesRepInventory.jsx");
const EXPIRY = read("src/services/expiry.js");

/** 2026-09-08T02:00Z is already 2026-09-08 in Manila (UTC+8). */
const NOW = Date.parse("2026-09-08T02:00:00.000Z");
const TODAY = manilaToday(NOW);

// --------------------------------------------- the stored field is not used

test("a batch stored stable but near expiry is not stable", () => {
  // Stamped "Stable" when it was added six months out; it now expires in 3 days.
  const batch = { status: "Stable", expiryDate: "2026-09-11" };
  const { level, daysRemaining } = deriveExpiryCondition(batch, TODAY);
  assert.equal(daysRemaining, 3);
  assert.equal(level, "critical");
});

test("a batch stored stable but expired is expired, and is not orderable", () => {
  const batch = { status: "Stable", expiryDate: "2020-01-01" };
  assert.equal(deriveExpiryCondition(batch, TODAY).level, "expired");
  assert.equal(isExpiredOrUndated(batch, TODAY), true);
});

test("a stale stored critical does not control a far-future batch", () => {
  const batch = { status: "Critical", expiryDate: "2030-12-31" };
  assert.equal(deriveExpiryCondition(batch, TODAY).level, "stable");
  assert.equal(isExpiredOrUndated(batch, TODAY), false);
});

test("missing or malformed expiry is unknown, never stable", () => {
  for (const expiryDate of [
    undefined, null, "", "   ", "not-a-date", "2026-2-3", "03/09/2026",
    "2026-02-31", // Date would roll this to March 3rd; the round-trip guard refuses it
    "2026-13-01",
    12345,
  ]) {
    const { level, daysRemaining } = deriveExpiryCondition({ status: "Stable", expiryDate }, TODAY);
    assert.equal(level, "unknown", `${JSON.stringify(expiryDate)} must be unknown`);
    assert.equal(daysRemaining, null);
    // Unknown is refused for ordering, exactly as the server refuses it.
    assert.equal(isExpiredOrUndated({ expiryDate }, TODAY), true);
  }
});

// ------------------------------------------------------ boundaries in Manila

test("the expiry boundary is date-only Manila, and stock lasts all of its last day", () => {
  // Usable through the whole of the expiry date; expired the day after.
  assert.equal(deriveExpiryCondition({ expiryDate: TODAY }, TODAY).level, "critical");
  assert.equal(deriveExpiryCondition({ expiryDate: "2026-09-07" }, TODAY).level, "expired");
  assert.equal(daysUntilExpiry(TODAY, TODAY), 0);

  // Late-evening UTC is already tomorrow in Manila. A UTC cutoff would still
  // call it the 7th and keep a batch that expired yesterday on the shelf.
  const evening = Date.parse("2026-09-07T17:00:00.000Z");
  assert.equal(manilaToday(evening), "2026-09-08");
  assert.equal(
    deriveExpiryCondition({ expiryDate: "2026-09-07" }, manilaToday(evening)).level,
    "expired"
  );
  // One minute earlier it is still the 7th in Manila, and the batch is usable.
  const beforeMidnight = Date.parse("2026-09-07T15:59:00.000Z");
  assert.equal(manilaToday(beforeMidnight), "2026-09-07");
  assert.equal(
    deriveExpiryCondition({ expiryDate: "2026-09-07" }, manilaToday(beforeMidnight)).level,
    "critical"
  );
});

test("the 30 and 90 day thresholds are the existing ones, inclusive", () => {
  assert.equal(CRITICAL_WITHIN_DAYS, 30);
  assert.equal(WARNING_WITHIN_DAYS, 90);

  const at = (days) => {
    const d = new Date(Date.parse(`${TODAY}T00:00:00.000Z`) + days * 86400000);
    return deriveExpiryCondition({ expiryDate: d.toISOString().slice(0, 10) }, TODAY).level;
  };
  assert.equal(at(-1), "expired");
  assert.equal(at(0), "critical");
  assert.equal(at(30), "critical", "30 days is still critical");
  assert.equal(at(31), "warning", "31 days crosses into warning");
  assert.equal(at(90), "warning", "90 days is still warning");
  assert.equal(at(91), "stable", "91 days is in date");
});

test("isoDateOnly matches the server's definition of a valid date", () => {
  assert.equal(isoDateOnly("2026-09-08"), "2026-09-08");
  assert.equal(isoDateOnly("  2026-09-08  "), "2026-09-08");
  assert.equal(isoDateOnly("2026-02-31"), null);
  assert.equal(isoDateOnly("2026-9-8"), null);
  assert.equal(isoDateOnly(null), null);
  // Same rule, same wording, as functions/src/policy.js.
  assert.match(read("functions/src/policy.js"), /if \(!\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(text\)\) return null;/);
});

test("the reference time is always explicit — no helper reads the clock", () => {
  // Comment-stripped: the module's own docs tell callers to pass
  // `manilaToday(Date.now())`, which is the pattern, not a violation of it.
  const code = EXPIRY.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
  assert.equal(/Date\.now\(\)/.test(code), false, "the module must never read the clock");
  assert.equal(/new Date\(\)/.test(code), false);
  assert.match(EXPIRY, /export function manilaToday\(nowMs\)/);
  assert.equal(manilaToday(undefined), null, "a missing reference time is not today");
  assert.equal(manilaToday(Number.NaN), null);
});

// ------------------------------------------- every consumer, one derivation

test("all three surfaces derive from the shared helper", () => {
  for (const [name, src] of [["Inventory", INV], ["Dashboard", DASH], ["SalesRepInventory", SRI]]) {
    assert.match(src, /from "\.\.\/\.\.\/services\/expiry"/, `${name} must use the shared helper`);
    assert.match(src, /deriveExpiryCondition\(/, `${name} must derive the condition`);
    // The clock is read once per snapshot, in the subscription callback.
    assert.match(src, /manilaToday\(Date\.now\(\)\)/, `${name} must resolve one date per snapshot`);
  }
});

test("no surface still reads the stored status for expiry condition", () => {
  for (const [name, src] of [["Inventory", INV], ["Dashboard", DASH], ["SalesRepInventory", SRI]]) {
    assert.equal(
      /raw\.status \|\| "Stable"/.test(src),
      false,
      `${name} must not default a missing status to Stable`
    );
    assert.equal(
      /\(b\.status \|\| ""\)\.toLowerCase\(\)/.test(src),
      false,
      `${name} must not read the stored status`
    );
  }
  // And no page invents its own date arithmetic any more.
  for (const [name, src] of [["Inventory", INV], ["SalesRepInventory", SRI]]) {
    assert.equal(
      /today\.setHours\(0, 0, 0, 0\)/.test(src),
      false,
      `${name} must not measure from local midnight`
    );
    assert.equal(
      /Date\.now\(\) \+ 8 \* 60 \* 60 \* 1000/.test(src),
      false,
      `${name} must not re-implement the Manila shift`
    );
  }
});

test("no status is written back, and no migration was added", () => {
  for (const [name, src] of [["Inventory", INV], ["Dashboard", DASH], ["SalesRepInventory", SRI], ["expiry", EXPIRY]]) {
    for (const w of ["updateDoc", "setDoc", "addDoc", "writeBatch", "deleteDoc", "runTransaction"]) {
      assert.equal(src.includes(w), false, `${name} must not ${w}`);
    }
  }
  // The one writer of the field is untouched: Add Stock still stamps it at
  // creation. Nothing recomputes or backfills it.
  assert.match(read("src/pages/admin/AddStock.jsx"), /const status = getBatchStatus\(expiryDate\);/);
  assert.equal(/migrat/i.test(EXPIRY.replace(/\/\*[\s\S]*?\*\//g, "")), false);
});

// ------------------------------------------------------------ honest labels

test("no surface calls stock healthy or safe on expiry alone", () => {
  for (const [name, src] of [["Inventory", INV], ["Dashboard", DASH], ["SalesRepInventory", SRI]]) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
    for (const claim of ["Total Safe Stock", "Stock healthy", "No action required", "safeStock"]) {
      assert.equal(code.includes(claim), false, `${name}: "${claim}" is a verdict expiry cannot support`);
    }
  }
  // The warning KPI used to be captioned "Temperature exceptions" — this page
  // performs no temperature check at all.
  assert.equal(/Temperature exceptions/.test(INV), false);
  // Quantity stays a separate concept from the expiry level.
  assert.match(SRI, /vials, by expiry date only/);
});

test("the derived levels are what the surfaces label and filter by", () => {
  assert.match(INV, /label="Expired"/);
  assert.match(INV, /label="Expiring within 30 days"/);
  // The bands are exclusive; tests/expiryRanges.test.js pins their edges.
  assert.match(INV, /label="Expiring in 31–90 days"/);
  assert.match(INV, /setStatusFilter\("expired"\)/);
  assert.match(INV, /setStatusFilter\("unknown"\)/);
  assert.match(DASH, /label: "Expiring or expired stock"/);
  // Every level a batch can take is reachable from the Admin filter chips.
  for (const level of ["expired", "critical", "warning", "stable", "unknown"]) {
    assert.match(INV, new RegExp(`setStatusFilter\\("${level}"\\)`), `${level} must be filterable`);
  }
});

// --------------------------------------- the server's own guarantee, proven

test("the server independently refuses expired and undated stock", async () => {
  // Proof that the client change is a display correction, not a safety one:
  // order creation already rejects these regardless of the stored status, so no
  // Functions change was needed and none was made.
  const P = await import("../functions/src/policy.js");
  const NOW_DATE = new Date(NOW);

  assert.equal(P.manilaDateString(NOW_DATE), TODAY);
  assert.equal(P.isExpired("2026-09-08", NOW_DATE), false, "usable through its expiry date");
  assert.equal(P.isExpired("2026-09-07", NOW_DATE), true);

  // A batch whose stored status still reads "Stable" is refused on the date.
  const base = {
    quantity: 10, reservedQuantity: 0, status: "Stable",
    sellingPriceCentavos: 50000, expiryDate: "2027-12-31",
  };
  const codeOf = (overrides) => {
    try {
      P.evaluateBatch({
        inventoryId: "inv1",
        data: { ...base, ...overrides },
        requested: 1,
        expectedUnitPriceCentavos: 50000,
        now: NOW_DATE,
      });
      return null;
    } catch (e) {
      return e.code;
    }
  };
  assert.equal(codeOf({}), null, "an in-date priced batch is orderable");
  assert.equal(codeOf({ expiryDate: "2020-01-01" }), "batch-expired");
  assert.equal(codeOf({ expiryDate: "2026-09-07" }), "batch-expired", "yesterday in Manila");
  assert.equal(codeOf({ expiryDate: "not-a-date" }), "batch-expired");
  assert.equal(codeOf({ expiryDate: undefined }), "batch-expired");
  assert.equal(codeOf({ expiryDate: "2026-02-31" }), "batch-expired", "impossible date refused");
});

test("both new levels have chip styling on every surface that shows them", () => {
  // A level with no rule renders as an unstyled chip, which is how an expired
  // batch would have looked like ordinary stock.
  // Plain substring checks — a selector is a literal, and building a regex from
  // one only invites escaping mistakes.
  const adminCss = read("src/pages/admin/Inventory.css");
  const srCss = read("src/pages/salesRep/SalesRep.css");
  for (const level of ["expired", "unknown"]) {
    assert.ok(adminCss.includes(`.v2-stock-status.${level}`), `table chip: ${level}`);
    assert.ok(adminCss.includes(`.v2-modal-badge.${level}`), `drawer badge: ${level}`);
    assert.ok(adminCss.includes(`.v2-cold-list small.${level}`), `expiring list: ${level}`);
    assert.ok(srCss.includes(`.status-chip.${level}`), `sales rep chip: ${level}`);
  }
});
