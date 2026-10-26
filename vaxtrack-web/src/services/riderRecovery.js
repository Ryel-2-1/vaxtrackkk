/**
 * Admin Rider recovery — what the panel shows and offers, from the server's
 * preview (functions/src/riderRecoveryOps.js previewRiderRecovery). Pure; the
 * server decides every action again when it is applied.
 */
import { riderTripStatus } from "./riderTrip.js";

/** Production. "Reset QA trip" is never offered here, whatever the server says. */
export const PRODUCTION_PROJECT_ID = "vaxtrack-bef1b";

/**
 * Is "Reset QA trip" shown? Only when the SERVER reports it enabled for this
 * project (allowed staging/demo project AND its server-side switch) — and, as
 * a second guard, never in a production build. The client check alone decides
 * nothing: a hidden button is not a security boundary, the callable is.
 */
export function qaResetVisible(preview, projectId) {
  if (typeof projectId !== "string" || projectId === "" || projectId === PRODUCTION_PROJECT_ID) return false;
  return preview?.actions?.qaReset?.enabled === true;
}

/** The trip state as the Admin reads it (same wording as Dispatcher pages). */
export function tripStateLabel(preview) {
  if (preview?.derived?.unknown) return "Trip status can't be checked";
  const tripOrders = (preview?.orders ?? []).filter((o) => o.onTrip && o.active).map((o) => o.orderId);
  return riderTripStatus({ state: preview?.derived?.state, orderIds: tripOrders }).label;
}

const CUSTODY_LABELS = Object.freeze({
  "with-rider": "With the rider",
  loaded: "Confirmed loaded",
  "loaded-before": "Was loaded (unticked since)",
  travelled: "Left the hub before",
  "not-loaded": "Not loaded",
  unknown: "Unknown",
});

export function custodyLabel(custody) {
  return CUSTODY_LABELS[custody] ?? CUSTODY_LABELS.unknown;
}

/** Active trip orders first, then finished ones; each in order-number order. */
export function splitOrders(preview) {
  const list = Array.isArray(preview?.orders) ? preview.orders : [];
  const byNumber = (a, b) => String(a.orderNumber).localeCompare(String(b.orderNumber));
  return {
    active: list.filter((o) => o.active).sort(byNumber),
    finished: list.filter((o) => !o.active).sort(byNumber),
  };
}

/** A short, specific reason (the server requires one; same limit as cancellation). */
export const MAX_RECOVERY_REASON = 500;
export function validRecoveryReason(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  return trimmed.length >= 5 && trimmed.length <= MAX_RECOVERY_REASON;
}
