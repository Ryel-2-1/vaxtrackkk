// Admin Clinics: the List / Grid view toggle.
//
// Behaviour of the pure module (services/clinicsView.js) — preference
// storage, the one selection both views render, paging, card fields — plus
// source contracts for the page wiring that needs a DOM to run (this repo has
// no DOM renderer; see the other suites).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLINICS_PAGE_SIZE,
  CLINIC_VIEWS,
  CLINIC_VIEW_STORAGE_KEY,
  DEFAULT_CLINIC_VIEW,
  MISSING,
  clinicCardFields,
  clinicViewAnnouncement,
  paginateClinics,
  readClinicView,
  selectVisibleClinics,
  writeClinicView,
} from "../src/services/clinicsView.js";

const here = dirname(fileURLToPath(import.meta.url));
// Line endings normalised: some sources are checked out with CRLF.
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8").replace(/\r\n/g, "\n");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
const PAGE = read("src/pages/admin/Clinics.jsx");
const CODE = strip(PAGE);
const CSS = read("src/pages/admin/Clinics.css");

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    map,
  };
}
const throwing = {
  getItem() {
    throw new Error("SecurityError");
  },
  setItem() {
    throw new Error("QuotaExceededError");
  },
};

const clinic = (over) => ({
  id: "CLN-1",
  firestoreId: "c1",
  name: "Alpha Clinic",
  location: "1 Main St, Quezon City",
  area: "North",
  contact: "Dr. Ana Cruz",
  phone: "0917 000 0001",
  email: "alpha@example.com",
  status: "active",
  statusLabel: "Active",
  note: "Ready for Delivery",
  lastDelivery: "No delivery yet",
  locationInfo: { hasCoordinates: true },
  ...over,
});

// ---------------------------------------------------------------- preference

test("List is the safe default; the preference uses a versioned, namespaced key", () => {
  assert.equal(DEFAULT_CLINIC_VIEW, "list");
  assert.deepEqual([...CLINIC_VIEWS], ["list", "grid"]);
  assert.equal(CLINIC_VIEW_STORAGE_KEY, "vaxtrack.admin.clinics.view.v1");
  assert.equal(readClinicView(memoryStorage()), "list", "nothing stored");
  assert.equal(readClinicView(null), "list", "no storage at all");
  assert.equal(readClinicView(undefined), "list");
  assert.equal(readClinicView(throwing), "list", "storage that throws");
});

test("the choice persists, and invalid stored values fall back to List", () => {
  const storage = memoryStorage();
  assert.equal(writeClinicView("grid", storage), true);
  assert.equal(storage.map.get(CLINIC_VIEW_STORAGE_KEY), "grid");
  assert.equal(readClinicView(storage), "grid");
  assert.equal(writeClinicView("list", storage), true);
  assert.equal(readClinicView(storage), "list");
  for (const bad of ["Grid", " grid", "table", "", "null", "{\"view\":\"grid\"}", "1"]) {
    assert.equal(readClinicView(memoryStorage({ [CLINIC_VIEW_STORAGE_KEY]: bad })), "list", JSON.stringify(bad));
  }
  // Unknown values are never written; a throwing store is survived.
  assert.equal(writeClinicView("table", storage), false);
  assert.equal(storage.map.get(CLINIC_VIEW_STORAGE_KEY), "list");
  assert.equal(writeClinicView("grid", throwing), false);
  assert.equal(writeClinicView("grid", null), false);
});

test("the preference is UI-only: the page keeps storage out and Firestore out of it", () => {
  assert.match(CODE, /const \[view, setView\] = useState\(\(\) => readClinicView\(\)\);/);
  assert.match(CODE, /writeClinicView\(next\);/);
  assert.equal(/localStorage|sessionStorage/.test(PAGE), false, "storage access lives in clinicsView.js only");
  const mod = strip(read("src/services/clinicsView.js"));
  assert.equal(/firebase|firestore|setDoc|updateDoc|addDoc/i.test(mod), false, "the module never touches Firestore");
  assert.equal((mod.match(/localStorage/g) || []).length, 1, "one guarded storage accessor");
});

// ---------------------------------------------------------------- one collection

const LIVE = [
  clinic({ id: "CLN-3", firestoreId: "c3", name: "Charlie Health", status: "overdue", statusLabel: "Overdue", note: "Delivery Overdue" }),
  clinic({ id: "CLN-2", firestoreId: "c2", name: "Bravo Medical", status: "pending", statusLabel: "Pending Resupply", note: "Pending Resupply", contact: "Dr. Ben Reyes" }),
  clinic({ id: "CLN-1", firestoreId: "c1", name: "Alpha Clinic" }),
  clinic({ id: "CLN-4", firestoreId: "c4", name: "Delta Care", location: "Pasig" }),
];
// Both views read exactly this pipeline; there is no per-view copy.
const shown = (list, filters, page = 1) => paginateClinics(selectVisibleClinics(list, filters), page).items;

test("search, filter and order produce identical results for both views", () => {
  for (const filters of [
    {},
    { searchTerm: "bravo" },
    { searchTerm: "DR. ANA" },
    { searchTerm: "pasig" },
    { statusFilter: "overdue" },
    { statusFilter: "active", searchTerm: "a" },
    { searchTerm: "no such clinic" },
  ]) {
    for (let page = 1; page <= 2; page += 1) {
      const list = shown(LIVE, filters, page).map((c) => c.id);
      const grid = shown(LIVE, filters, page).map((c) => c.id);
      assert.deepEqual(grid, list, JSON.stringify(filters));
    }
  }
  // The subscription's order (newest first) is kept, not re-sorted per view.
  assert.deepEqual(selectVisibleClinics(LIVE, {}).map((c) => c.id), ["CLN-3", "CLN-2", "CLN-1", "CLN-4"]);
  assert.deepEqual(selectVisibleClinics(LIVE, { statusFilter: "active" }).map((c) => c.name), ["Alpha Clinic", "Delta Care"]);
  // The page wires BOTH views to the same paginated list.
  assert.equal((CODE.match(/paginatedClinics\.map\(/g) || []).length, 2, "List rows and Grid cards map the same list");
  assert.match(CODE, /const filteredClinics = useMemo\(\s*\(\) => selectVisibleClinics\(clinics, \{ searchTerm, statusFilter \}\)/);
  assert.match(CODE, /const paging = paginateClinics\(filteredClinics, currentPage\);/);
});

test("switching views opens no second subscription and resets nothing", () => {
  // One listener, re-opened only by Retry — never by the view.
  assert.equal((CODE.match(/subscribeClinics\(/g) || []).length, 1);
  assert.match(CODE, /return \(\) => unsubscribe\(\);\s*\}, \[retryKey\]\);/);
  const effects = [...CODE.matchAll(/useEffect\(\(\) => \{[\s\S]*?\}, \[([^\]]*)\]\);/g)].map((m) => m[1]);
  assert.ok(effects.every((deps) => !/\bview\b/.test(deps)), "no effect depends on the view");
  // changeView touches only the view, its storage and the announcement.
  const change = /const changeView = \(next\) => \{([\s\S]*?)\n {2}\};/.exec(CODE)[1];
  for (const reset of ["setSearchTerm", "setStatusFilter", "setCurrentPage", "setSelectedClinic", "scrollTo", "showToast"]) {
    assert.equal(change.includes(reset), false, `${reset} must not run on a view change`);
  }
  assert.match(change, /setView\(next\);\s*writeClinicView\(next\);\s*setViewAnnouncement\(clinicViewAnnouncement\(next\)\);/);
});

test("live add, update and remove appear in the active view without a refresh", () => {
  // Successive snapshots, as the listener delivers them.
  const s1 = [LIVE[2]];
  const s2 = [clinic({ id: "CLN-9", firestoreId: "c9", name: "New Clinic" }), ...s1]; // added (newest first)
  const s3 = s2.map((c) => (c.id === "CLN-1" ? { ...c, name: "Alpha Clinic (renamed)" } : c)); // updated
  const s4 = s3.filter((c) => c.id !== "CLN-9"); // removed
  assert.deepEqual(shown(s1, {}).map((c) => c.name), ["Alpha Clinic"]);
  assert.deepEqual(shown(s2, {}).map((c) => c.name), ["New Clinic", "Alpha Clinic"]);
  assert.deepEqual(shown(s3, {}).map((c) => c.name), ["New Clinic", "Alpha Clinic (renamed)"]);
  assert.deepEqual(shown(s4, {}).map((c) => c.name), ["Alpha Clinic (renamed)"]);
  // Every snapshot replaces the page's state, and both views derive from it.
  assert.match(CODE, /\(raw\) => \{\s*setClinics\(raw\.map\(normalizeClinic\)\);/);
  // A removal that shortens the list never strands the Admin on an empty page.
  const seven = Array.from({ length: 7 }, (_, i) => clinic({ id: `CLN-${i}`, firestoreId: `c${i}` }));
  assert.equal(paginateClinics(seven, 3).items.length, 1);
  const two = seven.slice(0, 2);
  const after = paginateClinics(two, 3);
  assert.equal(after.page, 1, "page 3 of 7 clamps to the last page that exists");
  assert.equal(after.items.length, 2);
});

test("paging: one page size for both views, honest counts", () => {
  assert.equal(CLINICS_PAGE_SIZE, 3);
  const p = paginateClinics(LIVE, 2);
  assert.deepEqual([p.page, p.totalPages, p.startItem, p.endItem, p.total], [2, 2, 4, 4, 4]);
  const empty = paginateClinics([], 1);
  assert.deepEqual([empty.page, empty.totalPages, empty.startItem, empty.endItem], [1, 1, 0, 0]);
  assert.equal(paginateClinics(LIVE, 0).page, 1);
  assert.equal(paginateClinics(LIVE, -4).page, 1);
});

// ---------------------------------------------------------------- the card

test("missing fields render '—', never a made-up default", () => {
  const bare = clinicCardFields({ id: "", name: "", contact: "   ", phone: undefined, email: null, location: "—", area: "", status: "active", statusLabel: "Active", locationInfo: {} });
  for (const key of ["name", "clinicId", "contact", "phone", "email", "location", "area", "lastDelivery", "note"]) {
    assert.equal(bare[key], MISSING, key);
  }
  assert.equal(bare.locationVerified, false);
  assert.equal(MISSING, "—");
  // Real values pass through untouched.
  const full = clinicCardFields(clinic({}));
  assert.equal(full.name, "Alpha Clinic");
  assert.equal(full.email, "alpha@example.com");
  assert.equal(full.lastDelivery, "No delivery yet", "a stored value is shown as stored");
  assert.equal(full.locationVerified, true);
  // The page no longer invents "Unassigned" / "No delivery yet" for missing fields.
  assert.match(CODE, /area: raw\.area \|\| "—",/);
  assert.match(CODE, /lastDelivery: raw\.lastDelivery \|\| "—",/);
});

test("the grid card shows the list's information and the same actions; placeholders stay disabled", () => {
  const card = /function ClinicCard\(\{ clinic, onDetails, onManageLocation \}\) \{([\s\S]*?)\n\}/.exec(CODE)[1];
  for (const label of ["Contact person", "Phone", "Email", "Location", "Area", "Last delivery"]) {
    assert.match(card, new RegExp(`<dt>${label}</dt>`), label);
  }
  assert.match(card, /\{card\.statusLabel\}/);
  assert.match(card, /Location verified/);
  assert.match(card, /Needs location/);
  // The two functional List actions, equivalent in Grid.
  assert.match(card, />\s*Details\s*</);
  assert.match(card, />\s*Manage location\s*</);
  assert.match(CODE, /onDetails=\{\(\) => setSelectedClinic\(clinic\)\}/);
  assert.match(CODE, /onManageLocation=\{\(trigger\) => openManageLocation\(clinic, trigger\)\}/);
  assert.match(card, /onClick=\{\(e\) => onManageLocation\(e\.currentTarget\)\}/, "focus returns to the card's button");
  // No fake actions in the card; Edit stays the disabled, explained control in Details.
  assert.equal(/Edit Clinic|Contact Rider|showToast|onEdit/.test(card), false);
  assert.match(PAGE, /disabled\s+aria-describedby="clinic-edit-unavailable"/);
  // Registration is the real dialog; the old pages stay gone.
  assert.match(PAGE, /function NewClinicModal\(/);
  assert.equal(/RegisterClinic|ClinicSuccess|register-clinic/.test(PAGE), false);
});

// ---------------------------------------------------------------- toggle a11y

test("the toggle is a labelled group of two real buttons with pressed state and visible labels", () => {
  const toggle = /<div className="clinics-view-toggle" role="group" aria-label="Clinic display view">([\s\S]*?)<\/div>/.exec(PAGE);
  assert.ok(toggle, "an accessible name on the group");
  const buttons = toggle[1].match(/<button[\s\S]*?<\/button>/g);
  assert.equal(buttons.length, 2);
  assert.match(buttons[0], /type="button"[\s\S]*aria-pressed=\{view === "list"\}[\s\S]*\n\s*List\n/);
  assert.match(buttons[1], /type="button"[\s\S]*aria-pressed=\{view === "grid"\}[\s\S]*\n\s*Grid\n/);
  for (const b of buttons) {
    assert.match(b, /aria-hidden="true"/, "icons are decorative; the label is text");
    assert.equal(/tabIndex=\{?-1/.test(b), false, "reachable by keyboard");
  }
  // Polite announcement, no toast.
  assert.match(PAGE, /<p className="m-visually-hidden" aria-live="polite">\s*\{viewAnnouncement\}\s*<\/p>/);
  assert.equal(clinicViewAnnouncement("grid"), "Showing clinics as a grid.");
  assert.equal(clinicViewAnnouncement("list"), "Showing clinics as a list.");
  // Visible focus and the selected state is not colour-only (aria-pressed + text).
  assert.match(CSS, /\.clinics-view-toggle button:focus-visible \{\s*outline: 2px solid var\(--green-700\);/);
});

// ---------------------------------------------------------------- states

test("loading, error, no clinics and no search results stay distinct in both views", () => {
  // States sit outside the List/Grid branch, so both views share them.
  const branchEnd = CODE.indexOf("</ul>\n          )}");
  assert.ok(branchEnd > 0);
  const states = CODE.slice(branchEnd);
  assert.match(states, /\{loading && \([\s\S]*?Loading clinics\.\.\./);
  assert.match(states, /\{!loading && loadError && \([\s\S]*?<Notice tone="error" title="Could not load clinics">\s*\{loadError\}/);
  assert.match(states, /onClick=\{retryClinics\}/);
  assert.match(CODE, /const retryClinics = \(\) => \{\s*setLoadError\(""\);\s*setLoading\(true\);\s*setRetryKey\(\(k\) => k \+ 1\);/, "Retry re-opens the listener");
  assert.match(states, /clinics\.length === 0\s*\?\s*"No clinics registered yet\."\s*:\s*"No clinics found"/);
  assert.match(states, /Try changing the search keyword or selected status filter\./);
  // No false zeros: KPIs dash, and the "Showing x of y" line is hidden while loading or failed.
  assert.match(CODE, /value=\{kpiValue\(clinics\.length, \{ loading, error: loadError \}\)\}/);
  assert.match(CODE, /\{!loading && !loadError && \(\s*<div className="clinics-v2-pagination">/);
  assert.match(CODE, /setLoadError\(liveErrorMessage\(error, "clinics"\)\);/);
  assert.equal(/\b(?:err|error)\??\.message\b/.test(CODE), false);
});

// ---------------------------------------------------------------- layout

test("320 px and 200% zoom: responsive columns, no fixed widths, long text wraps", () => {
  const grid = CSS.slice(CSS.indexOf("List / Grid view toggle and Grid view."));
  assert.ok(grid.length > 0);
  assert.match(grid, /grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 280px\), 1fr\)\);/, "multi-column when wide, one column when narrow");
  assert.match(grid, /\.clinic-card article \{[\s\S]*?overflow-wrap: anywhere;/, "names, addresses, emails and phones wrap");
  assert.match(grid, /\.clinic-card \{\s*min-width: 0;/);
  assert.match(grid, /\.clinic-card-fields \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(grid, /@media \(max-width: 480px\) \{[\s\S]*?\.clinic-card-fields \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.equal(/(?<![-\w])width: \d+px/.test(grid), false, "no fixed pixel widths");
  assert.equal(/min-width: [1-9]\d{2,}px/.test(grid), false, "no wide minimums");
  // The grid never inherits the table's horizontal scroller.
  assert.match(grid, /\.clinics-v2-table-card\.is-grid \{\s*overflow: visible;/);
});
