import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Admin Clinics manages clinic records and verified locations. It does not
// start deliveries — those come from the normal order workflow (Sales Rep
// order → Dispatcher assignment → Rider delivery).
//
// The page used to offer a "Create Delivery" action that only raised a toast
// and drafted nothing. These guard that it stays gone, and that everything the
// page genuinely owns is untouched.
//
// Source-shape assertions: this repo has no jsdom/RTL and adding one would be
// a dependency change, matching the other suites here.

const here = dirname(fileURLToPath(import.meta.url));
const src = (...p) => readFileSync(join(here, "..", "src", ...p), "utf8");

const clinicsPage = src("pages", "admin", "Clinics.jsx");
const clinicsCss = src("pages", "admin", "Clinics.css");
const clinicService = src("services", "clinicService.js");

// ---------------------------------------------------------------------------
// The delivery draft is gone
// ---------------------------------------------------------------------------

test("clinic rows no longer render a Create Delivery action", () => {
  assert.ok(
    !clinicsPage.includes("Create Delivery"),
    "the button label must be gone from the page entirely"
  );
});

test("the obsolete handler and its toast text are gone", () => {
  for (const marker of [
    "onCreateDelivery",
    "createDelivery",
    "Delivery draft opened",
    "deliveryDraft",
  ]) {
    assert.ok(!clinicsPage.includes(marker), `${marker} must be gone`);
  }
});

test("no delivery-draft storage operation remains on the page", () => {
  // For the record: this page never had one. There is no localStorage or
  // sessionStorage usage here at all, and none was added in its place.
  assert.ok(
    !clinicsPage.includes("localStorage"),
    "the page must not use localStorage"
  );
  assert.ok(
    !clinicsPage.includes("sessionStorage"),
    "the page must not use sessionStorage"
  );
});

test("the details modal no longer takes a delivery callback", () => {
  const start = clinicsPage.indexOf("function ClinicDetailsModal(");
  assert.notEqual(start, -1, "ClinicDetailsModal not found");
  // Slice from `start`, not start + 1 — the latter chops the leading `f` and
  // makes a `function ...` assertion silently unmatchable.
  const rest = clinicsPage.slice(start);
  const next = rest.search(/\nfunction [A-Z]/);
  const modal = next === -1 ? rest : rest.slice(0, next);

  assert.match(
    modal,
    /^function ClinicDetailsModal\(\{ clinic, onClose, onEdit \}\)/,
    "the onCreateDelivery prop must be removed from the signature"
  );
  assert.ok(!modal.includes("Create Delivery"));
  assert.ok(!modal.includes("onCreateDelivery"));
});

// ---------------------------------------------------------------------------
// Everything else the page owns, unchanged
// ---------------------------------------------------------------------------

test("Details remains available", () => {
  assert.match(clinicsPage, />\s*Details\s*</);
  assert.match(clinicsPage, /setSelectedClinic\(clinic\)/);
  assert.match(clinicsPage, /function ClinicDetailsModal\(/);
});

test("Manage location remains available and unchanged", () => {
  assert.match(clinicsPage, />\s*Manage location\s*</);
  assert.match(clinicsPage, /openManageLocation\(clinic, e\.currentTarget\)/);
  assert.match(clinicsPage, /function ManageLocationModal\(/);
  // Its dirty-form protection and focus handling must survive.
  assert.match(clinicsPage, /const requestClose = useCallback\(/);
  assert.match(clinicsPage, /e\.key === "Escape"/);
  assert.match(clinicsPage, /manageTriggerRef\.current\.focus\(\)/);
  assert.match(clinicsPage, /updateClinicLocation\(/);
});

test("Register New Clinic remains available and unchanged", () => {
  assert.match(clinicsPage, />\s*Register New Clinic\s*</);
  assert.match(clinicsPage, /function NewClinicModal\(/);
  assert.match(clinicsPage, /clinicNameExists\(/, "duplicate-name check kept");
  assert.match(clinicsPage, /addClinic\(/);
  assert.match(clinicsPage, /createEmptyNewClinic|EMPTY_CLINIC/);
});

test("search, filters and pagination remain", () => {
  assert.match(clinicsPage, /setSearchTerm\(/);
  assert.match(clinicsPage, /handleStatusFilter\(/);
  assert.match(clinicsPage, /setCurrentPage\(/);
  assert.match(clinicsPage, /paginatedClinics/);
});

test("the Firestore subscription is the only source of clinic state", () => {
  assert.match(clinicsPage, /subscribeClinics\(/);
  assert.match(clinicService, /onSnapshot\(/);

  const calls = clinicsPage.match(/setClinics\(/g) ?? [];
  assert.equal(calls.length, 1, "setClinics must be called exactly once");
  assert.match(
    clinicsPage,
    /subscribeClinics\([\s\S]*?setClinics\(raw\.map\(normalizeClinic\)\)/,
    "the single call must be the subscription mapping"
  );
});

test("clinic document ids remain authoritative", () => {
  // Document id assigned AFTER the spread, so a stored `id` field cannot
  // shadow it — this value becomes clinicDocId on an order.
  assert.match(
    clinicService,
    /\.\.\.d\.data\(\),\s*id: d\.id/,
    "document id must be assigned after the spread"
  );
  assert.doesNotMatch(
    clinicService,
    /\{\s*id: d\.id,\s*\.\.\.d\.data\(\)\s*\}/,
    "the shadowable ordering must not return"
  );
  // The location writer is still keyed by the Firestore document id.
  assert.match(clinicsPage, /firestoreId/);
});

test("the row actions container is still used, so its CSS stays", () => {
  assert.match(clinicsPage, /className="clinic-row-actions"/);
  assert.ok(clinicsCss.includes(".clinic-row-actions"));
  // No fixed width on the actions column, so it reflows on its own after the
  // button removal — nothing to resize by hand.
  assert.doesNotMatch(
    clinicsCss,
    /\.clinic-row-actions\s*\{[^}]*width:/,
    "the actions container must not gain a fixed width"
  );
});

// ---------------------------------------------------------------------------
// Delivery creation elsewhere is untouched
// ---------------------------------------------------------------------------

test("Sales Rep order creation is untouched", () => {
  const placeOrder = src("pages", "salesRep", "SalesRepPlaceOrder.jsx");
  assert.match(placeOrder, /createSalesRepOrder\(/);
  assert.match(placeOrder, /clinicDocId: verifiedClinic\.id/);
});

test("Dispatcher assignment and status flow are untouched", () => {
  const orderService = src("services", "orderService.js");
  assert.match(orderService, /export async function assignRiderToOrder\(/);
  assert.match(orderService, /export async function updateOrderStatus\(/);
  assert.match(orderService, /export async function createSalesRepOrder\(/);
});

test("the Phase 02 order location snapshot is untouched", () => {
  const orderLocation = src("services", "orderLocation.js");
  assert.match(orderLocation, /export function buildClinicLocationSnapshot\(/);
  assert.match(orderLocation, /clinicDocId/);
});
