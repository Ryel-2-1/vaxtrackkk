import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Admin → Register New Vaccine.
//
// Covers the two review gaps closed on this branch — the Add Type field's
// accessible name, and the `react-hooks/set-state-in-effect` correction on the
// initial load — plus guards that neither touched initialization, validation,
// submission, the Add Type disclosure contract, or Add Stock.
//
// Source-shape assertions: this repo has no jsdom/RTL and adding one would be a
// dependency change, matching the other suites here. The accessible name and
// the label association were additionally confirmed in the browser against the
// rendered accessibility tree — see the commit message.

const here = dirname(fileURLToPath(import.meta.url));
const src = (...p) => readFileSync(join(here, "..", "src", ...p), "utf8");

const addVaccine = src("pages", "admin", "AddVaccine.jsx");
const addStock = src("pages", "admin", "AddStock.jsx");
const formsCss = src("pages", "admin", "AdminForms.css");
const vaccineServiceSrc = src("services", "vaccineService.js");

// ---------------------------------------------------------------------------
// Add Type field: a real accessible name, not a placeholder
// ---------------------------------------------------------------------------

test("the Add Type input has an associated label, not just a placeholder", () => {
  // A placeholder is not an accessible name: it vanishes on input and is not
  // reliably announced.
  assert.match(
    addVaccine,
    /<label htmlFor="new-vaccine-type" className="admin-sr-only">\s*New vaccine type\s*<\/label>/,
    "a label element must name the field"
  );
  assert.match(addVaccine, /id="new-vaccine-type"/, "and the input must carry that id");

  // The label must not be the placeholder text repeated.
  assert.ok(
    !/htmlFor="new-vaccine-type"[\s\S]{0,80}mRNA, Inactivated/.test(addVaccine),
    "the accessible name must be distinct from the placeholder"
  );
});

test("the placeholder and helper text are preserved", () => {
  assert.match(addVaccine, /placeholder="e\.g\. mRNA, Inactivated, Viral Vector"/);
  assert.match(addVaccine, /Create a reusable option for the Vaccine Type list\./);
});

test("the field is described by the panel's helper text", () => {
  assert.match(addVaccine, /aria-describedby="add-vaccine-type-help"/);
  assert.match(
    addVaccine,
    /<p id="add-vaccine-type-help">/,
    "aria-describedby must resolve to a real element"
  );
});

test("the label is hidden visually but remains in the accessibility tree", () => {
  // display:none / visibility:hidden would remove it from the tree entirely.
  const rule = formsCss.slice(formsCss.indexOf(".inventory-main .admin-sr-only"));
  const block = rule.slice(0, rule.indexOf("}"));
  assert.match(block, /position: absolute/);
  assert.match(block, /clip: rect\(0, 0, 0, 0\)/);
  assert.ok(!/display:\s*none/.test(block), "must not be display:none");
  assert.ok(!/visibility:\s*hidden/.test(block), "must not be visibility:hidden");
});

// ---------------------------------------------------------------------------
// The Add Type disclosure contract is unchanged
// ---------------------------------------------------------------------------

test("aria-expanded, aria-controls and the panel id still line up", () => {
  assert.match(addVaccine, /aria-expanded=\{showAddType\}/);
  assert.match(addVaccine, /aria-controls="add-vaccine-type-panel"/);
  assert.match(addVaccine, /className="add-type-box" id="add-vaccine-type-panel"/);
  // open and close paths
  assert.match(addVaccine, /onClick=\{\(\) => setShowAddType\(true\)\}/);
  assert.match(addVaccine, /onClick=\{\(\) => setShowAddType\(false\)\}/);
  assert.match(addVaccine, /aria-label="Cancel new vaccine type"/);
});

test("adding a type selects it; the live list supplies it without a re-read", () => {
  assert.match(
    addVaccine,
    /await addVaccineType\(typeName\);[\s\S]*?setVaccineType\(typeName\);/,
    "the new type is selected only after its write succeeded"
  );
  assert.equal(/loadVaccineTypes|getVaccineTypes/.test(addVaccine), false, "no refetch after the write");
  assert.match(addVaccine, /This vaccine type already exists\./);
  assert.match(addVaccine, /Vaccine type name must be at least 3 characters\./);
});

// ---------------------------------------------------------------------------
// The lint correction changed how the initial load is written, nothing else
// ---------------------------------------------------------------------------

test("vaccine types are a live listener that fills the same state", () => {
  // The effect returns the listener's unsubscribe, so an unmount closes it.
  assert.match(addVaccine, /useEffect\(\s*\(\) =>\s*subscribeVaccineTypes\(/);
  assert.match(addVaccine, /\(types\) => setVaccineTypes\(types\)/);
  // A failed listener says so (mapped, never raw Firebase text).
  assert.match(addVaccine, /setMessage\(liveErrorMessage\(error, "vaccine types"\)\)/);
  assert.match(vaccineServiceSrc, /export function subscribeVaccineTypes\(callback, onError\)/);
  assert.match(vaccineServiceSrc, /orderBy\("name", "asc"\)\);\s*return onSnapshot\(/);
});

test("no blanket lint suppression was used", () => {
  assert.ok(!addVaccine.includes("eslint-disable"), "the fix must be real, not silenced");
});

test("the one-time type read survives in the service for its other callers", () => {
  assert.match(vaccineServiceSrc, /export async function getVaccineTypes\(\)/);
});

// ---------------------------------------------------------------------------
// Initialization, validation and submission are untouched
// ---------------------------------------------------------------------------

test("initial state is unchanged — nothing is pre-filled", () => {
  for (const field of ["vaccineName", "manufacturer", "vaccineType", "internalSku", "newTypeName"]) {
    assert.match(
      addVaccine,
      new RegExp(`const \\[${field}, set[A-Za-z]+\\] = useState\\(""\\)`),
      `${field} must still start empty`
    );
  }
  assert.match(addVaccine, /const \[vaccineTypes, setVaccineTypes\] = useState\(\[\]\)/);
  assert.match(addVaccine, /const \[showAddType, setShowAddType\] = useState\(false\)/);
});

test("every validation rule and message is intact", () => {
  assert.match(addVaccine, /const skuRegex = \/\^VXT-\\d\{3\}-\[A-Z0-9\]\{5\}\$\//);
  for (const msg of [
    "Vaccine name is required.",
    "Vaccine name must be at least 3 characters.",
    "Manufacturer or pharma company is required.",
    "Manufacturer name is too short.",
    "Please select a vaccine type.",
    "Internal inventory SKU is required.",
    "SKU format must be like VXT-992-ABCDE.",
    "This internal inventory SKU already exists.",
  ]) {
    assert.ok(addVaccine.includes(msg), `missing validation message: ${msg}`);
  }
  assert.match(addVaccine, /await skuExists\(internalSku\.trim\(\)\.toUpperCase\(\)\)/);
});

test("the submitted payload and post-success navigation are unchanged", () => {
  assert.match(
    addVaccine,
    /await addVaccine\(\{\s*vaccineName: vaccineName\.trim\(\),\s*manufacturer: manufacturer\.trim\(\),\s*vaccineType,\s*internalSku: internalSku\.trim\(\)\.toUpperCase\(\),\s*vatClassification,\s*\}\)/,
    "the four original fields are unchanged; the required VAT classification is the only addition"
  );
  assert.match(addVaccine, /Vaccine registered successfully\./);
  assert.match(addVaccine, /navigate\("\/admin\/inventory"\)/);
  // submission only happens through the service boundary
  for (const forbidden of ["addDoc", "collection(db", "firebase/firestore"]) {
    assert.ok(!addVaccine.includes(forbidden), `${forbidden} must not appear in the page`);
  }
});

test("every visible field keeps its label association", () => {
  for (const [id, label] of [
    ["vaccine-name", "Vaccine Name"],
    ["vaccine-manufacturer", "Manufacturer / Pharma Company"],
    ["vaccine-type", "Vaccine Type"],
    ["vaccine-sku", "Internal Inventory SKU"],
  ]) {
    assert.match(addVaccine, new RegExp(`htmlFor="${id}"`), `${label} needs a htmlFor`);
    assert.match(addVaccine, new RegExp(`id="${id}"`), `${label} needs an id`);
  }
});

// ---------------------------------------------------------------------------
// Add Stock is not touched by this correction
// ---------------------------------------------------------------------------

test("Add Stock still has no Storage Temperature and no step strip", () => {
  for (const gone of [
    "storageTemp",
    "storageTempDisplay",
    "Storage Temperature",
    "isValidTemperature",
    "step-tabs",
    "2. Batch Details",
    "1. Product Information",
  ]) {
    assert.ok(!addStock.includes(gone), `${gone} must stay removed`);
  }
});

test("Add Stock's own guarantees are still in place", () => {
  assert.match(addStock, /const submittingRef = useRef\(false\)/);
  assert.match(addStock, /await batchIdExists\(cleanedBatchId\)/);
  assert.match(addStock, /vaccineId: selectedVaccine\.id/);
  assert.match(addStock, /No vaccines are registered yet/);
  assert.match(addStock, /navigate\("\/admin\/inventory"\)/);
});
