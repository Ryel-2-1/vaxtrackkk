/**
 * When a Med Rep may change their own order's delivery date (2026-11-13):
 * until the rider leaves. Mirrors MED_REP_RESCHEDULABLE in
 * functions/src/scheduleOperations.js, which enforces it.
 */
export const MED_REP_RESCHEDULABLE_STATUSES = Object.freeze(["pending_dispatch", "assigned", "loading"]);

export function medRepMayReschedule(statusKey) {
  return MED_REP_RESCHEDULABLE_STATUSES.includes(statusKey);
}
