// Dispatcher › Assign Rider — the queue and the assignment run, as pure logic.
//
// The page renders from these; tests exercise them without a DOM. Nothing here
// talks to Firebase: the queue is built from the live pending-orders snapshot,
// and the assignment itself is the existing transactional assignRiderToOrder
// (orderService.js), which re-reads and re-validates everything server-side.

import { assignmentBlockReason } from "./backorder.js";
import { comparePending, partitionPendingDispatch, requestedDateMeta } from "./dispatchEligibility.js";
import { manilaToday } from "./requestedDate.js";

export const QUEUE_PAGE_SIZE = 10;

export const QUEUE_FILTERS = Object.freeze([
  { key: "all", label: "All" },
  { key: "urgent", label: "Urgent" },
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Due today" },
]);

export const ASSIGNED_SUCCESS_MESSAGE = "Rider assigned successfully.";
export const ALREADY_ASSIGNED_MESSAGE = "This order has already been assigned. The list has been updated.";

const isUrgent = (o) => (o?.priority || "").toLowerCase() === "urgent";

function haystack(o) {
  return [o.orderNumber, o.id, o.clinicName, o.destinationName, o.doctorName, o.vaccineName, o.clinicAddress, o.deliveryAddress]
    .filter((v) => typeof v === "string")
    .join(" ")
    .toLowerCase();
}

/**
 * The assignable queue: only orders whose dispatch day has begun (Manila),
 * in the same order as the Dashboard queue, narrowed by `filter` and `search`.
 * Each row says whether stock allows assignment (`stockBlock`).
 */
export function buildAssignmentQueue({ orders, now = new Date(), search = "", filter = "all" }) {
  const { actionable } = partitionPendingDispatch(orders, now);
  const today = manilaToday(now);
  const needle = search.trim().toLowerCase();
  return [...actionable]
    .sort(comparePending)
    .filter((o) => {
      if (filter === "urgent" && !isUrgent(o)) return false;
      if (filter === "overdue" && requestedDateMeta(o, today).kind !== "overdue") return false;
      if (filter === "today" && requestedDateMeta(o, today).kind !== "today") return false;
      return !needle || haystack(o).includes(needle);
    })
    .map((o) => ({ ...o, stockBlock: assignmentBlockReason(o), dateKind: requestedDateMeta(o, today).kind }));
}

/**
 * One page of the queue. The page is clamped, so when the live snapshot
 * removes the last row of the last page the view stays on a real page rather
 * than going blank.
 */
export function pageOf(rows, page, size = QUEUE_PAGE_SIZE) {
  const pageCount = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(1, page), pageCount);
  return { rows: rows.slice((current - 1) * size, current * size), page: current, pageCount };
}

/**
 * The operator-facing message for a failed assignment. AssignmentError
 * messages are already written for the operator; everything else is mapped
 * by code, and raw Firebase text is never shown.
 * Returns { message, conflict } — `conflict` when the order is no longer
 * waiting (another dispatcher won the race, or it was cancelled meanwhile).
 */
export function assignmentErrorMessage(error) {
  const code = typeof error?.code === "string" ? error.code.replace(/^firestore\//, "") : "";
  switch (code) {
    case "order-already-assigned":
      return { message: ALREADY_ASSIGNED_MESSAGE, conflict: true };
    case "order-not-pending":
      // Usually another dispatcher assigned it first (the transaction saw the
      // new status); otherwise it was cancelled meanwhile.
      return { message: goneOrderMessage(error?.details?.status), conflict: true };
    case "order-not-found":
      return { message: "This order no longer exists. The list has been updated.", conflict: true };
    case "rider-not-found":
    case "not-a-rider":
    case "rider-not-approved":
      return { message: "That rider is no longer available. Choose another rider.", conflict: false };
    case "permission-denied":
    case "unauthenticated":
      return { message: "You do not have permission to assign riders. Sign in again or contact an administrator.", conflict: false };
    case "unavailable":
    case "deadline-exceeded":
    case "network-request-failed":
      return { message: "Could not reach the server. Check your connection and try again — nothing was assigned.", conflict: false };
    default:
      break;
  }
  if (error?.name === "AssignmentError" && typeof error.message === "string" && error.message) {
    return { message: error.message, conflict: false };
  }
  return { message: "Unable to assign the rider. Please try again.", conflict: false };
}

/**
 * Why the order open in the dialog left the live queue, from its current
 * status (undefined while that one read is in flight). An order leaves
 * pending_dispatch only by being assigned (by anyone) or cancelled.
 */
export function goneOrderMessage(status) {
  const key = typeof status === "string" ? status.trim().toLowerCase() : status;
  if (["assigned", "loading", "in_transit", "delayed", "delivered"].includes(key)) return ALREADY_ASSIGNED_MESSAGE;
  if (key === "cancelled" || key === "canceled") return "This order was cancelled. The list has been updated.";
  return "This order is no longer waiting for a rider. The list has been updated.";
}

/**
 * Runs assignments one at a time. A second run while one is pending is
 * refused synchronously (repeated clicks before React re-renders), so a
 * double click sends exactly one assignment.
 *
 * run(orderId, riderUid) resolves to:
 *   { ok: true, message, result }            on success
 *   { ok: false, message, conflict }        on failure (never raw error text)
 *   { ok: false, busy: true }               when another run is still pending
 */
export function createAssignmentRunner(assign) {
  let pending = false;
  return {
    get pending() {
      return pending;
    },
    async run(orderId, riderUid) {
      if (pending) return { ok: false, busy: true };
      pending = true;
      try {
        const result = await assign(orderId, riderUid);
        return { ok: true, message: ASSIGNED_SUCCESS_MESSAGE, result };
      } catch (error) {
        return { ok: false, ...assignmentErrorMessage(error) };
      } finally {
        pending = false;
      }
    },
  };
}
