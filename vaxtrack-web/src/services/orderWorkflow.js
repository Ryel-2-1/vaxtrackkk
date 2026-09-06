/**
 * The order delivery lifecycle — the single source of truth for which status
 * change each actor may perform.
 *
 * This replaces a transition map that used to sit in orderService.js as an
 * `eslint-disable`d, unreferenced constant: it documented the intent but
 * nothing consulted it, so `updateOrderStatus` accepted any string at all.
 *
 * Pure module. No Firebase import, no I/O — so it can be executed directly in
 * tests, and so services, UI and rules all read the same matrix instead of
 * each restating it.
 *
 * The Flutter Rider app cannot import JavaScript, so it carries a small
 * equivalent in lib/utils/order_workflow.dart. A cross-contract test parses
 * that file and compares it to the tables below, so the two cannot drift.
 */

/** Every status the system may store. Nothing else is writable. */
export const ORDER_STATUSES = Object.freeze([
  "pending_dispatch",
  "assigned",
  "loading",
  "in_transit",
  "delayed",
  "delivery_failed",
  "delivered",
  "cancelled",
]);

/** Once an order reaches one of these it can never move again. */
export const TERMINAL_STATUSES = Object.freeze(["delivered", "cancelled"]);

/**
 * Statuses that are not terminal but are not progressing either — the order is
 * parked, waiting for someone else to act.
 *
 * `delivery_failed` is the only one: the rider has stopped, and nothing moves
 * until a dispatcher either sends it out again or cancels it. Kept separate
 * from TERMINAL_STATUSES so summaries can say "needs attention" rather than
 * "finished", and so nothing mistakes it for a closed order.
 */
export const AWAITING_DISPATCHER_STATUSES = Object.freeze(["delivery_failed"]);

export const ACTOR_DISPATCHER = "dispatcher";
export const ACTOR_RIDER = "rider";
export const ACTORS = Object.freeze([ACTOR_DISPATCHER, ACTOR_RIDER]);

/**
 * Dispatcher authority.
 *
 * `assigned → loading` and `loading → in_transit` are reachable ONLY through
 * Cargo Loading, which is the canonical dispatch-preparation path; Shipments is
 * monitoring and cancellation only. A dispatcher may cancel any non-terminal
 * order, and may not complete, delay or resume one — those belong to the rider
 * who is actually carrying it.
 */
export const DISPATCHER_TRANSITIONS = Object.freeze({
  pending_dispatch: Object.freeze(["assigned", "cancelled"]),
  assigned: Object.freeze(["loading", "cancelled"]),
  loading: Object.freeze(["in_transit", "cancelled"]),
  in_transit: Object.freeze(["cancelled"]),
  delayed: Object.freeze(["cancelled"]),
  // Recovery. A failed delivery goes back to `assigned` and re-enters the
  // normal path through Cargo Loading — it is never pushed straight back into
  // transit, because the cargo has to be handled and confirmed again.
  delivery_failed: Object.freeze(["assigned", "cancelled"]),
  delivered: Object.freeze([]),
  cancelled: Object.freeze([]),
});

/**
 * Assigned-rider authority.
 *
 * The rider never starts loading or transit — dispatch hands them an order that
 * is already `in_transit`. From there they may report a delay, resume, or
 * complete. They may not cancel.
 */
export const RIDER_TRANSITIONS = Object.freeze({
  pending_dispatch: Object.freeze([]),
  assigned: Object.freeze([]),
  loading: Object.freeze([]),
  in_transit: Object.freeze(["delayed", "delivered", "delivery_failed"]),
  delayed: Object.freeze(["in_transit", "delivered", "delivery_failed"]),
  // A rider reports a failure and stops there. Retrying or reassigning is a
  // dispatcher decision, so the rider cannot move it back into transit
  // themselves, and they can never cancel.
  delivery_failed: Object.freeze([]),
  delivered: Object.freeze([]),
  cancelled: Object.freeze([]),
});

const TRANSITIONS_BY_ACTOR = Object.freeze({
  [ACTOR_DISPATCHER]: DISPATCHER_TRANSITIONS,
  [ACTOR_RIDER]: RIDER_TRANSITIONS,
});

/**
 * Display labels. Kept separate from the stored keys on purpose — the Firestore
 * values are never renamed, only presented.
 */
export const STATUS_LABELS = Object.freeze({
  pending_dispatch: "Pending Dispatch",
  assigned: "Assigned",
  loading: "Loading",
  in_transit: "In Transit",
  delayed: "Delayed",
  delivery_failed: "Delivery Failed",
  delivered: "Delivered",
  cancelled: "Cancelled",
});

/** A rejected transition. `code` is stable; `message` is written for display. */
export class WorkflowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}

/**
 * Formatting-only normalization: trims, lowercases, and folds hyphens/spaces to
 * underscores — the same shape `deliveryService.normalizeStatusKey` has always
 * applied on read.
 *
 * It deliberately does NOT map values. An unrecognised status (including the
 * legacy read-only aliases `completed` and `canceled`) returns null rather than
 * being quietly rewritten into a canonical one, because this module governs
 * WRITES: silently promoting an unknown value would be exactly the escape hatch
 * the lifecycle exists to close. Reading and labelling legacy orders is
 * unchanged and still handled in deliveryService.
 *
 * @returns {string|null} a canonical status, or null if it is not one.
 */
export function normalizeStatus(value) {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  return ORDER_STATUSES.includes(key) ? key : null;
}

export function isKnownStatus(value) {
  return normalizeStatus(value) !== null;
}

export function isTerminalStatus(value) {
  const key = normalizeStatus(value);
  return key !== null && TERMINAL_STATUSES.includes(key);
}

/** The statuses `actor` may move `fromStatus` to. Always an array. */
export function allowedTransitions(actor, fromStatus) {
  const table = TRANSITIONS_BY_ACTOR[actor];
  const from = normalizeStatus(fromStatus);
  if (!table || from === null) return [];
  return table[from] ?? [];
}

/**
 * Whether `actor` may move an order from `fromStatus` to `toStatus`.
 *
 * Same-status "transitions" are rejected: a status write that changes nothing
 * is not a lifecycle event. Operations that legitimately touch only metadata
 * while the status stands still — the Cargo Loading checkbox during `loading` —
 * must not route through here; see `canUpdateLoadingMetadata`.
 *
 * @returns {{ok: true}|{ok: false, code: string, message: string}}
 */
export function canTransition(actor, fromStatus, toStatus) {
  if (!ACTORS.includes(actor)) {
    return { ok: false, code: "unknown-actor", message: "Unknown actor." };
  }
  const from = normalizeStatus(fromStatus);
  if (from === null) {
    return {
      ok: false,
      code: "unknown-from-status",
      message: "This order's current status is not recognised.",
    };
  }
  const to = normalizeStatus(toStatus);
  if (to === null) {
    return {
      ok: false,
      code: "unknown-to-status",
      message: "That is not a valid order status.",
    };
  }
  if (TERMINAL_STATUSES.includes(from)) {
    return {
      ok: false,
      code: "terminal-status",
      message: `This order is already ${STATUS_LABELS[from].toLowerCase()} and cannot change.`,
    };
  }
  if (from === to) {
    return {
      ok: false,
      code: "same-status",
      message: "That order is already in this status.",
    };
  }
  if (!(TRANSITIONS_BY_ACTOR[actor][from] ?? []).includes(to)) {
    return {
      ok: false,
      code: "transition-not-allowed",
      message: `A ${actor} cannot move an order from ${STATUS_LABELS[from]} to ${STATUS_LABELS[to]}.`,
    };
  }
  return { ok: true };
}

/** canTransition, as an assertion. @throws {WorkflowError} */
export function assertTransition(actor, fromStatus, toStatus) {
  const result = canTransition(actor, fromStatus, toStatus);
  if (!result.ok) throw new WorkflowError(result.code, result.message);
  return normalizeStatus(toStatus);
}

/**
 * Cargo Loading's per-order confirmation writes loading metadata (`isLoaded`
 * and its audit trail) and, on the first confirmation of an `assigned` order,
 * also promotes it to `loading`.
 *
 * Ticking an order that is ALREADY `loading` changes no status, so it is not a
 * transition and `canTransition` would rightly reject it as `same-status`.
 * This is the separate, explicit permission for that metadata-only write.
 */
export function canUpdateLoadingMetadata(fromStatus) {
  const from = normalizeStatus(fromStatus);
  if (from === null) {
    return {
      ok: false,
      code: "unknown-from-status",
      message: "This order's current status is not recognised.",
    };
  }
  if (from !== "assigned" && from !== "loading") {
    return {
      ok: false,
      code: "not-loadable",
      message: "Only assigned or loading orders can be marked as loaded.",
    };
  }
  return { ok: true };
}

/** Display label for a canonical status; falls back to the raw value. */
export function statusLabel(value) {
  const key = normalizeStatus(value);
  return key === null ? String(value ?? "") : STATUS_LABELS[key];
}

/** Parked, waiting for a dispatcher — not finished, not progressing. */
export function isAwaitingDispatcher(value) {
  const key = normalizeStatus(value);
  return key !== null && AWAITING_DISPATCHER_STATUSES.includes(key);
}

/**
 * The longest failure or delay reason that may be stored. Mirrored exactly by
 * `maxReasonLength()` in firestore.rules and by the Dart policy.
 */
export const MAX_REASON_LENGTH = 500;

/**
 * Validate a free-text reason the way every reason field in this workflow is
 * validated: present, meaningful once trimmed, and bounded.
 *
 * @returns {{ok: true, value: string}|{ok: false, code: string, message: string}}
 */
export function validateReason(value, { label = "reason" } = {}) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "") {
    return {
      ok: false,
      code: "reason-required",
      message: `Please give a ${label}.`,
    };
  }
  if (trimmed.length > MAX_REASON_LENGTH) {
    return {
      ok: false,
      code: "reason-too-long",
      message: `Please keep the ${label} under ${MAX_REASON_LENGTH} characters.`,
    };
  }
  return { ok: true, value: trimmed };
}
