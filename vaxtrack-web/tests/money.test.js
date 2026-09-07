import test from "node:test";
import assert from "node:assert/strict";
import {
  centavosToInputValue,
  centavosToPesos,
  formatCentavos,
  parsePesosToCentavos,
  readPriceCentavos,
} from "../src/services/money.js";

// PHP money, as integer centavos.
//
// This module is the only place in the web app that turns typed pesos into a
// stored figure, so it is the only place that can introduce a rounding error
// into a real invoice. Everything below is about making sure it does not.

test("parsing typed pesos into centavos", async (t) => {
  await t.test("whole pesos, one decimal and two decimals all work", () => {
    assert.deepEqual(parsePesosToCentavos("500"), { ok: true, value: 50000 });
    assert.deepEqual(parsePesosToCentavos("500.5"), { ok: true, value: 50050 });
    assert.deepEqual(parsePesosToCentavos("500.50"), { ok: true, value: 50050 });
    assert.deepEqual(parsePesosToCentavos("0.01"), { ok: true, value: 1 });
  });

  await t.test("the float route would get 19.99 wrong — text parsing does not", () => {
    // Math.round(19.99 * 100) happens to survive, but 19.99*100 is
    // 1998.9999999999998 and the naive floor() of it is 1998. Parsing the
    // digits as text cannot land on the wrong centavo at all.
    assert.equal(Math.floor(19.99 * 100), 1998, "the trap this avoids");
    assert.deepEqual(parsePesosToCentavos("19.99"), { ok: true, value: 1999 });
    assert.deepEqual(parsePesosToCentavos("1.10"), { ok: true, value: 110 });
    assert.deepEqual(parsePesosToCentavos("0.29"), { ok: true, value: 29 });
    assert.deepEqual(parsePesosToCentavos("8.20"), { ok: true, value: 820 });
  });

  await t.test("surrounding space and thousands separators are tolerated", () => {
    assert.deepEqual(parsePesosToCentavos(" 1,250.00 "), { ok: true, value: 125000 });
    assert.deepEqual(parsePesosToCentavos("1,000,000"), { ok: true, value: 100000000 });
  });

  await t.test("an empty field is 'empty', not 'invalid' — the UI says different things", () => {
    assert.deepEqual(parsePesosToCentavos(""), { ok: false, reason: "empty" });
    assert.deepEqual(parsePesosToCentavos("   "), { ok: false, reason: "empty" });
  });

  await t.test("zero and negatives are refused: neither is a selling price", () => {
    assert.deepEqual(parsePesosToCentavos("0"), { ok: false, reason: "not-positive" });
    assert.deepEqual(parsePesosToCentavos("0.00"), { ok: false, reason: "not-positive" });
    assert.deepEqual(parsePesosToCentavos("-5"), { ok: false, reason: "invalid" });
  });

  await t.test("anything that is not a plain decimal amount is refused", () => {
    // Each of these would otherwise become a number via Number(): "5." is 5,
    // ".5" is 0.5, "1e3" is 1000, "Infinity" is Infinity.
    for (const bad of ["abc", "5.", ".5", "1e3", "Infinity", "NaN", "5.005", "₱500", "5 0 0", "--5"]) {
      assert.equal(parsePesosToCentavos(bad).ok, false, bad);
    }
  });

  await t.test("a non-string, non-integer number is refused rather than rounded", () => {
    assert.deepEqual(parsePesosToCentavos(500), { ok: true, value: 50000 }, "whole pesos are fine");
    assert.equal(parsePesosToCentavos(19.99).ok, false, "a float has already lost precision");
    for (const bad of [null, undefined, {}, [], true, NaN, Infinity, -5]) {
      assert.equal(parsePesosToCentavos(bad).ok, false, String(bad));
    }
  });

  await t.test("there is NO business ceiling — a large price parses fine", () => {
    // The removed ₱100,000 cap was invented; nobody approved it, and the first
    // legitimately expensive product would have been refused for no reason.
    assert.deepEqual(parsePesosToCentavos("100000.01"), { ok: true, value: 10000001 });
    assert.deepEqual(parsePesosToCentavos("1000000000"), { ok: true, value: 100000000000 });
  });

  await t.test("a figure past exact integer range is refused, not rounded", () => {
    // The only limit is arithmetic. x100 pushes this past MAX_SAFE_INTEGER.
    assert.deepEqual(parsePesosToCentavos(String(Number.MAX_SAFE_INTEGER)), {
      ok: false,
      reason: "not-safe-integer",
    });
  });
});

test("reading a stored price", async (t) => {
  await t.test("any positive, exactly-representable integer is a price", () => {
    assert.equal(readPriceCentavos(125000), 125000);
    assert.equal(readPriceCentavos(1), 1);
    assert.equal(readPriceCentavos(100000000000), 100000000000, "no business ceiling");
    assert.equal(readPriceCentavos(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  });

  await t.test("absent, zero, negative and malformed all read as null", () => {
    // null means "there is no price here", which the catalog turns into a
    // disabled card. It must never collapse to 0, which is a price.
    for (const bad of [
      undefined, null, 0, -1, 1250.5, "125000", NaN, Infinity, {}, [], true,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.equal(readPriceCentavos(bad), null, JSON.stringify(bad) ?? String(bad));
    }
  });

  await t.test("a numeric STRING is not coerced — same discipline as quantity", () => {
    // Mirrors readSellingPriceCentavos in functions/src/policy.js. Coercing it
    // would hide a stored-type problem behind arithmetic that appears to work.
    assert.equal(readPriceCentavos("125000"), null);
  });
});

test("displaying money", async (t) => {
  await t.test("centavos render as pesos with two decimals", () => {
    // Normalised: Intl may use a non-breaking space after the symbol.
    const shown = formatCentavos(125000).replace(/[\u00A0\u202F]/g, " ");
    assert.match(shown, /1,250\.00/);
    assert.ok(shown.includes("₱") || shown.includes("PHP"), "carries the currency");
  });

  await t.test("an absent price shows a dash, never ₱0.00", () => {
    // The distinction the whole feature rests on: no price is not a free one.
    for (const none of [undefined, null, 0, "125000", -1]) {
      assert.equal(formatCentavos(none), "—", String(none));
    }
  });

  await t.test("centavos convert to pesos exactly", () => {
    assert.equal(centavosToPesos(125000), 1250);
    assert.equal(centavosToPesos(1999), 19.99);
    assert.equal(centavosToPesos(1), 0.01);
    assert.equal(centavosToPesos(0), 0);
  });

  await t.test("the edit prefill round-trips through the parser", () => {
    // What the Admin price dialog puts in the box must parse back to the same
    // stored figure, or editing a price would silently change it.
    for (const centavos of [1, 29, 820, 1999, 125000, 100000000000]) {
      const shown = centavosToInputValue(centavos);
      assert.deepEqual(
        parsePesosToCentavos(shown),
        { ok: true, value: centavos },
        `${centavos} -> "${shown}" -> ${centavos}`
      );
    }
    assert.equal(centavosToInputValue(null), "", "an unpriced batch opens with an empty box");
    assert.equal(centavosToInputValue(0), "");
  });
});
