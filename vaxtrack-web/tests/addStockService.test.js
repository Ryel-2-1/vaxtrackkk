import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Add Stock — EXECUTED success path.
//
// Why this file exists alongside addStock.test.js: that suite asserts on the
// SHAPE OF THE SOURCE (regex over the JSX/service text). That is useful for
// pinning things like "Storage Temperature is not mentioned anywhere", but it
// cannot prove what the service actually hands Firestore at runtime. Staging
// has zero registered vaccines, so the success path cannot be exercised in the
// browser either, and writing one there is forbidden.
//
// So the service is executed here with stand-ins for `firebase/firestore` and
// `../firebase`, and the exact object passed to `addDoc` is captured. No
// network, no emulator, no Firestore write, and no new dependency — the real
// source is read from disk and only its two import specifiers are rewritten,
// so the logic under test is the shipped logic, and the rewrite is asserted.
//
// WHAT THIS PROVES BY EXECUTION:
//   - the vaccine document id travels through as `vaccineId`
//   - `getVaccines` makes the document id authoritative over a stored `id`
//   - the selected vaccine's metadata is preserved
//   - batch id, both dates and the quantity arrive unaltered
//   - NO storage-temperature key is written, not even null/""/0
//   - the collection written to is `inventory`
//
// WHAT IT DOES NOT PROVE (no DOM renderer in this repo; adding one would be a
// dependency change): the component's double-submit ref guard and its
// navigate-only-after-success ordering. Those remain source-shape assertions
// in addStock.test.js — see the milestone report.

const here = dirname(fileURLToPath(import.meta.url));
const servicePath = join(here, "..", "src", "services", "vaccineService.js");

// The REAL service source is executed. Only its two import specifiers are
// rewritten to point at local stand-ins, because bare Node cannot resolve
// either one: `firebase/firestore` would reach the network-facing SDK, and
// `"../firebase"` is extensionless (Vite resolves that, Node does not) and
// would initialise a real Firebase app from Vite-only `import.meta.env` vars.
// Everything between the imports and the assertions is the shipped code.
const state = { addDoc: [], updateDoc: [], doc: [], collection: [], getDocs: 0, currentUser: { uid: "admin1" }, snapshot: { docs: [], empty: true } };
globalThis.__vaxtrackCalls = state;

const tmp = mkdtempSync(join(tmpdir(), "vaxtrack-addstock-"));

writeFileSync(
  join(tmp, "firestore.mjs"),
  `const s = globalThis.__vaxtrackCalls;
export const addDoc = (ref, data) => { s.addDoc.push({ ref, data }); return Promise.resolve({ id: "generated-doc-id" }); };
export const collection = (_db, name) => { s.collection.push(name); return { __collection: name }; };
export const getDocs = () => { s.getDocs += 1; return Promise.resolve(s.snapshot); };
export const query = (ref) => ref;
export const where = (...a) => ({ where: a });
export const orderBy = (...a) => ({ orderBy: a });
export const serverTimestamp = () => "__SERVER_TIMESTAMP__";
export const doc = (_db, name, id) => { s.doc.push({ name, id }); return { __doc: name + "/" + id }; };
export const updateDoc = (ref, data) => { s.updateDoc.push({ ref, data }); return Promise.resolve(); };
`
);
// `auth` is stubbed because updateStockPrice now reads the signed-in uid
// itself rather than accepting one as a parameter — which is what stops one
// admin recording a re-price as another's.
writeFileSync(
  join(tmp, "firebase.mjs"),
  `export const db = { __mockDb: true };
export const auth = { get currentUser() { return globalThis.__vaxtrackCalls.currentUser; } };
`
);

const original = readFileSync(servicePath, "utf8");
const rewritten = original
  .replace('"firebase/firestore"', JSON.stringify(pathToFileURL(join(tmp, "firestore.mjs")).href))
  .replace('"../firebase"', JSON.stringify(pathToFileURL(join(tmp, "firebase.mjs")).href));

// If the service's imports are ever renamed, fail loudly rather than silently
// testing an unrewritten (or unexecutable) module.
assert.ok(
  rewritten !== original && !rewritten.includes('"firebase/firestore"') && !rewritten.includes('"../firebase"'),
  "both service imports must have been redirected to the stand-ins"
);

const serviceFile = join(tmp, "vaccineService.mjs");
writeFileSync(serviceFile, rewritten);
const service = await import(pathToFileURL(serviceFile).href);

const opts = {};

/** Reset the capture state before each execution. */
function loadService() {
  state.addDoc = [];
  state.updateDoc = [];
  state.doc = [];
  state.collection = [];
  state.getDocs = 0;
  state.currentUser = { uid: "admin1" };
  state.snapshot = { docs: [], empty: true };
  return {
    mod: service,
    calls: state,
    setSnapshot: (s) => { state.snapshot = s; },
  };
}

const SELECTED_VACCINE = {
  id: "AbC123RealDocId",
  vaccineName: "Comirnaty BNT162b2",
  vaccineType: "mRNA",
  manufacturer: "Pfizer-BioNTech",
  internalSku: "VXT-123-ABCDE",
};

/** The payload AddStock.jsx builds from a selected vaccine. */
const payloadFor = (vaccine) => ({
  vaccineId: vaccine.id,
  vaccineName: vaccine.vaccineName,
  vaccineType: vaccine.vaccineType,
  manufacturer: vaccine.manufacturer,
  internalSku: vaccine.internalSku,
  batchId: "BATCH-QA-0001",
  arrivalDate: "2026-09-01",
  expiryDate: "2027-03-01",
  quantity: 1200,
  // ₱1,250.00 per vial, VAT-exclusive. Required from the batch's first moment:
  // the service refuses a write without it.
  sellingPriceCentavos: 125000,
  status: "stable",
});

test("the batch is written to `inventory` with the vaccine document id as vaccineId", opts, async () => {
  const { mod, calls } = await loadService();
  await mod.addStockBatch(payloadFor(SELECTED_VACCINE));

  assert.equal(calls.addDoc.length, 1, "exactly one document is written");
  assert.ok(calls.collection.includes("inventory"), "written to the inventory collection");

  const written = calls.addDoc[0].data;
  assert.equal(written.vaccineId, "AbC123RealDocId", "the document id, not the SKU or name");
  assert.notEqual(written.vaccineId, SELECTED_VACCINE.internalSku);
  assert.notEqual(written.vaccineId, SELECTED_VACCINE.vaccineName);
});

test("the selected vaccine's metadata is preserved on the batch", opts, async () => {
  const { mod, calls } = await loadService();
  await mod.addStockBatch(payloadFor(SELECTED_VACCINE));
  const w = calls.addDoc[0].data;

  assert.equal(w.vaccineName, "Comirnaty BNT162b2");
  assert.equal(w.vaccineType, "mRNA");
  assert.equal(w.manufacturer, "Pfizer-BioNTech");
  assert.equal(w.internalSku, "VXT-123-ABCDE");
});

test("batch id, both dates and the quantity arrive unaltered", opts, async () => {
  const { mod, calls } = await loadService();
  await mod.addStockBatch(payloadFor(SELECTED_VACCINE));
  const w = calls.addDoc[0].data;

  assert.equal(w.batchId, "BATCH-QA-0001");
  assert.equal(w.arrivalDate, "2026-09-01");
  assert.equal(w.expiryDate, "2027-03-01");
  assert.equal(w.quantity, 1200);
  assert.equal(typeof w.quantity, "number", "quantity must stay numeric");
  assert.equal(w.status, "stable");
  assert.equal(w.createdAt, "__SERVER_TIMESTAMP__", "createdAt is server-stamped");
});

test("NO storage temperature is written — not a value, not a placeholder", opts, async () => {
  const { mod, calls } = await loadService();
  // Even if a caller still tried to pass one, the service must not forward it.
  await mod.addStockBatch({ ...payloadFor(SELECTED_VACCINE), storageTemp: "2-8°C" });
  const w = calls.addDoc[0].data;

  assert.ok(!("storageTemp" in w), "storageTemp must be absent from the document");
  assert.ok(!("storageTempDisplay" in w), "storageTempDisplay must be absent");
  // A stored null/""/0 would read as a real cold-chain figure downstream.
  for (const key of Object.keys(w)) {
    assert.ok(!/temp/i.test(key), `no temperature-ish key may be written (saw ${key})`);
  }
});

test("an absent internalSku degrades to an empty string rather than undefined", opts, async () => {
  // addDoc rejects undefined, so this guard is what keeps the write alive for a
  // vaccine registered without a SKU.
  const { mod, calls } = await loadService();
  const p = payloadFor(SELECTED_VACCINE);
  delete p.internalSku;
  await mod.addStockBatch(p);

  assert.equal(calls.addDoc[0].data.internalSku, "");
  for (const [k, v] of Object.entries(calls.addDoc[0].data)) {
    assert.notEqual(v, undefined, `${k} must never be undefined — addDoc rejects it`);
  }
});

test("getVaccines makes the Firestore document id authoritative over a stored `id`", opts, async () => {
  // This is the value that becomes `vaccineId` on every batch, so a stored
  // field named `id` must never shadow the real document id.
  const { mod, setSnapshot } = await loadService();
  setSnapshot({
    empty: false,
    docs: [
      { id: "RealDocId", data: () => ({ id: "STALE-LEGACY-ID", vaccineName: "Comirnaty" }) },
    ],
  });

  const vaccines = await mod.getVaccines();
  assert.equal(vaccines.length, 1);
  assert.equal(vaccines[0].id, "RealDocId", "the document id wins over the stored field");
  assert.equal(vaccines[0].vaccineName, "Comirnaty", "other fields still come through");
});

test("batchIdExists reports duplicates from the query result, not from a guess", opts, async () => {
  const { mod, setSnapshot } = await loadService();

  setSnapshot({ empty: false, docs: [{ id: "x", data: () => ({}) }] });
  assert.equal(await mod.batchIdExists("BATCH-QA-0001"), true, "an existing batch is a duplicate");

  setSnapshot({ empty: true, docs: [] });
  assert.equal(await mod.batchIdExists("BATCH-QA-0002"), false, "an unused batch id is free");
});

// ---------------------------------------------------------------- pricing
//
// The service is the last place a bad price can be stopped before it reaches
// Firestore. The rules refuse one too, and the callable refuses to sell it —
// but a price that got stored is a price something will eventually read.

test("a batch is written with its VAT-exclusive selling price and currency", opts, async () => {
  const { mod, calls } = await loadService();
  await mod.addStockBatch(payloadFor(SELECTED_VACCINE));
  const w = calls.addDoc[0].data;

  assert.equal(w.sellingPriceCentavos, 125000, "integer centavos, exactly as given");
  assert.equal(w.priceCurrency, "PHP");
  assert.equal(
    w.priceIsVatInclusive,
    false,
    "recorded, not implied — the invoice adds 12% on top of this figure"
  );
});

test("a batch cannot be created without a usable price", opts, async () => {
  const { mod, calls } = await loadService();

  for (const bad of [undefined, null, 0, -1, 1250.5, "125000", NaN, Infinity]) {
    await assert.rejects(
      () => mod.addStockBatch({ ...payloadFor(SELECTED_VACCINE), sellingPriceCentavos: bad }),
      /selling price/i,
      `refused: ${String(bad)}`
    );
  }
  assert.equal(calls.addDoc.length, 0, "not one of them reached Firestore");
});

test("updateStockPrice re-prices one batch and records who and when", opts, async () => {
  const { mod, calls } = await loadService();
  await mod.updateStockPrice({
    inventoryId: "batchDocId",
    sellingPriceCentavos: 140000,
  });

  assert.equal(calls.updateDoc.length, 1, "exactly one document is updated");
  assert.deepEqual(calls.doc[0], { name: "inventory", id: "batchDocId" });

  const w = calls.updateDoc[0].data;
  assert.equal(w.sellingPriceCentavos, 140000);
  assert.equal(w.priceCurrency, "PHP");
  assert.equal(w.priceIsVatInclusive, false);
  assert.equal(w.priceSetAt, "__SERVER_TIMESTAMP__");
  assert.equal(w.priceSetByUid, "admin1");
});

test("re-pricing can never become a way to move stock", opts, async () => {
  // The rules refuse a client write naming either counter, but the service must
  // not be the thing that tries: a re-price is a price change and nothing else.
  const { mod, calls } = await loadService();
  await mod.updateStockPrice({ inventoryId: "batchDocId", sellingPriceCentavos: 1 });

  const keys = Object.keys(calls.updateDoc[0].data);
  assert.ok(!keys.includes("quantity"), "no on-hand figure is touched");
  assert.ok(!keys.includes("reservedQuantity"), "no reserved figure is touched");
  assert.deepEqual(keys.sort(), [
    "priceCurrency", "priceIsVatInclusive", "priceSetAt", "priceSetByUid",
    "sellingPriceCentavos",
  ]);
});

test("updateStockPrice refuses a bad amount or a missing batch", opts, async () => {
  const { mod, calls } = await loadService();

  for (const bad of [0, -1, 1250.5, "140000", null, undefined, NaN]) {
    await assert.rejects(
      () => mod.updateStockPrice({ inventoryId: "batchDocId", sellingPriceCentavos: bad }),
      /whole number of centavos/i,
      `refused: ${String(bad)}`
    );
  }
  for (const id of ["", "   ", null, undefined, 5]) {
    await assert.rejects(
      () => mod.updateStockPrice({ inventoryId: id, sellingPriceCentavos: 140000 }),
      /batch is required/i
    );
  }
  assert.equal(calls.updateDoc.length, 0, "nothing was written");
});

test("the re-price audit uid comes from the session, not a parameter", opts, async () => {
  // The signature no longer HAS a uid parameter, so a caller cannot record a
  // re-price as another admin. Passing one is inert.
  const { mod, calls } = await loadService();
  calls.currentUser = { uid: "the-real-caller" };
  await mod.updateStockPrice({
    inventoryId: "batchDocId",
    sellingPriceCentavos: 140000,
    adminUid: "someone-else",
  });

  const w = calls.updateDoc[0].data;
  assert.equal(w.priceSetByUid, "the-real-caller", "read from the signed-in session");
  assert.notEqual(w.priceSetByUid, "someone-else", "a supplied uid is ignored entirely");
  assert.equal(w.priceSetAt, "__SERVER_TIMESTAMP__", "server time, not a client clock");
});

test("a signed-out caller records no uid rather than a forged one", opts, async () => {
  // The rules refuse this write anyway (priceSetByUid must equal the caller);
  // the point is that the service never invents a value to fill the gap.
  const { mod, calls } = await loadService();
  calls.currentUser = null;
  await mod.updateStockPrice({ inventoryId: "batchDocId", sellingPriceCentavos: 140000 });
  assert.equal(calls.updateDoc[0].data.priceSetByUid, null);
});
