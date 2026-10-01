/**
 * The Med Rep order draft: a user-scoped cart, and the request ID + submission
 * snapshot of the checkout attempt made from it.
 *
 * `createOrderWithReservation` is idempotent per request ID: a repeat of the
 * same ID replays the original order instead of creating (and reserving) a
 * second one. That protection only works if the client sends the SAME ID for
 * the same attempt — including after a refresh that follows a lost response.
 * This module is the ONLY place the draft's storage rules live:
 *
 *  - Carts are stored per signed-in user, so one Med Rep can never load, edit
 *    or submit another's cart. An old unscoped cart is migrated once.
 *  - Before the callable runs, the request ID AND a snapshot of everything the
 *    rep is submitting are written to durable storage and read back. If that
 *    cannot be verified, nothing is sent: an ID that cannot survive a refresh
 *    is exactly the defect being fixed, so there is no memory-only fallback.
 *  - A retry is allowed only when the checkout still matches the saved
 *    attempt. The server's fingerprint ignores priority, instructions and the
 *    requested date, so a changed retry would be silently replayed as the
 *    ORIGINAL order; it is refused here instead, and the ID is never rotated
 *    except by the rep's explicit discard.
 *  - Confirmed success clears the cart, the ID and the snapshot together.
 *
 * The server's idempotency key and fingerprint remain the authority; nothing
 * here weakens them. PURE: no Firebase, no network — storage is injected.
 */

/** Pre-scoping cart key. Read only to migrate an old cart, never written. */
export const LEGACY_CART_KEY = "salesRepQuickCart";
const CART_KEY_PREFIX = "salesRepQuickCart:";
const ATTEMPT_KEY_PREFIX = "salesRepOrderAttempt:";
const ATTEMPT_VERSION = 1;
const MAX_UID_LENGTH = 128;

export const STORAGE_UNAVAILABLE_MESSAGE =
  "Your order draft could not be saved safely. Enable browser storage and try again.";
export const UNAUTHENTICATED_MESSAGE =
  "Your session has expired. Sign in again before placing an order.";

/**
 * Mirrors `validateRequestId` in functions/src/policy.js — the server refuses
 * anything else, so a stored value outside this shape is never sent.
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** A refused draft operation. `code` is stable; `message` is shown as-is. */
export class OrderDraftError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "OrderDraftError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * A cryptographically random, URL-safe request ID: 24 random bytes as
 * base64url (32 characters) — the convention the checkout has always used.
 */
export function newRequestId(fillRandom = (bytes) => crypto.getRandomValues(bytes)) {
  const bytes = new Uint8Array(24);
  fillRandom(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** True only for a request ID the server would accept. */
export function isValidRequestId(value) {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

function requireUid(uid) {
  if (
    typeof uid !== "string" ||
    uid.trim() === "" ||
    uid !== uid.trim() ||
    uid.length > MAX_UID_LENGTH
  ) {
    throw new OrderDraftError("unauthenticated", UNAUTHENTICATED_MESSAGE);
  }
  return uid;
}

/** The storage key holding [uid]'s cart. */
export function cartStorageKey(uid) {
  return CART_KEY_PREFIX + requireUid(uid);
}

/** The storage key holding [uid]'s pending checkout attempt. */
export function attemptStorageKey(uid) {
  return ATTEMPT_KEY_PREFIX + requireUid(uid);
}

// Storage can throw (private browsing, quota, disabled site data). Reads and
// removals degrade; writes report whether they verifiably landed.
function safeGet(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function safeRemove(storage, key) {
  try {
    storage?.removeItem(key);
  } catch {
    // nothing to do — a value that cannot be removed cannot be read either
  }
}
/** Write, then read back: true only when the stored text is exactly [text]. */
function persistVerified(storage, key, text) {
  try {
    storage.setItem(key, text);
  } catch {
    return false;
  }
  return safeGet(storage, key) === text;
}
function parseJson(text) {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- the cart

function isCartDraft(value) {
  return Boolean(value) && typeof value === "object" && Array.isArray(value.items);
}

/**
 * [uid]'s saved cart, or null.
 *
 * LEGACY COMPATIBILITY RULE: a cart saved before carts were user-scoped (the
 * bare `salesRepQuickCart` key) has no recorded owner. It is migrated ONCE, to
 * the first signed-in Med Rep who opens the order flow while having no cart of
 * their own: it is written under their key, verified, and only then is the
 * unscoped record removed — so no other account can migrate it afterwards. A
 * user who already has their own cart never claims the legacy one; it is left
 * untouched rather than deleted. If the migration cannot be verified, nothing
 * is loaded and nothing is removed.
 */
export function loadCartDraft(storage, uid) {
  const key = cartStorageKey(uid);
  const own = parseJson(safeGet(storage, key));
  if (isCartDraft(own) && own.ownerUid === uid) {
    return { draft: own, migrated: false };
  }
  if (own !== null) return { draft: null, migrated: false }; // unreadable or foreign — refused

  const legacy = parseJson(safeGet(storage, LEGACY_CART_KEY));
  if (!isCartDraft(legacy)) return { draft: null, migrated: false };

  const claimed = { ...legacy, ownerUid: uid, migratedFromLegacyAt: new Date().toISOString() };
  if (!persistVerified(storage, key, JSON.stringify(claimed))) {
    return { draft: null, migrated: false };
  }
  safeRemove(storage, LEGACY_CART_KEY);
  return { draft: claimed, migrated: true };
}

/** Save [draft] as [uid]'s cart. Returns true only when verifiably stored. */
export function saveCartDraft(storage, uid, draft) {
  const key = cartStorageKey(uid);
  return persistVerified(storage, key, JSON.stringify({ ...draft, ownerUid: uid }));
}

/**
 * Mirror checkout's quantity edits and removals into [uid]'s saved cart,
 * matched by inventory document id, preserving every other stored field — so a
 * refresh restores exactly what was last on screen. A cart with a line that
 * has no inventory id (built before batch tracking) is left untouched, and a
 * cart cleared by a confirmed order is never recreated. Returns true when the
 * cart was updated.
 */
export function updateCartDraftLines(storage, uid, lines) {
  const key = cartStorageKey(uid);
  const draft = parseJson(safeGet(storage, key));
  if (!isCartDraft(draft) || draft.ownerUid !== uid) return false;
  if (draft.items.some((item) => !item || typeof item.inventoryId !== "string" || !item.inventoryId)) {
    return false;
  }
  const wanted = new Map();
  for (const line of lines ?? []) {
    if (line && typeof line.inventoryId === "string" && line.inventoryId) {
      wanted.set(line.inventoryId, line.quantity);
    }
  }
  const items = draft.items
    .filter((item) => wanted.has(item.inventoryId))
    .map((item) => ({ ...item, quantity: wanted.get(item.inventoryId) }));
  return persistVerified(
    storage,
    key,
    JSON.stringify({
      ...draft,
      items,
      totalVials: items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0),
      storageSlots: items.length,
    })
  );
}

// ------------------------------------------------- the submission snapshot

/**
 * The canonical form of everything the rep submits — every field they can see
 * and change, including the three the server fingerprint ignores (priority,
 * instructions, requested date). Lines are sorted so order does not matter.
 */
export function canonicalSubmission(submission) {
  const items = (Array.isArray(submission?.items) ? submission.items : [])
    .map((item) => ({
      inventoryId: String(item?.inventoryId ?? ""),
      quantity: Number(item?.quantity),
      expectedUnitPriceCentavos:
        typeof item?.expectedUnitPriceCentavos === "number" ? item.expectedUnitPriceCentavos : null,
    }))
    .sort((a, b) => (a.inventoryId < b.inventoryId ? -1 : a.inventoryId > b.inventoryId ? 1 : 0));
  const date = submission?.requestedDeliveryDate;
  return {
    doctorId: String(submission?.doctorId ?? ""),
    doctorAddressId: String(submission?.doctorAddressId ?? ""),
    requestedDeliveryDate: typeof date === "string" && date.trim() !== "" ? date.trim() : null,
    priority: submission?.priority === "Urgent" ? "Urgent" : "Standard",
    deliveryInstructions:
      typeof submission?.deliveryInstructions === "string" ? submission.deliveryInstructions.trim() : "",
    items,
  };
}

/**
 * The user-visible fields on which [current] differs from the [saved] attempt,
 * as plain labels. Empty when the checkout is unchanged.
 */
export function diffSubmission(saved, current) {
  const a = canonicalSubmission(saved);
  const b = canonicalSubmission(current);
  const changed = [];
  if (a.doctorId !== b.doctorId) changed.push("doctor");
  if (a.doctorAddressId !== b.doctorAddressId) changed.push("destination");
  if (a.requestedDeliveryDate !== b.requestedDeliveryDate) changed.push("requested date");
  if (a.priority !== b.priority) changed.push("priority");
  if (a.deliveryInstructions !== b.deliveryInstructions) changed.push("instructions");

  const aIds = a.items.map((i) => i.inventoryId).join("|");
  const bIds = b.items.map((i) => i.inventoryId).join("|");
  if (aIds !== bIds) {
    changed.push("items");
  } else {
    if (a.items.some((item, i) => item.quantity !== b.items[i].quantity)) changed.push("quantity");
    if (a.items.some((item, i) => item.expectedUnitPriceCentavos !== b.items[i].expectedUnitPriceCentavos)) {
      changed.push("price");
    }
  }
  return changed;
}

/**
 * [uid]'s pending attempt — `{ requestId, submission, createdAt }` — or null.
 *
 * A record with an invalid request ID is treated as absent: the server never
 * accepts such an ID, so no order can exist under it. A record with a VALID ID
 * whose snapshot is unreadable keeps its ID (it may have reached the server)
 * and reports `submission: null`.
 */
export function loadPendingAttempt(storage, uid) {
  const record = parseJson(safeGet(storage, attemptStorageKey(uid)));
  if (!record || typeof record !== "object") return null;
  if (record.v !== ATTEMPT_VERSION || record.uid !== uid) return null;
  if (!isValidRequestId(record.requestId)) return null;
  const submission =
    record.submission && typeof record.submission === "object"
      ? canonicalSubmission(record.submission)
      : null;
  return { requestId: record.requestId, submission, createdAt: record.createdAt ?? null };
}

function writeAttempt(storage, uid, requestId, submission) {
  return persistVerified(
    storage,
    attemptStorageKey(uid),
    JSON.stringify({
      v: ATTEMPT_VERSION,
      uid,
      requestId,
      createdAt: new Date().toISOString(),
      submission,
    })
  );
}

/**
 * Forget [uid]'s pending attempt (request ID + snapshot), keeping the cart.
 * Only ever called from the rep's CONFIRMED discard action: the earlier
 * attempt may already have created an order, so a new attempt could duplicate it.
 */
export function discardOrderAttempt(storage, uid) {
  safeRemove(storage, attemptStorageKey(uid));
}

/** Explicitly discard [uid]'s whole draft: the attempt and the cart. */
export function discardOrderDraft(storage, uid) {
  discardOrderAttempt(storage, uid);
  safeRemove(storage, cartStorageKey(uid));
}

/** Confirmed success: the draft has become an order. Cart, ID and snapshot go together. */
export function completeOrderDraft(storage, uid) {
  discardOrderDraft(storage, uid);
}

/**
 * Run one checkout submission under the draft's durable request ID.
 *
 * Refuses, WITHOUT calling [submit]:
 *  - `unauthenticated`     — no signed-in user;
 *  - `draft-changed`       — a pending attempt exists and the checkout no
 *                            longer matches it (`details.changedFields`);
 *  - `storage-unavailable` — the ID + snapshot could not be verifiably saved.
 *
 * Otherwise sends the saved ID (an unchanged retry) or a newly saved one, and
 * clears the draft only after [submit] resolves. ANY failure from [submit] —
 * network, timeout, unknown outcome, idempotency-conflict — leaves the attempt
 * in place; it is never rotated automatically.
 */
export async function submitOrderDraft({ storage, uid, submission, submit, generate = newRequestId }) {
  requireUid(uid);
  const current = canonicalSubmission(submission);
  const pending = loadPendingAttempt(storage, uid);

  let requestId;
  if (pending) {
    if (pending.submission) {
      const changedFields = diffSubmission(pending.submission, current);
      if (changedFields.length > 0) {
        throw new OrderDraftError(
          "draft-changed",
          `This checkout differs from an earlier attempt that may already have been placed (changed: ${changedFields.join(", ")}). Check Order Tracking before starting another order.`,
          { changedFields }
        );
      }
    } else if (!writeAttempt(storage, uid, pending.requestId, current)) {
      // The ID survived but its snapshot did not: keep the ID (it may have
      // reached the server) and record what this retry submits.
      throw new OrderDraftError("storage-unavailable", STORAGE_UNAVAILABLE_MESSAGE);
    }
    requestId = pending.requestId;
  } else {
    requestId = generate();
    if (!isValidRequestId(requestId)) {
      throw new OrderDraftError(
        "invalid-request-id",
        "The order request could not be prepared. Please try again."
      );
    }
    if (!writeAttempt(storage, uid, requestId, current)) {
      throw new OrderDraftError("storage-unavailable", STORAGE_UNAVAILABLE_MESSAGE);
    }
  }

  const result = await submit(requestId);
  completeOrderDraft(storage, uid);
  return result;
}
