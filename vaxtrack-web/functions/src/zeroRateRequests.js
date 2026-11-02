"use strict";

const {
  PolicyError, HOME_ADDRESS_ID, validateDocumentId,
  buildOrderDestinationSnapshot, territoryOf, assertOrderWithinTerritory,
  normalizeRequestedDeliveryDate,
  MAX_ORDER_LINES, MAX_LINE_QUANTITY,
  resolveLineVatClassification,
  isVaccineArchived,
} = require("./policy");
const { requireRole } = require("./operations");

const COLLECTION = "zeroRateRequests";

function clean(value, min, max, label) {
  const text = typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/g, " ") : "";
  if (text.length < min || text.length > max) throw new PolicyError("zero-rate-request-invalid", `Enter ${label} (${min}–${max} characters).`);
  return text;
}

function shape(payload, allowed) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).some((key) => !allowed.includes(key))) {
    throw new PolicyError("unknown-field", "The zero-rating request contains unexpected fields.");
  }
}

async function requestZeroRateApproval({ db, FieldValue, uid, payload, now }) {
  shape(payload, ["doctorId", "doctorAddressId", "requestedDeliveryDate", "items", "reason"]);
  const doctorId = validateDocumentId(payload.doctorId, "Select a doctor.");
  const doctorAddressId = validateDocumentId(payload.doctorAddressId, "Select a delivery address.");
  const requestedDeliveryDate = normalizeRequestedDeliveryDate(payload.requestedDeliveryDate, now);
  const reason = clean(payload.reason, 1, 500, "why this sale may qualify");
  if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > MAX_ORDER_LINES) {
    throw new PolicyError("zero-rate-request-invalid", `Choose 1–${MAX_ORDER_LINES} batches for this request.`);
  }
  const seen = new Set();
  const items = payload.items.map((item) => {
    shape(item, ["inventoryId", "quantity"]);
    const inventoryId = validateDocumentId(item.inventoryId, "Each item needs a valid batch.");
    if (seen.has(inventoryId)) throw new PolicyError("duplicate-inventory-line", "The same batch appears twice.");
    seen.add(inventoryId);
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_LINE_QUANTITY) {
      throw new PolicyError("invalid-quantity", "Each item needs a valid vial quantity.");
    }
    return { inventoryId, quantity: item.quantity };
  }).sort((a, b) => a.inventoryId.localeCompare(b.inventoryId));
  const requestRef = db.collection(COLLECTION).doc();

  return db.runTransaction(async (tx) => {
    const callerSnap = await tx.get(db.collection("users").doc(uid));
    const caller = callerSnap.exists ? callerSnap.data() : null;
    requireRole(caller, "salesrep");
    const doctorRef = db.collection("doctors").doc(doctorId);
    const addressRef = doctorRef.collection("deliveryAddresses").doc(doctorAddressId);
    const doctorSnap = await tx.get(doctorRef);
    const addressSnap = await tx.get(addressRef);
    if (!doctorSnap.exists || !addressSnap.exists) throw new PolicyError("destination-not-found", "The selected delivery address is no longer available.");
    const relationship = addressSnap.data();
    const clinicSnap = doctorAddressId === HOME_ADDRESS_ID ? null : await tx.get(db.collection("clinics").doc(doctorAddressId));
    if (clinicSnap && !clinicSnap.exists) throw new PolicyError("destination-not-found", "The selected clinic is no longer available.");
    const areaId = doctorAddressId === HOME_ADDRESS_ID ? relationship.areaId : clinicSnap.data().areaId;
    const areaSnap = await tx.get(db.collection("areas").doc(validateDocumentId(areaId, "The delivery area is invalid.")));
    const destination = buildOrderDestinationSnapshot({
      doctorId, doctorAddressId, doctor: doctorSnap.data(), relationship,
      clinic: clinicSnap?.data() ?? null, area: areaSnap.exists ? areaSnap.data() : null,
    });
    const linksSnap = await tx.get(doctorRef.collection("deliveryAddresses"));
    assertOrderWithinTerritory({
      territory: territoryOf(caller),
      doctorLinks: linksSnap.docs.map((d) => ({ ...d.data(), id: d.id })),
      destination: { type: destination.orderFields.destinationType, areaId: destination.orderFields.destinationAreaId, clinicDocId: destination.orderFields.clinicDocId },
    });
    const itemSnapshots = [];
    for (const item of items) {
      const snap = await tx.get(db.collection("inventory").doc(item.inventoryId));
      if (!snap.exists) throw new PolicyError("batch-not-found", "A selected batch no longer exists.");
      const vaccineId = validateDocumentId(snap.data().vaccineId, "A selected batch is not linked to a vaccine product.");
      const vaccineSnap = await tx.get(db.collection("vaccines").doc(vaccineId));
      if (vaccineSnap.exists && isVaccineArchived(vaccineSnap.data())) {
        throw new PolicyError("vaccine-archived", "A selected vaccine is archived and cannot be ordered.");
      }
      const vatClassification = resolveLineVatClassification({
        inventoryId: item.inventoryId, batch: snap.data(), vaccine: vaccineSnap.exists ? vaccineSnap.data() : null,
      });
      itemSnapshots.push({ ...item, batchId: snap.data().batchId ?? item.inventoryId,
        vaccineName: snap.data().vaccineName ?? "Vaccine", vatClassification });
    }
    if (!itemSnapshots.some((item) => item.vatClassification === "vatable")) {
      throw new PolicyError("zero-rate-no-vatable-lines", "This request has no VATable items to zero-rate.");
    }
    tx.create(requestRef, {
      requesterUid: uid, doctorId, doctorAddressId, requestedDeliveryDate,
      requesterName: caller.fullName || caller.name || caller.displayName || "Med Rep",
      doctorName: destination.orderFields.doctorName,
      destinationName: destination.orderFields.destinationName,
      deliveryAddress: destination.orderFields.deliveryAddress,
      items: itemSnapshots, reason, status: "pending", createdAt: FieldValue.serverTimestamp(),
    });
    return { requestId: requestRef.id, status: "pending" };
  });
}

async function reviewZeroRateApproval({ db, FieldValue, uid, payload }) {
  shape(payload, ["requestId", "decision"]);
  const requestId = validateDocumentId(payload.requestId, "Select a zero-rating request.");
  if (!["approved", "rejected"].includes(payload.decision)) throw new PolicyError("invalid-decision", "Approve or reject the request.");
  const ref = db.collection(COLLECTION).doc(requestId);
  return db.runTransaction(async (tx) => {
    const adminSnap = await tx.get(db.collection("users").doc(uid));
    requireRole(adminSnap.exists ? adminSnap.data() : null, "admin");
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PolicyError("zero-rate-request-not-found", "The request no longer exists.");
    if (snap.data().status !== "pending") throw new PolicyError("zero-rate-request-changed", "This request was already reviewed.");
    tx.update(ref, { status: payload.decision, reviewedByUid: uid, reviewedAt: FieldValue.serverTimestamp() });
    return { requestId, status: payload.decision };
  });
}

module.exports = { COLLECTION, requestZeroRateApproval, reviewZeroRateApproval };
