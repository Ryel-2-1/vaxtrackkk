import { getFunctions, httpsCallable } from "firebase/functions";
import { collection, limit, query, where } from "firebase/firestore";
import app, { db } from "../firebase";
import { UserMessageError } from "./userMessageError.js";
import { listenLive } from "./liveSnapshot.js";
import { logSafeError } from "./liveDataErrors.js";
import { newRequestId } from "./orderDraftRequest";

/**
 * Admin inventory removal controls — client side of the trusted boundary
 * (functions/src/inventoryRemoval.js). Archive/restore, void and stock removal
 * are server callables only: firestore.rules refuse every direct write to the
 * fields involved, and every hard delete of a vaccine or batch.
 */
const FUNCTIONS_REGION = "asia-southeast1";
const AUDIT = "inventoryAuditEvents";

function callables() {
  const fns = getFunctions(app, FUNCTIONS_REGION);
  return {
    archive: httpsCallable(fns, "setVaccineArchived"),
    voidBatch: httpsCallable(fns, "voidInventoryBatch"),
    remove: httpsCallable(fns, "removeUnusableStock"),
    correct: httpsCallable(fns, "correctStockQuantity"),
  };
}

/** A refusal or failure from one of these callables, with the server's stable code. */
export class InventoryRemovalError extends UserMessageError {
  constructor(code, message, info = null) {
    super(message);
    this.name = "InventoryRemovalError";
    this.code = code;
    this.info = info;
  }
}

function rethrow(error) {
  const details = error?.details;
  if (details && typeof details.code === "string") {
    throw new InventoryRemovalError(details.code, error.message, details.info ?? null);
  }
  if (error?.code === "functions/unauthenticated") {
    throw new InventoryRemovalError("unauthenticated", "Your session has expired. Please sign in again.");
  }
  // Network, region mismatch or the function unavailable: the outcome is not
  // known, so say so plainly. Retrying is safe — every action is idempotent.
  throw new InventoryRemovalError(
    "service-unavailable",
    "The inventory service could not be reached, so the change may not have been saved. Check the batch, then try again."
  );
}

/** Archive (`archived: true`, reason required) or restore a vaccine product. */
export async function setVaccineArchived({ vaccineId, archived, reason }) {
  try {
    const trimmed = typeof reason === "string" ? reason.trim() : "";
    const result = await callables().archive({ vaccineId, archived, ...(trimmed ? { reason: trimmed } : {}) });
    return result.data;
  } catch (error) {
    return rethrow(error);
  }
}

/** Void a mistaken, provably unused batch. Refused (with the reason) otherwise. */
export async function voidInventoryBatch({ inventoryId, reason }) {
  try {
    const result = await callables().voidBatch({ inventoryId, reason: typeof reason === "string" ? reason.trim() : reason });
    return result.data;
  } catch (error) {
    return rethrow(error);
  }
}

/**
 * Quarantine free doses or dispose of quarantined ones. `requestId` identifies
 * this ATTEMPT: pass the same one when retrying an uncertain call so the server
 * replays instead of removing twice. A new one is generated when omitted.
 */
export async function removeUnusableStock({ requestId = newRequestId(), inventoryId, action, quantity, reason, notes }) {
  try {
    const note = typeof notes === "string" ? notes.trim() : "";
    const result = await callables().remove({
      requestId,
      inventoryId,
      action,
      quantity,
      reason,
      ...(note ? { notes: note } : {}),
    });
    return result.data;
  } catch (error) {
    return rethrow(error);
  }
}

/**
 * Correct a batch's RECORDED on-hand figure (a data-entry error or a recount).
 * `expectedQuantity` is the stored figure the Admin was looking at, exactly as
 * stored — the server refuses if it has moved since. Damaged, expired or
 * recalled doses are not a correction: use removeUnusableStock. Pass the same
 * `requestId` when retrying an uncertain call; the server replays it.
 * Resolves `{ inventoryId, newQuantity, replayed, reallocated }`.
 */
export async function correctStockQuantity({
  requestId = newRequestId(),
  inventoryId,
  expectedQuantity,
  newQuantity,
  reasonCode,
  reason,
}) {
  try {
    const result = await callables().correct({
      requestId,
      inventoryId,
      expectedQuantity: expectedQuantity ?? null,
      newQuantity,
      reasonCode,
      reason: typeof reason === "string" ? reason.trim() : reason,
    });
    return result.data;
  } catch (error) {
    return rethrow(error);
  }
}

export { newRequestId };

const MAX_BATCH_AUDIT = 50;

function millisOf(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

/**
 * Admin: the removal audit entries for one batch, newest first. A single
 * equality filter (no composite index); sorted here.
 */
export function subscribeBatchAuditEvents(inventoryId, callback, onError) {
  return listenLive(
    query(collection(db, AUDIT), where("inventoryId", "==", inventoryId), limit(MAX_BATCH_AUDIT)),
    (snap) =>
      callback(
        snap.docs
          .map((d) => ({ ...d.data(), id: d.id }))
          .sort((a, b) => millisOf(b.at) - millisOf(a.at))
      ),
    (error) => {
      logSafeError("subscribeBatchAuditEvents", error);
      if (onError) onError(error);
    }
  );
}
