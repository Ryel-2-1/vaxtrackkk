/**
 * Staff account states as the Admin Staff Directory presents and changes them.
 *
 * Pure and dependency-free (no Firebase, no React) so the display, the action
 * menu and the transition rule are tested as plain functions. Stored values
 * stay the canonical lowercase statuses in authorization.js; this module only
 * decides how each one reads and what an admin may do next.
 *
 * Four states, never merged:
 *
 *   approved          → Active
 *   pending / pending_approval → Pending
 *   disabled          → Inactive   (deactivated; may be reactivated)
 *   rejected          → Rejected   (a refused application; final here)
 *
 * `rejected` used to be displayed as Inactive, which put the Reactivate action
 * on a refused application and let it become an approved account. A rejected
 * account is not an inactive one: there is no ordinary way back from it.
 *
 * firestore.rules enforces the same transition matrix on the stored document
 * (see `adminStatusChangeAllowed`), so a modified client cannot bypass it.
 */

import { normalizeStatus, STATUSES } from "./authorization.js";

export const STAFF_STATUS = Object.freeze({
  ACTIVE: "active",
  PENDING: "pending",
  INACTIVE: "inactive",
  REJECTED: "rejected",
});

const DISPLAY = Object.freeze({
  [STATUSES.APPROVED]: { key: STAFF_STATUS.ACTIVE, label: "Active" },
  [STATUSES.PENDING]: { key: STAFF_STATUS.PENDING, label: "Pending" },
  [STATUSES.PENDING_APPROVAL]: { key: STAFF_STATUS.PENDING, label: "Pending" },
  [STATUSES.DISABLED]: { key: STAFF_STATUS.INACTIVE, label: "Inactive" },
  [STATUSES.REJECTED]: { key: STAFF_STATUS.REJECTED, label: "Rejected" },
});

/**
 * How a stored status reads in the Staff Directory.
 *
 * Case and whitespace variants of a real status ("Rejected", " DISABLED ")
 * read as that status — the access resolver already treats them so, and the
 * directory must not disagree with it. A missing or unrecognised status still
 * reads as Pending, as it always has here: that is the in-app path an admin
 * uses to approve a profile created without one.
 */
export function staffStatusOf(rawStatus) {
  const status = normalizeStatus(rawStatus);
  return DISPLAY[status] ?? DISPLAY[STATUSES.PENDING];
}

/**
 * The status changes an admin may make from the Staff Directory. A stored
 * status is read through normalizeStatus first, so a legacy "Rejected" is
 * protected exactly like "rejected".
 *
 *   Pending  → Active (approve) | Rejected (reject)
 *   Active   → Inactive (deactivate)
 *   Inactive → Active (reactivate)
 *   Rejected → nothing. Not Active, not Inactive, not back to Pending —
 *              there is no reconsideration workflow.
 *
 * A missing or unrecognised stored status reads as Pending, so it may be
 * approved (the existing repair path) or rejected, and nothing else.
 */
const TRANSITIONS = Object.freeze({
  [STATUSES.PENDING]: [STATUSES.APPROVED, STATUSES.REJECTED],
  [STATUSES.PENDING_APPROVAL]: [STATUSES.APPROVED, STATUSES.REJECTED],
  [STATUSES.APPROVED]: [STATUSES.DISABLED],
  [STATUSES.DISABLED]: [STATUSES.APPROVED],
  [STATUSES.REJECTED]: [],
});
const UNRECOGNISED_FROM = Object.freeze([STATUSES.APPROVED, STATUSES.REJECTED]);

export function canChangeStaffStatus(fromRaw, to) {
  const from = normalizeStatus(fromRaw);
  const allowed = from === null ? UNRECOGNISED_FROM : TRANSITIONS[from];
  return allowed.includes(to);
}

export const ACCOUNT_REJECTED_CODE = "account-rejected";
export const STATUS_CHANGE_NOT_ALLOWED_CODE = "status-change-not-allowed";

/** Why a status change was refused, phrased for the admin. */
export function statusChangeRefusal(fromRaw) {
  if (normalizeStatus(fromRaw) === STATUSES.REJECTED) {
    return {
      code: ACCOUNT_REJECTED_CODE,
      message: "This application was rejected. A rejected account cannot be activated.",
    };
  }
  return {
    code: STATUS_CHANGE_NOT_ALLOWED_CODE,
    message: "That status change is not allowed for this account. Refresh and try again.",
  };
}

/**
 * The actions offered for one staff row (menu and profile dialog alike).
 * A rejected account offers View Profile only: no Activate, no second Reject,
 * and no Change Role, since a refused application has no access to adjust.
 */
export function staffActionsFor(statusKey, { isSelf = false } = {}) {
  const actions = ["view"];
  if (statusKey === STAFF_STATUS.PENDING) actions.push("approve", "reject");
  if (statusKey === STAFF_STATUS.ACTIVE) actions.push("deactivate");
  if (statusKey === STAFF_STATUS.INACTIVE) actions.push("reactivate");
  if (statusKey !== STAFF_STATUS.REJECTED && !isSelf) actions.push("changeRole");
  return actions;
}
