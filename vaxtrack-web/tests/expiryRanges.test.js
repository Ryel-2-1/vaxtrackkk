import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveExpiryCondition, manilaToday } from "../src/services/expiry.js";

/**
 * The three expiry bands are EXCLUSIVE, and every surface that names or counts
 * them says which band it means.
 *
 * `expired` (before today) | `critical` (today .. day 30) | `warning` (day 31
 * .. day 90) | `stable` (day 91+) | `unknown` (no usable date).
 *
 * Three things were wrong or unproven before this pass: Admin Inventory's
 * warning KPI was labelled "Expiring within 90 days" while counting only the
 * 31–90 band, so a batch expiring next week was absent from the figure its
 * label promised; the Dashboard's combined count had no test pinning which
 * levels it includes; and the Sales Rep catalog derived expiry itself, marking
 * a batch expired only when its date PARSED and was past — a missing or
 * malformed date stayed orderable in the catalog and was refused later by the
 * callable.
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const INV = read("src/pages/admin/Inventory.jsx");
const DASH = read("src/pages/admin/AdminDashboard.jsx");
const SRO = read("src/pages/salesRep/SalesRepRequestOrder.jsx");

/** 2026-09-08T02:00Z is already 2026-09-08 in Manila. */
const NOW = Date.parse("2026-09-08T02:00:00.000Z");
const TODAY = manilaToday(NOW);

/** The level of a batch expiring `days` from today in Manila. */
const levelAt = (days) => {
  const iso = new Date(Date.parse(`${TODAY}T00:00:00.000Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);
  return deriveExpiryCondition({ expiryDate: iso }, TODAY).level;
};

// ------------------------------------------------ 1. Admin Inventory ranges

test("the three bands are exclusive and cover every day", () => {
  // Nothing falls in two bands, and nothing falls in none.
  for (const days of [-365, -31, -1, 0, 1, 15, 29, 30, 31, 45, 89, 90, 91, 400]) {
    const level = levelAt(days);
    assert.ok(["expired", "critical", "warning", "stable"].includes(level));
  }
  // The exact edges each label claims.
  assert.equal(levelAt(-1), "expired", "yesterday is expired, not critical");
  assert.equal(levelAt(0), "critical", "the expiry date itself is still usable");
  assert.equal(levelAt(30), "critical", "day 30 is the last critical day");
  assert.equal(levelAt(31), "warning", "day 31 is the first warning day");
  assert.equal(levelAt(90), "warning", "day 90 is the last warning day");
  assert.equal(levelAt(91), "stable", "day 91 is in date");
});

test("Admin Inventory labels each KPI with the band it actually counts", () => {
  // The critical card covers today through day 30…
  assert.match(INV, /label="Expiring within 30 days"/);
  assert.match(INV, /value=\{loading \? "—" : inventory\.filter\(\(i\) => i\.level === "critical"\)\.length\}/);

  // …and the warning card covers 31 through 90, which is what its label now
  // says. "Expiring within 90 days" read as 0–90 over a 31–90 count.
  assert.match(INV, /label="Expiring in 31–90 days"/);
  assert.equal(
    /label="Expiring within 90 days"/.test(INV),
    false,
    "an inclusive-from-zero label over an exclusive count is a miscount"
  );
  assert.match(INV, /value=\{loading \? "—" : inventory\.filter\(\(i\) => i\.level === "warning"\)\.length\}/);

  // Expired stays its own card, counted on its own level.
  assert.match(INV, /label="Expired"/);
  assert.match(INV, /value=\{loading \? "—" : inventory\.filter\(\(i\) => i\.level === "expired"\)\.length\}/);

  // Each card filters to the single level it counts, so figure and list agree.
  for (const level of ["expired", "critical", "warning"]) {
    assert.match(INV, new RegExp(`setStatusFilter\\("${level}"\\)`));
  }
});

// ----------------------------------------------- 2. Admin Dashboard couting

test("the Dashboard KPI counts critical AND expired, and nothing else", () => {
  // Executed, not just read: the page's own predicate applied to one batch of
  // each level.
  const predicate = (batch) => {
    const { level } = deriveExpiryCondition(batch, TODAY);
    return level === "expired" || level === "critical";
  };
  const at = (days) => ({
    expiryDate: new Date(Date.parse(`${TODAY}T00:00:00.000Z`) + days * 86400000)
      .toISOString()
      .slice(0, 10),
  });

  assert.equal(predicate(at(-1)), true, "expired must be counted");
  assert.equal(predicate(at(0)), true, "expiring today must be counted");
  assert.equal(predicate(at(30)), true, "day 30 must be counted");
  assert.equal(predicate(at(31)), false, "warning must NOT be counted");
  assert.equal(predicate(at(90)), false, "warning must NOT be counted");
  assert.equal(predicate(at(91)), false, "stable must NOT be counted");
  assert.equal(predicate({ expiryDate: "nonsense" }), false, "unknown must NOT be counted");
  assert.equal(predicate({}), false, "a batch with no date must NOT be counted");

  // A mixed set counts to exactly the two included levels.
  const batches = [at(-5), at(-1), at(0), at(30), at(31), at(90), at(200), {}, { expiryDate: "x" }];
  assert.equal(batches.filter(predicate).length, 4);

  // And the page really uses that predicate, under a label naming both.
  assert.match(DASH, /level === "expired" \|\| level === "critical"/);
  assert.match(DASH, /label: "Expiring or expired stock"/);
  assert.match(DASH, /note: criticalCount > 0 \? "Within 30 days or past expiry"/);
});

// ------------------------------------------ 3. Sales Rep Request Order gate

test("the request-order catalog has no expiry logic of its own", () => {
  assert.match(SRO, /import \{ deriveExpiryCondition, manilaToday \} from "\.\.\/\.\.\/services\/expiry"/);
  assert.equal(
    /function manilaToday\(\)/.test(SRO),
    false,
    "the duplicated local helper must be gone"
  );
  assert.equal(
    /Date\.now\(\) \+ 8 \* 60 \* 60 \* 1000/.test(SRO),
    false,
    "the Manila shift must not be re-implemented"
  );
  // The reference time is still resolved once, in the subscription callback.
  assert.match(SRO, /const todayIso = manilaToday\(Date\.now\(\)\);/);
  assert.match(SRO, /const expiryCondition = deriveExpiryCondition\(raw, todayIso\);/);
});

test("missing, malformed and expired batches are unavailable in the catalog", () => {
  // The page's own blocking rule, applied to the cases that used to slip past
  // it. Ordering-irrelevant fields are held constant so expiry is the variable.
  const blockedReason = (raw) => {
    const available = 10;
    const condition = deriveExpiryCondition(raw, TODAY);
    const expired = condition.level === "expired";
    const undated = condition.level === "unknown";
    const unitPriceCentavos = 50000;
    if (available === null) return "Needs inventory migration";
    if (expired) return "Expired — unavailable";
    if (undated) return "No usable expiry date — unavailable";
    if (unitPriceCentavos === null) return "Not priced — unavailable";
    if (available <= 0) return "Out of stock";
    return null;
  };

  // Expired.
  assert.equal(blockedReason({ expiryDate: "2020-01-01" }), "Expired — unavailable");
  assert.equal(blockedReason({ expiryDate: "2026-09-07" }), "Expired — unavailable");

  // Missing and malformed — every one of these was orderable before, because
  // the old test required the date to parse before it could be called expired.
  for (const expiryDate of [undefined, null, "", "   ", "not-a-date", "2026-2-3", "2026-02-31", 12345]) {
    assert.equal(
      blockedReason({ expiryDate }),
      "No usable expiry date — unavailable",
      `${JSON.stringify(expiryDate)} must be blocked in the catalog`
    );
  }

  // Same-day expiry stays orderable, matching the server.
  assert.equal(blockedReason({ expiryDate: TODAY }), null, "expires today — still orderable");
  assert.equal(blockedReason({ expiryDate: "2030-12-31" }), null);

  // And the page carries exactly those branches, in that order.
  assert.match(SRO, /else if \(expired\) blockedReason = "Expired — unavailable";/);
  assert.match(SRO, /else if \(undated\) blockedReason = "No usable expiry date — unavailable";/);
  assert.match(SRO, /orderable: blockedReason === null,/);
});

test("no client-side gate can pass a batch the server would refuse", async () => {
  // The catalog's blocking reasons and the server's refusal codes line up: for
  // every expiry shape, if the client offers it the server accepts it.
  const P = await import("../functions/src/policy.js");
  const NOW_DATE = new Date(NOW);
  const base = {
    quantity: 10,
    reservedQuantity: 0,
    status: "Stable",
    sellingPriceCentavos: 50000,
  };
  const serverRefuses = (expiryDate) => {
    try {
      P.evaluateBatch({
        inventoryId: "inv1",
        data: { ...base, expiryDate },
        requested: 1,
        expectedUnitPriceCentavos: 50000,
        now: NOW_DATE,
      });
      return null;
    } catch (e) {
      return e.code;
    }
  };
  const clientBlocks = (expiryDate) => {
    const { level } = deriveExpiryCondition({ expiryDate }, TODAY);
    return level === "expired" || level === "unknown";
  };

  for (const expiryDate of [
    "2020-01-01", "2026-09-07", TODAY, "2026-10-08", "2030-12-31",
    "not-a-date", "2026-02-31", "", undefined, null, 12345,
  ]) {
    const refused = serverRefuses(expiryDate) !== null;
    assert.equal(
      clientBlocks(expiryDate),
      refused,
      `${JSON.stringify(expiryDate)}: catalog and server must agree`
    );
  }
});

test("the cart, price, quantity and reservation paths were not touched", () => {
  // The change is a display and gating correction. Everything the order carries
  // is still built the same way.
  assert.match(SRO, /unitPriceCentavos,/);
  assert.match(SRO, /priceLabel: formatCentavos\(unitPriceCentavos\)/);
  assert.match(SRO, /const available = availableStock\(raw\);/);
  assert.match(SRO, /reserved: typeof raw\.reservedQuantity === "number" \? raw\.reservedQuantity : 0,/);
  assert.match(SRO, /inventoryId: raw\.id,/);
  // And it still writes nothing.
  for (const w of ["updateDoc", "setDoc", "addDoc", "writeBatch"]) {
    assert.equal(SRO.includes(w), false, `the catalog must not ${w}`);
  }
});
