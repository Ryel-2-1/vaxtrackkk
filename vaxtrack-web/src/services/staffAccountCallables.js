import { getFunctions, httpsCallable } from "firebase/functions";
import { sendPasswordResetEmail } from "firebase/auth";
import app, { auth } from "../firebase";
import { UserMessageError } from "./userMessageError.js";

/**
 * Client side of staff account management (functions/src/staffAccounts.js).
 *
 * Creating staff and changing a role or a staff status are server-only:
 * firestore.rules refuses those writes from a browser, and the server keeps at
 * least one approved Admin at all times. A rider's status (Riders page) is the
 * one status a browser still writes.
 */
const FUNCTIONS_REGION = "asia-southeast1";

const call = (name) => httpsCallable(getFunctions(app, FUNCTIONS_REGION), name);

/** A refused staff action, with the server's stable code and its sentence for the Admin. */
export class StaffAccountError extends UserMessageError {
  constructor(code, message) {
    super(message, { code });
    this.name = "StaffAccountError";
  }
}

function rethrow(error) {
  const details = error?.details;
  if (details && typeof details.code === "string") throw new StaffAccountError(details.code, error.message);
  if (error?.code === "functions/unauthenticated") {
    throw new StaffAccountError("unauthenticated", "Your session has expired. Please sign in again.");
  }
  throw new StaffAccountError(
    "service-unavailable",
    "Staff accounts can't be changed right now. Nothing was saved — check your connection and try again.",
  );
}

async function run(name, payload) {
  try {
    return (await call(name)(payload)).data;
  } catch (error) {
    rethrow(error);
  }
}

/** { name, email, role } → { uid, email, role, setupLink | null }. */
export const createStaffAccount = ({ name, email, role }) => run("createStaffAccount", { name, email, role });

/** A new one-time password-setup link, for an account that has never signed in. */
export const createStaffSetupLink = (targetUid) => run("createStaffSetupLink", { targetUid });

/** approved | rejected | disabled. */
export const setStaffStatus = (targetUid, status) => run("setStaffStatus", { targetUid, status });

export const setStaffRole = (targetUid, role) => run("setStaffRole", { targetUid, role });

/**
 * Firebase's own "set your password" email (its reset template), sent to a
 * new staff member. Returns true when Firebase accepted it.
 */
export async function sendStaffSetupEmail(email) {
  try {
    await sendPasswordResetEmail(auth, email);
    return true;
  } catch {
    return false;
  }
}
