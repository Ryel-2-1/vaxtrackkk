/**
 * "My profile" — what every web role sees and may change about their OWN
 * account. Pure and dependency-free (no Firebase, no React), so the rules for
 * reading, validating and writing a profile are tested as plain functions.
 *
 * The same page serves Admin, Sales Rep and Dispatcher:
 *
 *   editable by the user  — full name, phone / contact number
 *   read-only             — email (the sign-in identity), role, account
 *                           status, employee ID, organization
 *
 * Role, status, employee ID and organization are an administrator's to manage
 * (Staff Directory). firestore.rules enforces the same split: a user's own
 * update may touch only `selfEditableUserFields()` — the fields listed in
 * SELF_EDITABLE_FIELDS below, plus a rider's location fields.
 */

import { normalizeRole, ROLES } from "./authorization.js";
import { staffStatusOf } from "./staffAccount.js";

/** The only fields a user may write on their own users/{uid} record. */
export const SELF_EDITABLE_FIELDS = Object.freeze(["name", "fullName", "phone", "contactNumber"]);

export const MIN_NAME_LENGTH = 2;
export const MAX_NAME_LENGTH = 80;
export const MAX_PHONE_LENGTH = 30;

const ROLE_LABELS = Object.freeze({
  [ROLES.ADMIN]: "Administrator",
  [ROLES.DISPATCHER]: "Dispatcher",
  [ROLES.SALES_REP]: "Med Rep",
  [ROLES.RIDER]: "Rider",
});

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
function firstText(...values) {
  for (const value of values) {
    const t = text(value);
    if (t) return t;
  }
  return "";
}
/** Collapse runs of whitespace so "Ana   Reyes" is stored as "Ana Reyes". */
function tidyName(value) {
  return text(value).replace(/\s+/g, " ");
}

/** A role's display label; an unrecognised role reads as "—", never invented. */
export function roleLabelOf(rawRole) {
  return ROLE_LABELS[normalizeRole(rawRole)] ?? "—";
}

/** Up to two initials for an avatar, or "?" when there is no name. */
export function initialsOf(name) {
  const letters = tidyName(name)
    .split(" ")
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return letters || "?";
}

/**
 * The profile as the page shows it, from the raw users/{uid} document. Reads
 * the field spellings the app has actually stored (`fullName` from rider
 * registration, `contactNumber`, `company`/`clinic` for organization).
 */
export function readProfile(raw, { authEmail = "" } = {}) {
  const doc = raw && typeof raw === "object" ? raw : {};
  const status = staffStatusOf(doc.status);
  return {
    name: firstText(doc.name, doc.fullName, doc.displayName),
    phone: firstText(doc.phone, doc.contactNumber),
    // The sign-in email is the authority; the stored copy is only a fallback.
    email: firstText(authEmail, doc.email),
    roleKey: normalizeRole(doc.role),
    roleLabel: roleLabelOf(doc.role),
    statusKey: status.key,
    statusLabel: status.label,
    employeeId: text(doc.employeeId),
    organization: firstText(doc.organization, doc.company, doc.clinic),
  };
}

/**
 * Validate the user's edits.
 *   name  — required, 2–80 characters, at least one letter
 *   phone — optional; when given, digits with an optional leading +, spaces,
 *           hyphens, dots or brackets, and 7–15 digits in all
 * @returns {{ok: boolean, errors: {name?: string, phone?: string}, value: {name: string, phone: string}}}
 */
export function validateProfileEdit({ name, phone } = {}) {
  const cleanName = tidyName(name);
  const cleanPhone = text(phone);
  const errors = {};

  if (cleanName.length < MIN_NAME_LENGTH) {
    errors.name = "Enter your full name.";
  } else if (cleanName.length > MAX_NAME_LENGTH) {
    errors.name = `Use ${MAX_NAME_LENGTH} characters or fewer.`;
  } else if (!/\p{L}/u.test(cleanName)) {
    errors.name = "Your name must contain letters.";
  }

  if (cleanPhone) {
    const digits = cleanPhone.replace(/\D/g, "");
    if (
      cleanPhone.length > MAX_PHONE_LENGTH ||
      !/^\+?[0-9 ().-]+$/.test(cleanPhone) ||
      digits.length < 7 ||
      digits.length > 15
    ) {
      errors.phone = "Enter a valid phone number, e.g. +63 917 123 4567.";
    }
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: { name: cleanName, phone: cleanPhone },
  };
}

/** True when the edits differ from what is stored. */
export function hasProfileChanges(raw, edits) {
  const current = readProfile(raw);
  const next = validateProfileEdit(edits).value;
  return current.name !== next.name || current.phone !== next.phone;
}

/**
 * The fields to write for a validated edit — only SELF_EDITABLE_FIELDS.
 * `name` and `phone` are always written; the legacy spellings `fullName` and
 * `contactNumber` are kept in step only where the document already uses them,
 * so every screen that reads the older field shows the new value too.
 */
export function buildProfileUpdate(raw, value) {
  const doc = raw && typeof raw === "object" ? raw : {};
  const update = { name: value.name, phone: value.phone };
  if (typeof doc.fullName === "string") update.fullName = value.name;
  if (typeof doc.contactNumber === "string") update.contactNumber = value.phone;
  return update;
}
