"use strict";

const { PolicyError } = require("./policy");

const MAX_ORDERS = 20;
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;

/** Return only the current display names of the Med Reps who own these orders. */
async function getOrderMedRepNames({ db, uid, payload }) {
  const callerSnap = await db.collection("users").doc(uid).get();
  const caller = callerSnap.exists ? callerSnap.data() : null;
  if (!caller) throw new PolicyError("profile-missing", "Your account profile could not be found.");
  if (!['admin', 'dispatcher'].includes(text(caller.role)?.toLowerCase())) {
    throw new PolicyError("wrong-role", "Your account is not allowed to view Med Rep names for orders.");
  }
  if (text(caller.status)?.toLowerCase() !== "approved") {
    throw new PolicyError("not-approved", "Your account is not approved.");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PolicyError("invalid-payload", "Choose up to 20 valid orders to look up.");
  }
  const ids = payload.orderIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_ORDERS ||
      ids.some((id) => typeof id !== "string" || !id.trim() || id !== id.trim() || id.includes("/") || id.length > 960)) {
    throw new PolicyError("invalid-payload", "Choose up to 20 valid orders to look up.");
  }
  if (Object.keys(payload).some((key) => key !== "orderIds")) {
    throw new PolicyError("unknown-field", "This lookup only accepts order IDs.");
  }

  const orderIds = [...new Set(ids)];
  const orderSnaps = await Promise.all(orderIds.map((id) => db.collection("orders").doc(id).get()));
  const ownerIds = [...new Set(orderSnaps
    .filter((snap) => snap.exists)
    .map((snap) => text(snap.data().createdByUid))
    .filter((id) => id && !id.includes("/")))];
  const ownerSnaps = await Promise.all(ownerIds.map((id) => db.collection("users").doc(id).get()));
  const ownerNames = new Map(ownerIds.map((id, index) => {
    const owner = ownerSnaps[index].exists ? ownerSnaps[index].data() : null;
    return [id, text(owner?.name) ?? text(owner?.fullName) ?? text(owner?.displayName) ?? null];
  }));

  const names = Object.create(null);
  orderSnaps.forEach((snap, index) => {
    if (!snap.exists) return;
    const name = ownerNames.get(text(snap.data().createdByUid));
    if (name) names[orderIds[index]] = name;
  });
  return { names };
}

module.exports = { getOrderMedRepNames, MAX_ORDERS };
