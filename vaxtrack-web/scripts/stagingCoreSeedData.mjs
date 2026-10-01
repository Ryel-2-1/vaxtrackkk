// Pure, Firebase-free Core Sample Data plan for VaxTrack STAGING.
//
// This module ONLY builds the deterministic seed plan and validates its internal
// consistency (counts, uniqueness, relationships, expiry distribution, forbidden
// fields). It performs no I/O, so it is unit-tested directly with `node --test`.
// The runner (seedStagingCoreData.mjs) consumes this plan, checks Firestore for
// collisions, and — only with --apply + confirmation — writes it.
//
// Field shapes mirror the CURRENT service writers exactly (vaccineService,
// clinicService, areaService, doctorService, doctorAddressService) and the
// current firestore.rules validators. Timestamp fields are NOT set here — the
// runner stamps them with serverTimestamp() (which resolves to request.time,
// as the rules require) using each record's `serverTimestampFields`.
//
// Normalisation is imported from the app's own pure model modules so seeded
// nameNormalized / key values match what the app would write.

import { normalizeAreaName, areaDocumentId } from "../src/services/areaModel.js";
import { normalizeDoctorName } from "../src/services/doctorModel.js";
import { HOME_ADDRESS_ID } from "../src/services/doctorAddressModel.js";

export const SEED_PREFIX = "vtseed-core-20260924-";
export const SEED_DATE = "2026-09-24"; // base date for expiry distribution
const DEFAULT_GEOFENCE_RADIUS_M = 300;

// ---------------------------------------------------------------- date helpers

/** Add whole days to a 'YYYY-MM-DD' date (UTC), returning 'YYYY-MM-DD'. */
export function addDaysIso(iso, days) {
  const base = new Date(`${iso}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/**
 * The batch status stamped at Add Stock time, replicated from
 * AddStock.getBatchStatus: <=30 days -> Critical, <=90 -> Warning, else Stable.
 * (The app derives the LIVE condition from expiryDate; this is only the stored
 * historical stamp, kept identical so the seed doesn't invent a second rule.)
 */
export function batchStatusFromExpiry(expiryIso, todayIso = SEED_DATE) {
  const diffDays = Math.ceil(
    (Date.parse(`${expiryIso}T00:00:00.000Z`) -
      Date.parse(`${todayIso}T00:00:00.000Z`)) /
      (1000 * 60 * 60 * 24)
  );
  if (diffDays <= 30) return "Critical";
  if (diffDays <= 90) return "Warning";
  return "Stable";
}

const pad2 = (n) => String(n).padStart(2, "0");

// -------------------------------------------------------------------- raw data

// Five areas. `name` is a SAMPLE-PREFIXED business identifier (constraint 13) so
// it cannot collide with a real staging area of the same place; `label` is the
// geographic name used only in human display text (clinic/home). Deterministic
// doc ids; the rule requires `key == docId`. Coordinates sit in the named place.
const AREA_DEFS = [
  { n: 1, label: "Biñan", name: "VaxTrack Sample Area - Biñan", lat: 14.3306, lng: 121.0857 },
  { n: 2, label: "Santa Rosa", name: "VaxTrack Sample Area - Santa Rosa", lat: 14.3123, lng: 121.1114 },
  { n: 3, label: "Cabuyao", name: "VaxTrack Sample Area - Cabuyao", lat: 14.2726, lng: 121.1256 },
  { n: 4, label: "Calamba", name: "VaxTrack Sample Area - Calamba", lat: 14.2117, lng: 121.1653 },
  { n: 5, label: "San Pedro", name: "VaxTrack Sample Area - San Pedro", lat: 14.3583, lng: 121.047 },
];

// Five clearly-synthetic vaccine TYPE names (referenced by product + batch).
const VACCINE_TYPE_DEFS = [
  { n: 1, name: "VaxTrack Sample Type mRNA" },
  { n: 2, name: "VaxTrack Sample Type Viral Vector" },
  { n: 3, name: "VaxTrack Sample Type Inactivated" },
  { n: 4, name: "VaxTrack Sample Type Subunit" },
  { n: 5, name: "VaxTrack Sample Type Toxoid" },
];

// Eight synthetic vaccine products; each references one of the five type names.
const VACCINE_DEFS = [
  { n: 1, name: "VaxTrack Sample Vaccine 01", manufacturer: "Sample Biologics Inc.", type: 1 },
  { n: 2, name: "VaxTrack Sample Vaccine 02", manufacturer: "Sample Biologics Inc.", type: 1 },
  { n: 3, name: "VaxTrack Sample Vaccine 03", manufacturer: "Sample Vaxworks Corp.", type: 2 },
  { n: 4, name: "VaxTrack Sample Vaccine 04", manufacturer: "Sample Vaxworks Corp.", type: 3 },
  { n: 5, name: "VaxTrack Sample Vaccine 05", manufacturer: "Sample Immuno Labs", type: 3 },
  { n: 6, name: "VaxTrack Sample Vaccine 06", manufacturer: "Sample Immuno Labs", type: 4 },
  { n: 7, name: "VaxTrack Sample Vaccine 07", manufacturer: "Sample BioPharma Ltd.", type: 4 },
  { n: 8, name: "VaxTrack Sample Vaccine 08", manufacturer: "Sample BioPharma Ltd.", type: 5 },
];

// Eight clinics across the five areas; every clinic has a verified location.
const CLINIC_DEFS = [
  { n: 1, area: 1, dLat: 0.001, dLng: 0.001 },
  { n: 2, area: 2, dLat: -0.001, dLng: 0.0012 },
  { n: 3, area: 3, dLat: 0.0012, dLng: -0.001 },
  { n: 4, area: 4, dLat: -0.0012, dLng: -0.0012 },
  { n: 5, area: 5, dLat: 0.0015, dLng: 0.0015 },
  { n: 6, area: 1, dLat: -0.0015, dLng: 0.0018 },
  { n: 7, area: 2, dLat: 0.0018, dLng: -0.0015 },
  { n: 8, area: 3, dLat: -0.0018, dLng: 0.0011 },
];

// Eight synthetic doctors; each references an area, gets a home destination, and
// links to one or two seeded clinics (clinic-link doc id = clinic doc id).
const DOCTOR_DEFS = [
  { n: 1, name: "Dr. Sample Alonzo", area: 1, clinics: [1, 6] },
  { n: 2, name: "Dr. Sample Bautista", area: 2, clinics: [2, 7] },
  { n: 3, name: "Dr. Sample Cruz", area: 3, clinics: [3, 8] },
  { n: 4, name: "Dr. Sample Delgado", area: 4, clinics: [4] },
  { n: 5, name: "Dr. Sample Estrada", area: 5, clinics: [5] },
  { n: 6, name: "Dr. Sample Fajardo", area: 1, clinics: [1] },
  { n: 7, name: "Dr. Sample Gutierrez", area: 2, clinics: [2, 3] },
  { n: 8, name: "Dr. Sample Herrera", area: 3, clinics: [3, 4] },
];

// Fifteen inventory batches, distributed across vaccines, with the required
// expiry spread. `offsetDays` is relative to SEED_DATE.
//  - 12 stable (> 90 days), 1 warning (31-90), 1 critical (0-30), 1 expired.
const BATCH_DEFS = [
  { n: 1, vaccine: 1, qty: 500, priceCentavos: 120000, offsetDays: 180 },
  { n: 2, vaccine: 1, qty: 320, priceCentavos: 120000, offsetDays: 210 },
  { n: 3, vaccine: 2, qty: 260, priceCentavos: 98000, offsetDays: 200 },
  { n: 4, vaccine: 3, qty: 180, priceCentavos: 150000, offsetDays: 240 },
  { n: 5, vaccine: 4, qty: 420, priceCentavos: 110000, offsetDays: 150 },
  { n: 6, vaccine: 5, qty: 150, priceCentavos: 175000, offsetDays: 300 },
  { n: 7, vaccine: 6, qty: 240, priceCentavos: 90000, offsetDays: 190 },
  { n: 8, vaccine: 7, qty: 310, priceCentavos: 88000, offsetDays: 220 },
  { n: 9, vaccine: 8, qty: 200, priceCentavos: 130000, offsetDays: 160 },
  { n: 10, vaccine: 2, qty: 275, priceCentavos: 98000, offsetDays: 170 },
  { n: 11, vaccine: 4, qty: 130, priceCentavos: 150000, offsetDays: 260 },
  { n: 12, vaccine: 6, qty: 190, priceCentavos: 90000, offsetDays: 130 },
  { n: 13, vaccine: 3, qty: 90, priceCentavos: 150000, offsetDays: 60 }, // warning
  { n: 14, vaccine: 5, qty: 60, priceCentavos: 175000, offsetDays: 15 }, // critical
  { n: 15, vaccine: 7, qty: 40, priceCentavos: 88000, offsetDays: -30 }, // expired
];

// -------------------------------------------------------------- plan assembly

function areaId(n) {
  return `${SEED_PREFIX}area-${pad2(n)}`;
}
function vaccineTypeId(n) {
  return `${SEED_PREFIX}vtype-${pad2(n)}`;
}
function vaccineId(n) {
  return `${SEED_PREFIX}vax-${pad2(n)}`;
}
function batchDocId(n) {
  return `${SEED_PREFIX}batch-${pad2(n)}`;
}
function clinicId(n) {
  return `${SEED_PREFIX}clinic-${pad2(n)}`;
}
function doctorId(n) {
  return `${SEED_PREFIX}doctor-${pad2(n)}`;
}

/**
 * Build the full deterministic seed plan.
 *
 * @param {{today?: string}} [opts]
 * @returns a plan whose records carry: collection, id (top-level) OR path
 *   (nested), a `businessKey` for collision reporting, `collisionQuery` for
 *   business-identifier duplicate detection, `data` (no timestamps), and
 *   `serverTimestampFields` for the runner to stamp.
 */
export function buildSeedPlan({ today = SEED_DATE } = {}) {
  const areas = AREA_DEFS.map((a) => {
    const name = a.name;
    return {
      collection: "areas",
      id: areaId(a.n),
      businessKey: { label: "name", value: name },
      collisionQuery: { field: "nameNormalized", value: normalizeAreaName(name) },
      data: {
        // The rule requires key == docId. We use the deterministic seed id as
        // the key (also a valid area key) rather than areaDocumentId(name), so
        // the whole seed shares one id scheme.
        key: areaId(a.n),
        name,
        nameNormalized: normalizeAreaName(name),
        active: true,
      },
      serverTimestampFields: ["createdAt", "updatedAt"],
    };
  });

  const vaccineTypes = VACCINE_TYPE_DEFS.map((t) => ({
    collection: "vaccineTypes",
    id: vaccineTypeId(t.n),
    businessKey: { label: "name", value: t.name },
    collisionQuery: { field: "name", value: t.name },
    data: { name: t.name },
    serverTimestampFields: ["createdAt"],
  }));

  const vaccines = VACCINE_DEFS.map((v) => {
    const sku = `VTSEED-SKU-${pad2(v.n)}`;
    const typeName = VACCINE_TYPE_DEFS.find((t) => t.n === v.type).name;
    return {
      collection: "vaccines",
      id: vaccineId(v.n),
      businessKey: { label: "internalSku", value: sku },
      collisionQuery: { field: "internalSku", value: sku },
      data: {
        vaccineName: v.name,
        manufacturer: v.manufacturer,
        vaccineType: typeName,
        internalSku: sku,
      },
      serverTimestampFields: ["createdAt"],
      // structural link for validation only (not written)
      _refVaccineTypeName: typeName,
    };
  });

  const inventory = BATCH_DEFS.map((b) => {
    const v = VACCINE_DEFS.find((x) => x.n === b.vaccine);
    const typeName = VACCINE_TYPE_DEFS.find((t) => t.n === v.type).name;
    const batchId = `VTSEED-BATCH-${pad2(b.n)}`;
    const expiryDate = addDaysIso(today, b.offsetDays);
    return {
      collection: "inventory",
      id: batchDocId(b.n),
      businessKey: { label: "batchId", value: batchId },
      collisionQuery: { field: "batchId", value: batchId },
      data: {
        vaccineId: vaccineId(v.n),
        vaccineName: v.name,
        vaccineType: typeName,
        manufacturer: v.manufacturer,
        internalSku: `VTSEED-SKU-${pad2(v.n)}`,
        batchId,
        arrivalDate: today,
        expiryDate, // 'YYYY-MM-DD' (10 chars) — rule requires size == 10
        quantity: b.qty, // positive integer
        reservedQuantity: 0, // rule requires exactly 0 on create
        sellingPriceCentavos: b.priceCentavos, // positive integer, PHP centavos
        priceCurrency: "PHP",
        priceIsVatInclusive: false,
        status: batchStatusFromExpiry(expiryDate, today),
      },
      serverTimestampFields: ["createdAt"],
      _refVaccineId: vaccineId(v.n),
    };
  });

  const clinics = CLINIC_DEFS.map((c) => {
    const area = AREA_DEFS.find((a) => a.n === c.area);
    const areaName = area.name; // the area's business identifier (matches record)
    const name = `VaxTrack Sample Clinic - ${area.label} ${pad2(c.n)}`;
    const clinicBusinessId = `VTSEED-CLINIC-${pad2(c.n)}`;
    return {
      collection: "clinics",
      id: clinicId(c.n),
      businessKey: { label: "name", value: name },
      // Two business identifiers to guard: the display name and the clinicId.
      collisionQueries: [
        { field: "name", value: name },
        { field: "clinicId", value: clinicBusinessId },
      ],
      data: {
        clinicId: clinicBusinessId,
        name,
        location: `${100 + c.n} Sample Street, ${area.label}, Laguna`,
        areaId: areaId(c.area),
        area: areaName,
        contact: `Sample Contact ${pad2(c.n)}`,
        phone: `0917000${pad2(c.n)}00`,
        email: `sample.clinic.${pad2(c.n)}@example.test`,
        deliveryNotes: "Synthetic sample clinic for staging tests.",
        status: "Active",
        lastDelivery: "No delivery yet",
        latitude: Number((area.lat + c.dLat).toFixed(6)),
        longitude: Number((area.lng + c.dLng).toFixed(6)),
        geofenceRadiusM: DEFAULT_GEOFENCE_RADIUS_M,
        locationVerified: true,
      },
      serverTimestampFields: ["createdAt", "locationUpdatedAt"],
      _refAreaId: areaId(c.area),
      _refAreaName: areaName,
    };
  });

  const doctors = DOCTOR_DEFS.map((d) => {
    const areaName = AREA_DEFS.find((a) => a.n === d.area).name;
    return {
      collection: "doctors",
      id: doctorId(d.n),
      businessKey: { label: "name", value: d.name },
      data: {
        name: d.name,
        nameNormalized: normalizeDoctorName(d.name),
        areaId: areaId(d.area),
        area: areaName,
        active: true,
      },
      serverTimestampFields: ["createdAt", "updatedAt"],
      _refAreaId: areaId(d.area),
      _refAreaName: areaName,
    };
  });

  const doctorHomes = DOCTOR_DEFS.map((d) => {
    const area = AREA_DEFS.find((a) => a.n === d.area);
    return {
      collection: "deliveryAddresses(home)",
      path: ["doctors", doctorId(d.n), "deliveryAddresses", HOME_ADDRESS_ID],
      businessKey: { label: "doctor+home", value: `${doctorId(d.n)}/home` },
      data: {
        kind: HOME_ADDRESS_ID,
        addressLine: `Sample Home ${pad2(d.n)}, ${area.label}, Laguna`,
        areaId: areaId(d.area),
        area: area.name,
        latitude: Number((area.lat - 0.0009).toFixed(6)),
        longitude: Number((area.lng - 0.0009).toFixed(6)),
        geofenceRadiusM: DEFAULT_GEOFENCE_RADIUS_M,
        active: true,
      },
      serverTimestampFields: ["createdAt", "updatedAt"],
      _refDoctorId: doctorId(d.n),
      _refAreaId: areaId(d.area),
    };
  });

  const doctorClinicLinks = DOCTOR_DEFS.flatMap((d) =>
    d.clinics.map((cn) => ({
      collection: "deliveryAddresses(clinic)",
      path: ["doctors", doctorId(d.n), "deliveryAddresses", clinicId(cn)],
      businessKey: {
        label: "doctor+clinic",
        value: `${doctorId(d.n)}/${clinicId(cn)}`,
      },
      data: { active: true },
      serverTimestampFields: ["createdAt", "updatedAt"],
      _refDoctorId: doctorId(d.n),
      _refClinicId: clinicId(cn),
    }))
  );

  return {
    areas,
    vaccineTypes,
    vaccines,
    inventory,
    clinics,
    doctors,
    doctorHomes,
    doctorClinicLinks,
  };
}

/** Ordered stages, respecting Firestore relationship dependencies. */
export const STAGE_ORDER = [
  "vaccineTypes",
  "areas",
  "vaccines",
  "inventory",
  "clinics",
  "doctors",
  "doctorHomes",
  "doctorClinicLinks",
];

/**
 * Validate the plan's INTERNAL consistency (no I/O). Returns { ok, errors }.
 * Firestore collision checks live in the runner; this proves the plan itself is
 * well-formed before any network call.
 */
export function validateSeedPlan(plan) {
  const errors = [];
  const expect = (cond, msg) => {
    if (!cond) errors.push(msg);
  };

  // Counts.
  expect(plan.vaccineTypes.length === 5, "must be 5 vaccine types");
  expect(plan.vaccines.length === 8, "must be 8 vaccine products");
  expect(plan.inventory.length === 15, "must be 15 inventory batches");
  expect(plan.areas.length === 5, "must be 5 areas");
  expect(plan.clinics.length === 8, "must be 8 clinics");
  expect(plan.doctors.length === 8, "must be 8 doctors");
  expect(plan.doctorHomes.length === 8, "every doctor must have a home destination");
  expect(plan.doctorClinicLinks.length >= 8, "every doctor must have >=1 clinic link");

  // Deterministic id prefix on every top-level record.
  for (const key of ["areas", "vaccineTypes", "vaccines", "inventory", "clinics", "doctors"]) {
    for (const r of plan[key]) {
      expect(
        typeof r.id === "string" && r.id.startsWith(SEED_PREFIX),
        `${key} id must start with ${SEED_PREFIX}: ${r.id}`
      );
    }
  }

  // Uniqueness of business identifiers.
  const uniq = (values, label) => {
    const set = new Set(values);
    expect(set.size === values.length, `duplicate ${label} in the plan`);
  };
  uniq(plan.vaccineTypes.map((t) => t.data.name), "vaccine type name");
  uniq(plan.vaccines.map((v) => v.data.internalSku), "vaccine SKU");
  uniq(plan.inventory.map((b) => b.data.batchId), "inventory batchId");
  uniq(plan.clinics.map((c) => c.data.name), "clinic name");
  uniq(plan.clinics.map((c) => c.data.clinicId), "clinicId");
  uniq(plan.areas.map((a) => a.data.nameNormalized), "area nameNormalized");
  // Every document id across the plan is globally unique.
  const allIds = [
    ...["areas", "vaccineTypes", "vaccines", "inventory", "clinics", "doctors"].flatMap(
      (k) => plan[k].map((r) => r.id)
    ),
    ...plan.doctorHomes.map((r) => r.path.join("/")),
    ...plan.doctorClinicLinks.map((r) => r.path.join("/")),
  ];
  uniq(allIds, "document id/path");

  // Relationships resolve within the plan.
  const typeNames = new Set(plan.vaccineTypes.map((t) => t.data.name));
  const vaccineIds = new Set(plan.vaccines.map((v) => v.id));
  const areaIds = new Set(plan.areas.map((a) => a.id));
  const clinicIds = new Set(plan.clinics.map((c) => c.id));
  const doctorIds = new Set(plan.doctors.map((d) => d.id));
  const areaNameById = new Map(plan.areas.map((a) => [a.id, a.data.name]));

  for (const v of plan.vaccines) {
    expect(typeNames.has(v.data.vaccineType), `vaccine ${v.id} references an unknown type`);
  }
  for (const b of plan.inventory) {
    expect(vaccineIds.has(b.data.vaccineId), `batch ${b.id} references an unknown vaccine`);
    expect(typeof b.data.expiryDate === "string" && b.data.expiryDate.length === 10,
      `batch ${b.id} expiryDate must be 'YYYY-MM-DD'`);
    expect(Number.isInteger(b.data.quantity) && b.data.quantity > 0,
      `batch ${b.id} quantity must be a positive integer`);
    expect(b.data.reservedQuantity === 0, `batch ${b.id} reservedQuantity must be 0`);
    expect(Number.isInteger(b.data.sellingPriceCentavos) && b.data.sellingPriceCentavos > 0,
      `batch ${b.id} sellingPriceCentavos must be a positive integer`);
    expect(!("temperature" in b.data), `batch ${b.id} must not carry a temperature field`);
    expect(b.data.priceIsVatInclusive === false, `batch ${b.id} must be VAT-exclusive`);
  }
  for (const c of plan.clinics) {
    expect(areaIds.has(c.data.areaId), `clinic ${c.id} references an unknown area`);
    expect(areaNameById.get(c.data.areaId) === c.data.area,
      `clinic ${c.id} area name must match its area record`);
    expect(c.data.locationVerified === true, `clinic ${c.id} must be locationVerified`);
    expect(Number.isInteger(c.data.geofenceRadiusM) &&
      c.data.geofenceRadiusM >= 50 && c.data.geofenceRadiusM <= 1000,
      `clinic ${c.id} geofence radius must be an integer 50..1000`);
    expect(c.data.latitude >= -90 && c.data.latitude <= 90 &&
      c.data.longitude >= -180 && c.data.longitude <= 180,
      `clinic ${c.id} coordinates out of range`);
  }
  for (const d of plan.doctors) {
    expect(areaIds.has(d.data.areaId), `doctor ${d.id} references an unknown area`);
    expect(areaNameById.get(d.data.areaId) === d.data.area,
      `doctor ${d.id} area name must match its area record`);
  }
  for (const h of plan.doctorHomes) {
    expect(doctorIds.has(h._refDoctorId), `home for ${h._refDoctorId} has no doctor`);
    expect(areaIds.has(h._refAreaId), `home for ${h._refDoctorId} references an unknown area`);
    expect(h.data.kind === HOME_ADDRESS_ID, "home address kind must be 'home'");
    expect(h.data.addressLine.length >= 5, "home addressLine too short");
  }
  for (const link of plan.doctorClinicLinks) {
    expect(doctorIds.has(link._refDoctorId), `clinic link references an unknown doctor`);
    expect(clinicIds.has(link._refClinicId), `clinic link references an unknown clinic`);
    expect(Object.keys(link.data).length === 1 && link.data.active === true,
      "clinic link must carry only { active:true } (+ timestamps)");
  }

  // Every doctor has at least one clinic link.
  const linkedDoctors = new Set(plan.doctorClinicLinks.map((l) => l._refDoctorId));
  for (const d of plan.doctors) {
    expect(linkedDoctors.has(d.id), `doctor ${d.id} has no clinic link`);
  }

  // Expiry distribution: 12 stable, 1 warning, 1 critical, 1 expired.
  const dist = { Stable: 0, Warning: 0, Critical: 0 };
  let expired = 0;
  for (const b of plan.inventory) {
    if (b.data.expiryDate < SEED_DATE) expired += 1;
    dist[b.data.status] = (dist[b.data.status] || 0) + 1;
  }
  expect(expired === 1, "exactly one batch must be expired (past date)");
  // 12 stable (>90d) + 1 warning (31-90) + 1 critical (0-30) + 1 expired(Critical stamp)
  expect(dist.Stable === 12, "must be 12 stable batches");
  expect(dist.Warning === 1, "must be 1 warning batch");
  expect(dist.Critical === 2, "must be 2 Critical-stamped batches (near-expiry + expired)");

  return { ok: errors.length === 0, errors };
}
