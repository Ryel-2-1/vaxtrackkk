"use strict";

const {
  DESTINATION_VERSION, HOME_ADDRESS_ID, PolicyError,
  buildOrderDestinationSnapshot, validateDocumentId, validateReason,
} = require("./policy");
const { loadUser, requireRole } = require("./operations");

const CORRECTABLE_STATUSES = new Set([
  "pending_dispatch", "assigned", "loading", "delivery_failed",
]);
const DESTINATION_FIELDS = [
  "destinationVersion", "doctorId", "doctorName", "doctorAddressId",
  "destinationType", "destinationName", "deliveryAddress",
  "destinationAreaId", "destinationArea", "destinationLat", "destinationLng",
  "destinationGeofenceRadiusM", "destinationLocationVerified",
  "clinicDocId", "clinicId", "clinicName", "clinicAddress", "clinicLat",
  "clinicLng", "clinicGeofenceRadiusM", "clinicLocationVerified",
  "clinicLocationUpdatedAt",
];

function snapshotDestination(order) {
  return Object.fromEntries(
    DESTINATION_FIELDS.filter((key) => Object.hasOwn(order, key))
      .map((key) => [key, order[key]])
  );
}

function revisionOf(order) {
  const revision = order.destinationRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new PolicyError("destination-changed", "Refresh this order before reviewing its destination.");
  }
  return revision;
}

function assertCorrectable(order) {
  if (order.destinationVersion !== DESTINATION_VERSION || !order.doctorId) {
    throw new PolicyError("destination-legacy", "This order needs Admin review before its destination can be changed.");
  }
  if (!CORRECTABLE_STATUSES.has(order.status)) {
    throw new PolicyError(
      "invalid-status-transition", "The destination can only change before transit or during failed-delivery recovery."
    );
  }
}

function requirePayload(payload, allowed) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).some((key) => !allowed.includes(key))) {
    throw new PolicyError("unknown-field", "The destination request contains unexpected fields.");
  }
}

/** Use the checkout policy against server-read Doctor, address and Area data. */
async function readProposedDestination(tx, db, order, addressId) {
  const doctorId = validateDocumentId(order.doctorId, "The order's doctor is invalid.");
  const doctorRef = db.collection("doctors").doc(doctorId);
  const relationshipRef = doctorRef.collection("deliveryAddresses").doc(addressId);
  const doctorSnap = await tx.get(doctorRef);
  const relationshipSnap = await tx.get(relationshipRef);
  if (!relationshipSnap.exists) {
    throw new PolicyError("destination-not-found", "That address is no longer linked to this doctor.");
  }
  let clinic = null;
  let areaId;
  if (addressId === HOME_ADDRESS_ID) {
    areaId = validateDocumentId(relationshipSnap.data().areaId, "That Home address needs a valid Area.");
  } else {
    const clinicSnap = await tx.get(db.collection("clinics").doc(addressId));
    clinic = clinicSnap.exists ? clinicSnap.data() : null;
    if (!clinic) throw new PolicyError("clinic-not-found", "The selected clinic no longer exists.");
    areaId = validateDocumentId(clinic.areaId, "That clinic needs a valid Area.");
  }
  const areaSnap = await tx.get(db.collection("areas").doc(areaId));
  return buildOrderDestinationSnapshot({
    doctorId, doctorAddressId: addressId,
    doctor: doctorSnap.exists ? doctorSnap.data() : null,
    relationship: relationshipSnap.data(), clinic,
    area: areaSnap.exists ? areaSnap.data() : null,
  });
}

/** A Dispatcher proposes an address; this never changes the order destination. */
async function requestOrderDestinationChange({ db, FieldValue, uid, payload }) {
  requireRole(await loadUser(db, uid), "dispatcher");
  requirePayload(payload, ["orderId", "doctorAddressId", "reason", "expectedRevision"]);
  const orderId = validateDocumentId(payload.orderId, "Select an order to correct.");
  const addressId = validateDocumentId(payload.doctorAddressId, "Select a linked address.");
  const reason = validateReason(payload.reason, "reason for changing this destination");
  if (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 0) {
    throw new PolicyError("invalid-revision", "Refresh the shipment before requesting a change.");
  }

  const orderRef = db.collection("orders").doc(orderId);
  const requestRef = orderRef.collection("destinationChangeRequests").doc();
  return db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new PolicyError("order-not-found", "That order no longer exists.");
    const order = orderSnap.data();
    assertCorrectable(order);
    if (!order.createdByUid) {
      throw new PolicyError("order-owner-missing", "This order has no Med Rep to review a destination change.");
    }
    const ownerSnap = await tx.get(db.collection("users").doc(order.createdByUid));
    const owner = ownerSnap.exists ? ownerSnap.data() : null;
    if (typeof owner?.role !== "string" || owner.role.trim().toLowerCase() !== "salesrep" ||
        typeof owner?.status !== "string" || owner.status.trim().toLowerCase() !== "approved") {
      throw new PolicyError("order-owner-missing", "The Med Rep for this order cannot review destination changes. Ask Admin for help.");
    }
    const revision = revisionOf(order);
    if (revision !== payload.expectedRevision) {
      throw new PolicyError("destination-changed", "The destination changed. Refresh this shipment and try again.");
    }
    if (order.destinationChangeRequest) {
      throw new PolicyError("destination-request-pending", "A destination request already awaits the Med Rep's decision.");
    }
    if (order.doctorAddressId === addressId) {
      throw new PolicyError("destination-unchanged", "Choose a different address for this doctor.");
    }

    const invoiceSnap = await tx.get(db.collection("invoices").doc(orderId));
    if (invoiceSnap.exists && invoiceSnap.data().invoiceStatus === "issued") {
      throw new PolicyError("invoice-already-issued", "An issued invoice already records this destination. Ask Admin to review the order.");
    }
    const destination = await readProposedDestination(tx, db, order, addressId);
    const stamp = FieldValue.serverTimestamp();
    tx.create(requestRef, {
      orderId, doctorId: order.doctorId, status: "pending", baseRevision: revision,
      previous: snapshotDestination(order), proposed: snapshotDestination(destination.orderFields),
      reason, requestedByUid: uid, requestedAt: stamp,
    });
    tx.update(orderRef, {
      destinationChangeRequest: {
        id: requestRef.id, baseRevision: revision,
        proposed: destination.response, reason,
        requestedByUid: uid, requestedAt: stamp,
      },
      updatedAt: stamp,
    });
    return { orderId, requestId: requestRef.id, status: "pending" };
  });
}

function assertProposalStillMatches(request, destination) {
  const proposed = snapshotDestination(destination.orderFields);
  const stored = request.proposed;
  if (!stored || Object.keys(stored).length !== Object.keys(proposed).length ||
      Object.entries(proposed).some(([key, value]) => !Object.is(stored[key], value))) {
    throw new PolicyError(
      "destination-request-stale",
      "The proposed address changed since the request. Reject it and ask Dispatcher to send a new request."
    );
  }
}

/** Only the Med Rep who placed this order may approve or reject its request. */
async function reviewOrderDestinationChange({ db, FieldValue, uid, payload }) {
  requireRole(await loadUser(db, uid), "salesrep");
  requirePayload(payload, ["orderId", "requestId", "decision"]);
  const orderId = validateDocumentId(payload.orderId, "Select an order to review.");
  const requestId = validateDocumentId(payload.requestId, "Select a destination request.");
  if (payload.decision !== "approve" && payload.decision !== "reject") {
    throw new PolicyError("invalid-decision", "Approve or reject the destination request.");
  }
  const orderRef = db.collection("orders").doc(orderId);
  const requestRef = orderRef.collection("destinationChangeRequests").doc(requestId);
  return db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw new PolicyError("order-not-found", "That order no longer exists.");
    const order = orderSnap.data();
    if (order.createdByUid !== uid) {
      throw new PolicyError("not-order-owner", "Only the Med Rep who placed this order can review its destination.");
    }
    const requestSnap = await tx.get(requestRef);
    if (!requestSnap.exists) throw new PolicyError("destination-request-not-found", "That request no longer exists.");
    const request = requestSnap.data();
    const completedStatus = payload.decision === "approve" ? "approved" : "rejected";
    if (request.status === completedStatus && request.reviewedByUid === uid) {
      return { orderId, requestId, status: completedStatus, replayed: true };
    }
    if (request.status !== "pending" || order.destinationChangeRequest?.id !== requestId) {
      throw new PolicyError("destination-request-changed", "This request has already changed. Refresh the order.");
    }

    const stamp = FieldValue.serverTimestamp();
    if (payload.decision === "reject") {
      tx.update(requestRef, { status: "rejected", reviewedByUid: uid, reviewedAt: stamp });
      tx.update(orderRef, { destinationChangeRequest: FieldValue.delete(), updatedAt: stamp });
      return { orderId, requestId, status: "rejected", replayed: false };
    }

    assertCorrectable(order);
    const revision = revisionOf(order);
    if (revision !== request.baseRevision || revision !== order.destinationChangeRequest.baseRevision ||
        request.doctorId !== order.doctorId ||
        request.proposed?.doctorAddressId === order.doctorAddressId) {
      throw new PolicyError("destination-request-stale", "This request no longer matches the order. Reject it and ask Dispatcher to try again.");
    }
    const invoiceSnap = await tx.get(db.collection("invoices").doc(orderId));
    if (invoiceSnap.exists && invoiceSnap.data().invoiceStatus === "issued") {
      throw new PolicyError("invoice-already-issued", "An invoice was issued. Reject this request and ask Admin to review the order.");
    }
    const addressId = validateDocumentId(request.proposed.doctorAddressId, "The requested address is invalid.");
    const destination = await readProposedDestination(tx, db, order, addressId);
    assertProposalStillMatches(request, destination);

    const nextRevision = revision + 1;
    const eventRef = orderRef.collection("destinationCorrections").doc(`revision-${nextRevision}`);
    tx.create(eventRef, {
      revision: nextRevision, requestId,
      previous: snapshotDestination(order), current: snapshotDestination(destination.orderFields),
      previousSnapshotAt: order.destinationSnapshotAt ?? null,
      orderStatus: order.status, reason: request.reason,
      requestedByUid: request.requestedByUid, requestedAt: request.requestedAt,
      approvedByUid: uid, correctedByUid: uid, correctedAt: stamp,
    });
    tx.update(requestRef, { status: "approved", reviewedByUid: uid, reviewedAt: stamp });
    tx.update(orderRef, {
      ...destination.orderFields,
      ...(!destination.orderFields.clinicId && Object.hasOwn(order, "clinicId")
        ? { clinicId: FieldValue.delete() } : {}),
      ...(Object.hasOwn(order, "clinicLocationUpdatedAt")
        ? { clinicLocationUpdatedAt: FieldValue.delete() } : {}),
      destinationRevision: nextRevision,
      destinationSnapshotAt: stamp, clinicLocationSnapshotAt: stamp,
      destinationCorrectedAt: stamp, destinationCorrectedByUid: uid,
      destinationChangeRequest: FieldValue.delete(),
      // Keep the old route until approval; then clear it with the address.
      routePolyline: FieldValue.delete(),
      routeDistanceMeters: FieldValue.delete(),
      routeDurationSeconds: FieldValue.delete(),
      routeEtaText: FieldValue.delete(),
      routeGeneratedAt: FieldValue.delete(),
      routeProvider: FieldValue.delete(),
      routeDestinationRevision: FieldValue.delete(),
      updatedAt: stamp,
    });
    return { orderId, requestId, status: "approved", revision: nextRevision, replayed: false };
  });
}

module.exports = { requestOrderDestinationChange, reviewOrderDestinationChange, CORRECTABLE_STATUSES };
