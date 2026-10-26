"use strict";

/**
 * Admin inventory removal controls — the only ways stock or catalog entries
 * leave active use. Nothing here hard-deletes a document.
 *
 *   setVaccineArchived   Admin   archive / restore a vaccine product. Archived:
 *                                refused for NEW orders and new stock
 *                                (createOrderWithReservation, Add Stock). Existing
 *                                orders, reservations, batches and history stay.
 *   voidInventoryBatch   Admin   mark a mistaken batch voided — only when it
 *                                provably never had downstream use. Kept as an
 *                                audit record; never quoted, allocated or counted.
 *   removeUnusableStock  Admin   damaged / expired / recalled doses:
 *                                  quarantine  free units → quarantined
 *                                  dispose     quarantined units → written off
 *                                Reserved units and returned units awaiting a
 *                                decision are never touched.
 *   correctStockQuantity Admin   fix a RECORDED on-hand figure (data-entry error
 *                                or recount), with a category, a meaningful
 *                                reason and a permanent before/after entry.
 *                                Never below held units; never a decrease on
 *                                an expired batch (that is quarantine/dispose).
 *
 * Every mutation runs in ONE transaction that re-reads the caller's approved
 * Admin profile and the target document, and writes an immutable entry to
 * inventoryAuditEvents (server-only, firestore.rules). Availability is never
 * stored: it stays allocation.allocatableUnits — on hand − reserved −
 * return-pending − quarantined, zero for a voided batch.
 *
 * Retries: archive/restore and void are idempotent by target state (a repeat
 * replays without a second audit entry). Stock removal carries a client
 * request id; the audit entry is keyed by it, so a retried call replays its
 * first result and a reused id with different content is refused. Transient
 * transaction failures are retried a bounded number of times on the server.
 */

const {
  PolicyError,
  validateDocumentId,
  validateRequestId,
  isExpired,
  isoDateOnly,
  isBatchVoided,
  isVaccineArchived,
  MAX_REASON_LENGTH,
  MAX_STOCK_QUANTITY,
} = require("./policy");
const { readCounter, allocateProducts } = require("./allocation");
// The bounded retry for transient transaction failures only (ABORTED, or the
// two named "transaction is no longer valid" INVALID_ARGUMENTs) — the same
// predicate the rider-trip callables use. Safe here because every action is
// idempotent: a retry re-reads its state (or its audit entry) and replays.
const { runTripTransaction: runTransactionWithRetry } = require("./riderDispatchOps");

const USERS = "users";
const VACCINES = "vaccines";
const INVENTORY = "inventory";
const RESERVATIONS = "inventoryReservations";
const RETURNS = "inventoryReturns";
const ALLOCATION_EVENTS = "inventoryAllocationEvents";
const AUDIT = "inventoryAuditEvents";

const REMOVAL_ACTIONS = Object.freeze(["quarantine", "dispose"]);
const REMOVAL_REASONS = Object.freeze(["damaged", "expired", "recalled"]);
const AUDIT_ACTIONS = Object.freeze({
  VACCINE_ARCHIVED: "vaccine_archived",
  VACCINE_RESTORED: "vaccine_restored",
  BATCH_VOIDED: "batch_voided",
  STOCK_QUARANTINED: "stock_quarantined",
  STOCK_DISPOSED: "stock_disposed",
  STOCK_CORRECTED: "stock_corrected",
});

/**
 * Correct Stock fixes a RECORD, never a physical loss of usable doses:
 *   entry_error        the figure was entered wrong (Add Stock typo, double count)
 *   count_discrepancy  a physical recount differs from the record
 * Damaged, expired or recalled doses are not a correction — they leave stock
 * through quarantine → disposal, which keeps the reason and the doses apart.
 */
const CORRECTION_REASON_CODES = Object.freeze(["entry_error", "count_discrepancy"]);
const MIN_CORRECTION_REASON = 10;

// ---------------------------------------------------------------- validation (pure)

function rejectUnknownKeys(payload, allowed) {
  for (const key of Object.keys(payload ?? {})) {
    if (!allowed.includes(key)) throw new PolicyError("unknown-field", `Unexpected field: ${key}.`);
  }
}

/** A required explanation, 3–500 characters. */
function requiredText(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < 3) throw new PolicyError("reason-required", `Please give a ${label} (at least 3 characters).`);
  if (text.length > MAX_REASON_LENGTH) {
    throw new PolicyError("reason-too-long", `Please keep the ${label} under ${MAX_REASON_LENGTH} characters.`);
  }
  return text;
}

/** An optional note: absent/blank → null, otherwise at most 500 characters. */
function optionalText(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new PolicyError("invalid-notes", `The ${label} must be text.`);
  const text = value.trim();
  if (text === "") return null;
  if (text.length > MAX_REASON_LENGTH) {
    throw new PolicyError("invalid-notes", `Please keep the ${label} under ${MAX_REASON_LENGTH} characters.`);
  }
  return text;
}

function validateArchivePayload(payload) {
  rejectUnknownKeys(payload, ["vaccineId", "archived", "reason"]);
  const vaccineId = validateDocumentId(payload?.vaccineId, "That vaccine could not be identified.");
  if (typeof payload?.archived !== "boolean") {
    throw new PolicyError("invalid-archive-request", "Choose whether to archive or restore this vaccine.");
  }
  const archived = payload.archived;
  const reason = archived
    ? requiredText(payload?.reason, "reason for archiving")
    : optionalText(payload?.reason, "reason for restoring");
  return { vaccineId, archived, reason };
}

function validateVoidPayload(payload) {
  rejectUnknownKeys(payload, ["inventoryId", "reason"]);
  return {
    inventoryId: validateDocumentId(payload?.inventoryId, "That batch could not be identified."),
    reason: requiredText(payload?.reason, "reason for voiding this batch"),
  };
}

function validateRemovalPayload(payload) {
  rejectUnknownKeys(payload, ["requestId", "inventoryId", "action", "quantity", "reason", "notes"]);
  const requestId = validateRequestId(payload?.requestId);
  const inventoryId = validateDocumentId(payload?.inventoryId, "That batch could not be identified.");
  if (!REMOVAL_ACTIONS.includes(payload?.action)) {
    throw new PolicyError("invalid-removal-action", "Choose quarantine or dispose.");
  }
  const quantity = payload?.quantity;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_STOCK_QUANTITY) {
    throw new PolicyError("invalid-removal-quantity", "Enter a whole number of doses of at least 1.");
  }
  if (!REMOVAL_REASONS.includes(payload?.reason)) {
    throw new PolicyError("invalid-removal-reason", "Choose damaged, expired or recalled.");
  }
  return {
    requestId,
    inventoryId,
    action: payload.action,
    quantity,
    reason: payload.reason,
    notes: optionalText(payload?.notes, "note"),
  };
}

// ---------------------------------------------------------------- batch counters (pure)

/** The batch's counters, or a refusal when any is not a valid whole number. */
function readBatchCounters(data, inventoryId) {
  const fields = ["quantity", "reservedQuantity", "returnPendingQuantity", "quarantinedQuantity", "writtenOffQuantity"];
  const out = {};
  for (const f of fields) {
    const c = readCounter(data?.[f]);
    if (!c.ok) {
      throw new PolicyError(
        "inventory-invariant-broken",
        "This batch's stock figures are not valid and need review before stock can be removed.",
        { inventoryId, field: f }
      );
    }
    out[f] = c.value;
  }
  const held = out.reservedQuantity + out.returnPendingQuantity + out.quarantinedQuantity;
  if (held > out.quantity) {
    throw new PolicyError(
      "inventory-invariant-broken",
      "This batch holds more reserved, returned and quarantined doses than it has on hand, and needs review.",
      { inventoryId }
    );
  }
  return {
    onHand: out.quantity,
    reserved: out.reservedQuantity,
    returnPending: out.returnPendingQuantity,
    quarantined: out.quarantinedQuantity,
    writtenOff: out.writtenOffQuantity,
    // Units no order, return or quarantine accounts for — the only units
    // quarantine may take. Independent of status and expiry: expired stock is
    // exactly what needs taking out.
    free: out.quantity - held,
  };
}

/**
 * Plan one stock removal against the current counters — PURE.
 * Returns the counter update and the before/after figures for the audit.
 */
function planStockRemoval({ data, inventoryId, action, quantity, reason, now }) {
  if (isBatchVoided(data)) {
    throw new PolicyError("batch-voided", "This batch was voided; it has no stock to remove.", { inventoryId });
  }
  const c = readBatchCounters(data, inventoryId);
  if (reason === "expired") {
    const expiry = isoDateOnly(data?.expiryDate);
    if (expiry === null || !isExpired(expiry, now)) {
      throw new PolicyError(
        "removal-reason-not-applicable",
        "This batch has not expired. Choose damaged or recalled, or check its expiry date.",
        { inventoryId }
      );
    }
  }
  const after = { ...c };
  if (action === "quarantine") {
    if (quantity > c.free) {
      throw new PolicyError(
        "insufficient-free-stock",
        c.free === 0
          ? "No doses on this batch are free to quarantine. Reserved doses and returned doses awaiting a decision cannot be removed here."
          : `Only ${c.free} dose${c.free === 1 ? " is" : "s are"} free to quarantine. Reserved doses and returned doses awaiting a decision cannot be removed here.`,
        { inventoryId, free: c.free }
      );
    }
    after.quarantined = c.quarantined + quantity;
    after.free = c.free - quantity;
  } else {
    if (quantity > c.quarantined) {
      throw new PolicyError(
        "insufficient-quarantined-stock",
        c.quarantined === 0
          ? "This batch has no quarantined doses. Quarantine doses before disposing of them."
          : `Only ${c.quarantined} dose${c.quarantined === 1 ? " is" : "s are"} in quarantine. Quarantine doses before disposing of them.`,
        { inventoryId, quarantined: c.quarantined }
      );
    }
    after.quarantined = c.quarantined - quantity;
    after.onHand = c.onHand - quantity;
    after.writtenOff = c.writtenOff + quantity;
  }
  const update = action === "quarantine"
    ? { quarantinedQuantity: after.quarantined }
    : { quarantinedQuantity: after.quarantined, quantity: after.onHand, writtenOffQuantity: after.writtenOff };
  return { update, before: c, after };
}

/**
 * Can this batch be voided, judged from the document alone — PURE.
 * Returns null when the document proves no downstream use, otherwise the
 * refusal. The transaction ALSO checks the reference collections.
 */
function voidRefusal(data, inventoryId) {
  if (data?.usageTracked !== true) {
    return new PolicyError(
      "batch-usage-unproven",
      "This batch was added before VaxTrack recorded batch usage, so it cannot be proven unused and cannot be voided. To take its doses out of stock, use Remove unusable stock instead.",
      { inventoryId }
    );
  }
  if (data.firstUsedAt) {
    return new PolicyError(
      "batch-in-use",
      "This batch has already been used by an order, so it cannot be voided. To take its doses out of stock, use Remove unusable stock instead.",
      { inventoryId }
    );
  }
  for (const f of ["reservedQuantity", "returnPendingQuantity", "quarantinedQuantity", "writtenOffQuantity"]) {
    const c = readCounter(data[f]);
    if (!c.ok) {
      return new PolicyError("inventory-invariant-broken", "This batch's stock figures are not valid and need review.", { inventoryId, field: f });
    }
    if (c.value > 0) {
      return new PolicyError(
        "batch-in-use",
        "This batch has reserved, returned, quarantined or written-off doses, so it cannot be voided.",
        { inventoryId, field: f }
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------- shared

/** Re-read the caller inside the transaction: an approved Admin, or refused. */
async function requireAdmin(tx, db, uid) {
  const snap = await tx.get(db.collection(USERS).doc(uid));
  const user = snap.exists ? snap.data() : null;
  if (!user) throw new PolicyError("profile-missing", "Your account profile could not be found.");
  if (user.role !== "admin") throw new PolicyError("wrong-role", "Only an Admin can change inventory this way.");
  if (user.status !== "approved") throw new PolicyError("not-approved", "Your account is not approved.");
  return user;
}

function auditBase({ action, uid, email, FieldValue }) {
  return {
    schemaVersion: 1,
    action,
    actorUid: uid,
    actorEmail: email ?? null,
    actorRole: "admin",
    at: FieldValue.serverTimestamp(),
  };
}

// ---------------------------------------------------------------- archive / restore

async function setVaccineArchived({ db, FieldValue, uid, email = null, payload }) {
  const input = validateArchivePayload(payload);
  const ref = db.collection(VACCINES).doc(input.vaccineId);
  return runTransactionWithRetry(db, async (tx) => {
    await requireAdmin(tx, db, uid);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PolicyError("vaccine-not-found", "That vaccine no longer exists.");
    const vaccine = snap.data();
    if (isVaccineArchived(vaccine) === input.archived) {
      return { vaccineId: input.vaccineId, archived: input.archived, replayed: true };
    }
    const now = FieldValue.serverTimestamp();
    tx.update(
      ref,
      input.archived
        ? { archived: true, archivedAt: now, archivedByUid: uid, archivedByEmail: email, archiveReason: input.reason, updatedAt: now }
        : { archived: false, restoredAt: now, restoredByUid: uid, restoredByEmail: email, restoreReason: input.reason, updatedAt: now }
    );
    tx.create(db.collection(AUDIT).doc(), {
      ...auditBase({
        action: input.archived ? AUDIT_ACTIONS.VACCINE_ARCHIVED : AUDIT_ACTIONS.VACCINE_RESTORED,
        uid,
        email,
        FieldValue,
      }),
      vaccineId: input.vaccineId,
      vaccineName: typeof vaccine.vaccineName === "string" ? vaccine.vaccineName : null,
      inventoryId: null,
      batchId: null,
      reason: input.reason,
    });
    return { vaccineId: input.vaccineId, archived: input.archived, replayed: false };
  });
}

// ---------------------------------------------------------------- void

async function voidInventoryBatch({ db, FieldValue, uid, email = null, payload }) {
  const input = validateVoidPayload(payload);
  const ref = db.collection(INVENTORY).doc(input.inventoryId);
  return runTransactionWithRetry(db, async (tx) => {
    await requireAdmin(tx, db, uid);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PolicyError("inventory-not-found", "That batch no longer exists.");
    const batch = snap.data();
    if (isBatchVoided(batch)) return { inventoryId: input.inventoryId, voided: true, replayed: true };
    const refusal = voidRefusal(batch, input.inventoryId);
    if (refusal) throw refusal;
    // Belt and braces: any reservation, return or allocation-history entry that
    // names this batch is downstream use, whatever the marker says. Read in the
    // transaction, so one written concurrently aborts and re-checks this void.
    for (const col of [RESERVATIONS, RETURNS, ALLOCATION_EVENTS]) {
      const hit = await tx.get(db.collection(col).where("inventoryIds", "array-contains", input.inventoryId).limit(1));
      if (!hit.empty) {
        throw new PolicyError(
          "batch-in-use",
          "This batch is referenced by an order's reservation, return or stock history, so it cannot be voided. To take its doses out of stock, use Remove unusable stock instead.",
          { inventoryId: input.inventoryId, collection: col }
        );
      }
    }
    const quantity = readCounter(batch.quantity);
    tx.update(ref, {
      voided: true,
      voidedAt: FieldValue.serverTimestamp(),
      voidedByUid: uid,
      voidedByEmail: email,
      voidReason: input.reason,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.create(db.collection(AUDIT).doc(), {
      ...auditBase({ action: AUDIT_ACTIONS.BATCH_VOIDED, uid, email, FieldValue }),
      vaccineId: typeof batch.vaccineId === "string" ? batch.vaccineId : null,
      vaccineName: typeof batch.vaccineName === "string" ? batch.vaccineName : null,
      inventoryId: input.inventoryId,
      batchId: typeof batch.batchId === "string" ? batch.batchId : null,
      // The recorded on-hand figure is kept on the batch as it was entered;
      // a voided batch is never stock, whatever that figure says.
      quantityAtVoid: quantity.ok ? quantity.value : null,
      reason: input.reason,
    });
    return { inventoryId: input.inventoryId, voided: true, replayed: false };
  });
}

// ---------------------------------------------------------------- quarantine / dispose

/** The audit id for one removal request — per Admin, so ids cannot collide across callers. */
function removalAuditId(uid, requestId) {
  return `stock_${uid}_${requestId}`;
}

async function removeUnusableStock({ db, FieldValue, uid, email = null, payload, now }) {
  const input = validateRemovalPayload(payload);
  const ref = db.collection(INVENTORY).doc(input.inventoryId);
  const auditRef = db.collection(AUDIT).doc(removalAuditId(uid, input.requestId));
  const action = input.action === "quarantine" ? AUDIT_ACTIONS.STOCK_QUARANTINED : AUDIT_ACTIONS.STOCK_DISPOSED;
  return runTransactionWithRetry(db, async (tx) => {
    await requireAdmin(tx, db, uid);
    const prior = await tx.get(auditRef);
    if (prior.exists) {
      const p = prior.data();
      const same = p.action === action && p.inventoryId === input.inventoryId && p.quantity === input.quantity && p.reason === input.reason;
      if (!same) {
        throw new PolicyError(
          "idempotency-conflict",
          "This request was already used for a different stock change. Nothing was changed — please try again."
        );
      }
      return { inventoryId: input.inventoryId, action: input.action, quantity: input.quantity, after: p.after ?? null, replayed: true };
    }
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PolicyError("inventory-not-found", "That batch no longer exists.");
    const batch = snap.data();
    const plan = planStockRemoval({ data: batch, inventoryId: input.inventoryId, ...input, now });
    tx.update(ref, { ...plan.update, lastStockRemovalAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    tx.create(auditRef, {
      ...auditBase({ action, uid, email, FieldValue }),
      requestId: input.requestId,
      vaccineId: typeof batch.vaccineId === "string" ? batch.vaccineId : null,
      vaccineName: typeof batch.vaccineName === "string" ? batch.vaccineName : null,
      inventoryId: input.inventoryId,
      batchId: typeof batch.batchId === "string" ? batch.batchId : null,
      quantity: input.quantity,
      reason: input.reason,
      notes: input.notes,
      before: plan.before,
      after: plan.after,
    });
    return { inventoryId: input.inventoryId, action: input.action, quantity: input.quantity, after: plan.after, replayed: false };
  });
}

// ---------------------------------------------------------------- correct stock

function validateCorrectionPayload(payload) {
  rejectUnknownKeys(payload, ["requestId", "inventoryId", "expectedQuantity", "newQuantity", "reasonCode", "reason"]);
  const requestId = validateRequestId(payload?.requestId);
  const inventoryId = validateDocumentId(payload?.inventoryId, "That batch could not be identified.");
  const newQuantity = payload?.newQuantity;
  if (!Number.isInteger(newQuantity) || newQuantity < 0 || newQuantity > MAX_STOCK_QUANTITY) {
    throw new PolicyError("invalid-correction-quantity", "Enter the corrected quantity as a whole number of doses (0 or more).");
  }
  // The on-hand figure the Admin was looking at, exactly as stored (a legacy
  // batch may hold text) — so a figure that moved since is never overwritten.
  const expected = payload?.expectedQuantity;
  if (!(expected === null || typeof expected === "string" || Number.isInteger(expected))) {
    throw new PolicyError("invalid-correction-request", "The current figure for this batch is missing. Reload and try again.");
  }
  if (!CORRECTION_REASON_CODES.includes(payload?.reasonCode)) {
    throw new PolicyError("invalid-correction-reason", "Choose whether this fixes a data-entry error or a physical count difference.");
  }
  const reason = typeof payload?.reason === "string" ? payload.reason.trim() : "";
  if (reason.length < MIN_CORRECTION_REASON) {
    throw new PolicyError(
      "reason-required",
      `Explain the correction in at least ${MIN_CORRECTION_REASON} characters — what was wrong and how the right figure was confirmed.`
    );
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new PolicyError("reason-too-long", `Please keep the reason under ${MAX_REASON_LENGTH} characters.`);
  }
  return { requestId, inventoryId, expectedQuantity: expected, newQuantity, reasonCode: payload.reasonCode, reason };
}

/**
 * Plan one correction against the stored batch — PURE. Returns the counter
 * update, before/after figures and whether availability may have grown.
 */
function planStockCorrection({ data, inventoryId, expectedQuantity, newQuantity, now }) {
  if (isBatchVoided(data)) {
    throw new PolicyError("batch-voided", "This batch was voided; its figures cannot be corrected.", { inventoryId });
  }
  const stored = data?.quantity ?? null;
  if (stored !== expectedQuantity) {
    throw new PolicyError(
      "stock-changed",
      "This batch's on-hand figure changed while you were correcting it. Review the current figures, then try again.",
      { inventoryId }
    );
  }
  const held = {};
  for (const f of ["reservedQuantity", "returnPendingQuantity", "quarantinedQuantity", "writtenOffQuantity"]) {
    const c = readCounter(data?.[f]);
    if (!c.ok) {
      throw new PolicyError("inventory-invariant-broken", "This batch's held figures are not valid and need review.", { inventoryId, field: f });
    }
    held[f] = c.value;
  }
  const current = readCounter(stored);
  const currentValue = current.ok ? current.value : null; // null: a corrupt (e.g. text) figure being fixed
  if (currentValue !== null && newQuantity === currentValue) {
    throw new PolicyError("correction-unchanged", "The corrected quantity is the same as the current quantity — nothing to change.", { inventoryId });
  }
  const floor = held.reservedQuantity + held.returnPendingQuantity + held.quarantinedQuantity;
  if (newQuantity < floor) {
    throw new PolicyError(
      "correction-below-held",
      `This batch holds ${floor} dose${floor === 1 ? "" : "s"} that are reserved, returned awaiting a decision, or quarantined, so on hand cannot be set below ${floor}.`,
      { inventoryId, floor }
    );
  }
  // Expired doses are unusable physical stock: they leave through quarantine
  // and disposal (with their own audit), never through a quiet correction.
  const expiry = isoDateOnly(data?.expiryDate);
  if (currentValue !== null && newQuantity < currentValue && expiry !== null && isExpired(expiry, now)) {
    throw new PolicyError(
      "correction-expired-decrease",
      "This batch has expired. Expired doses must leave stock through Remove unusable stock (quarantine, then dispose), not a correction.",
      { inventoryId }
    );
  }
  const counters = (onHand) => ({
    onHand,
    reserved: held.reservedQuantity,
    returnPending: held.returnPendingQuantity,
    quarantined: held.quarantinedQuantity,
    writtenOff: held.writtenOffQuantity,
  });
  return {
    update: { quantity: newQuantity, previousQuantity: stored },
    before: counters(currentValue),
    after: counters(newQuantity),
    change: currentValue === null ? null : newQuantity - currentValue,
    mayFreeStock: currentValue === null || newQuantity > currentValue,
  };
}

function correctionAuditId(uid, requestId) {
  return `correction_${uid}_${requestId}`;
}

/**
 * Admin: correct a batch's on-hand figure (a data-entry error or a recount).
 * One transaction: the Admin, the batch as it is NOW, the stale-figure check,
 * the held-units floor, the expired-stock rule, the batch update and a
 * permanent before/after audit entry. Stock freed by an upward correction is
 * offered to waiting orders straight after, as Add Stock does.
 */
async function correctStockQuantity({ db, FieldValue, uid, email = null, payload, now }) {
  const input = validateCorrectionPayload(payload);
  const ref = db.collection(INVENTORY).doc(input.inventoryId);
  const auditRef = db.collection(AUDIT).doc(correctionAuditId(uid, input.requestId));
  const result = await runTransactionWithRetry(db, async (tx) => {
    await requireAdmin(tx, db, uid);
    const prior = await tx.get(auditRef);
    if (prior.exists) {
      const p = prior.data();
      const same = p.action === AUDIT_ACTIONS.STOCK_CORRECTED && p.inventoryId === input.inventoryId
        && p.after?.onHand === input.newQuantity && p.reasonCode === input.reasonCode;
      if (!same) {
        throw new PolicyError(
          "idempotency-conflict",
          "This request was already used for a different stock change. Nothing was changed — please try again."
        );
      }
      return { inventoryId: input.inventoryId, newQuantity: input.newQuantity, replayed: true, productKey: null };
    }
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PolicyError("inventory-not-found", "That batch no longer exists.");
    const batch = snap.data();
    const plan = planStockCorrection({ data: batch, inventoryId: input.inventoryId, ...input, now });
    const at = FieldValue.serverTimestamp();
    tx.update(ref, {
      ...plan.update,
      quantityCorrectionCode: input.reasonCode,
      quantityCorrectionReason: input.reason,
      quantityCorrectedAt: at,
      quantityCorrectedByUid: uid,
      quantityCorrectedByEmail: email,
      updatedAt: at,
    });
    tx.create(auditRef, {
      ...auditBase({ action: AUDIT_ACTIONS.STOCK_CORRECTED, uid, email, FieldValue }),
      requestId: input.requestId,
      vaccineId: typeof batch.vaccineId === "string" ? batch.vaccineId : null,
      vaccineName: typeof batch.vaccineName === "string" ? batch.vaccineName : null,
      inventoryId: input.inventoryId,
      batchId: typeof batch.batchId === "string" ? batch.batchId : null,
      // The stored figure before, exactly as it was (even a corrupt text value).
      previousQuantity: plan.update.previousQuantity,
      quantity: plan.change,
      reasonCode: input.reasonCode,
      reason: input.reason,
      before: plan.before,
      after: plan.after,
    });
    return {
      inventoryId: input.inventoryId,
      newQuantity: input.newQuantity,
      replayed: false,
      productKey: plan.mayFreeStock && typeof batch.vaccineId === "string" && batch.vaccineId ? batch.vaccineId : null,
    };
  });
  let reallocated = [];
  if (result.productKey) {
    const runs = await allocateProducts({
      db,
      FieldValue,
      productKeys: [result.productKey],
      now,
      source: { operation: "correctStockQuantity", triggeredBy: { uid, role: "admin" } },
    });
    reallocated = runs.flatMap((r) => r.allocations);
  }
  const { productKey, ...rest } = result;
  void productKey;
  return { ...rest, reallocated };
}

module.exports = {
  AUDIT,
  AUDIT_ACTIONS,
  REMOVAL_ACTIONS,
  REMOVAL_REASONS,
  CORRECTION_REASON_CODES,
  MIN_CORRECTION_REASON,
  validateCorrectionPayload,
  planStockCorrection,
  correctionAuditId,
  correctStockQuantity,
  validateArchivePayload,
  validateVoidPayload,
  validateRemovalPayload,
  readBatchCounters,
  planStockRemoval,
  voidRefusal,
  removalAuditId,
  setVaccineArchived,
  voidInventoryBatch,
  removeUnusableStock,
};
