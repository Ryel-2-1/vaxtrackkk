"use strict";

const { PolicyError, validateDocumentId, isoDateOnly, manilaDateString } = require("./policy");
const { statusFromExpiry } = require("./inventoryWorkflow");

const { usableThrough, reservedInventoryIds } = require("./expiryGuard");

const FIELDS = ["batchId", "manufacturingDate", "expiryDate", "location", "manufacturer"];
// Orders that hold a batch whose expiry is being edited, checked in one transaction.
const MAX_RESERVATIONS_CHECKED = 100;
const CLOSED_ORDER_STATUSES = new Set(["delivered", "completed", "cancelled", "canceled"]);

function validateBatchMetadata(payload, now) {
  if (!payload || Object.keys(payload).some((key) => !["inventoryId", "expected", ...FIELDS].includes(key))) {
    throw new PolicyError("invalid-batch-edit", "Unexpected batch edit field.");
  }
  const inventoryId = validateDocumentId(payload.inventoryId, "Choose a batch.");
  const values = Object.fromEntries(FIELDS.map((key) => [key, payload[key]]));
  const expected = payload.expected;
  if (!expected || FIELDS.some((key) => typeof expected[key] !== "string")) {
    throw new PolicyError("invalid-batch-edit", "Reload the batch before editing.");
  }
  const batchId = typeof values.batchId === "string" ? values.batchId.trim().toUpperCase() : "";
  if (batchId.length < 2 || batchId.length > 64) throw new PolicyError("invalid-batch-edit", "Batch ID must be 2–64 characters.");
  const manufacturingDate = isoDateOnly(values.manufacturingDate);
  const expiryDate = isoDateOnly(values.expiryDate);
  if (!manufacturingDate || !expiryDate) throw new PolicyError("invalid-batch-edit", "Enter valid manufacturing and expiry dates.");
  const today = manilaDateString(now);
  if (manufacturingDate > today) throw new PolicyError("invalid-batch-edit", "Manufacturing date cannot be in the future.");
  if (manufacturingDate >= expiryDate) throw new PolicyError("invalid-batch-edit", "Manufacturing date must precede expiry.");
  const location = typeof values.location === "string" ? values.location.trim() : "";
  const manufacturer = typeof values.manufacturer === "string" ? values.manufacturer.trim() : "";
  if (!location || location.length > 120 || !manufacturer || manufacturer.length > 120) {
    throw new PolicyError("invalid-batch-edit", "Enter a location and manufacturer (up to 120 characters each).");
  }
  return { inventoryId, expected, values: { batchId, manufacturingDate, expiryDate, location, manufacturer } };
}

async function updateBatchMetadata({ db, FieldValue, uid, email, payload, now }) {
  const input = validateBatchMetadata(payload, now);
  const ref = db.collection("inventory").doc(input.inventoryId);
  return db.runTransaction(async (tx) => {
    const userSnap = await tx.get(db.collection("users").doc(uid));
    const user = userSnap.exists ? userSnap.data() : null;
    if (user?.role !== "admin" || user?.status !== "approved") {
      throw new PolicyError("wrong-role", "Only an approved Admin can edit batch details.");
    }
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PolicyError("inventory-not-found", "That batch no longer exists.");
    const current = snap.data();
    if (current.voided === true) throw new PolicyError("batch-voided", "A voided batch cannot be edited.");
    for (const key of FIELDS) {
      if ((current[key] ?? "") !== input.expected[key]) {
        throw new PolicyError("batch-changed", "Batch details changed while you were editing. Review them and try again.");
      }
    }
    const arrival = isoDateOnly(current.arrivalDate);
    if (arrival && (input.values.manufacturingDate > arrival || input.values.expiryDate <= arrival)) {
      throw new PolicyError("invalid-batch-edit", "Manufacturing must be on or before arrival, and expiry must follow arrival.");
    }
    if (current.batchId !== input.values.batchId) {
      if (current.firstUsedAt || current.usageTracked !== true) {
        throw new PolicyError("batch-id-locked", "Batch ID cannot change after stock has been used or when usage history is unknown.");
      }
      const duplicate = await tx.get(db.collection("inventory").where("batchId", "==", input.values.batchId).limit(1));
      if (!duplicate.empty && duplicate.docs.some((doc) => doc.id !== input.inventoryId)) {
        throw new PolicyError("batch-id-exists", "That batch ID already exists.");
      }
    }
    if (current.expiryDate !== input.values.expiryDate && input.values.expiryDate <= manilaDateString(now)) {
      throw new PolicyError("invalid-batch-edit", "A new expiry date must be after today.");
    }
    // An earlier expiry must not strand orders that already hold this batch
    // for a later delivery: refuse rather than let dispatch find out.
    if (current.expiryDate !== input.values.expiryDate) {
      const holders = await tx.get(db.collection("inventoryReservations")
        .where("inventoryIds", "array-contains", input.inventoryId)
        .limit(MAX_RESERVATIONS_CHECKED + 1));
      if (holders.size > MAX_RESERVATIONS_CHECKED) {
        throw new PolicyError("batch-reservations-too-many", "Too many orders hold this batch to check the new expiry safely. Ask for support.");
      }
      for (const reservation of holders.docs) {
        if (!reservedInventoryIds(reservation.data()).includes(input.inventoryId)) continue;
        const orderSnap = await tx.get(db.collection("orders").doc(reservation.id));
        const order = orderSnap.exists ? orderSnap.data() : null;
        if (!order || CLOSED_ORDER_STATUSES.has(String(order.status ?? "").trim().toLowerCase())) continue;
        const needed = usableThrough(order, now);
        if (input.values.expiryDate < needed) {
          const label = typeof order.orderNumber === "string" && order.orderNumber ? order.orderNumber : "An order";
          throw new PolicyError(
            "batch-expiry-before-reservation",
            `${label} holds this batch for delivery on ${needed}, after the new expiry date. Reschedule or cancel that order first.`
          );
        }
      }
    }
    const changed = Object.fromEntries(FIELDS.filter((key) => (current[key] ?? "") !== input.values[key]).map((key) => [key, input.values[key]]));
    if (!Object.keys(changed).length) return { inventoryId: input.inventoryId, changed: false };
    if (changed.expiryDate) changed.status = statusFromExpiry(input.values.expiryDate, manilaDateString(now));
    const auditRef = db.collection("inventoryAuditEvents").doc();
    tx.update(ref, { ...changed, metadataEditedAt: FieldValue.serverTimestamp(), metadataEditedByUid: uid, updatedAt: FieldValue.serverTimestamp() });
    tx.create(auditRef, {
      schemaVersion: 1, action: "batch_metadata_edited", actorUid: uid, actorEmail: email ?? null,
      actorRole: "admin", at: FieldValue.serverTimestamp(), inventoryId: input.inventoryId,
      before: Object.fromEntries(FIELDS.map((key) => [key, current[key] ?? ""])),
      after: input.values,
    });
    return { inventoryId: input.inventoryId, changed: true };
  });
}

module.exports = { FIELDS, validateBatchMetadata, updateBatchMetadata };
