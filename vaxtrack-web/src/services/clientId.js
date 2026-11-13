/**
 * Client ID (2026-11-13). 3MGS identifies each client with its own code
 * (AAC-030, BLB-006…). A clinic IS the client, so that code is the clinic's
 * ID: the Admin types it when registering the clinic, it must be unique, and
 * it is stored in the clinic's existing `clinicId` field (which used to hold a
 * random CLN-1234). It is what staff search by, what checkout shows beside a
 * destination, and what the invoice's customer code starts from.
 *
 * Pure: no Firebase or React import.
 */

import { normalizeDoctorName } from "./doctorModel.js";

/** 2–20 capital letters or digits; hyphens allowed between them. */
export const CLIENT_ID_PATTERN = /^[A-Z0-9](?:[A-Z0-9-]{0,18})[A-Z0-9]$/;
export const CLIENT_ID_EXAMPLE = "AAC-030";
export const CLIENT_ID_REQUIRED_MESSAGE = "Enter the client ID.";
export const CLIENT_ID_FORMAT_MESSAGE =
  "Use 2 to 20 capital letters and numbers, like AAC-030. A hyphen may separate them.";
export const CLIENT_ID_TAKEN_MESSAGE =
  "Another clinic already uses this client ID. Check the ID, or open that clinic instead.";

/** The ID as stored: trimmed and upper-cased. */
export function normalizeClientId(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export function validateClientId(value) {
  const id = normalizeClientId(value);
  if (!id) return { ok: false, error: CLIENT_ID_REQUIRED_MESSAGE };
  if (!CLIENT_ID_PATTERN.test(id) || id.includes("--")) return { ok: false, error: CLIENT_ID_FORMAT_MESSAGE };
  return { ok: true, value: id };
}

/** A clinic's client ID for display, or "" when it has none. */
export function clientIdOf(clinic) {
  return normalizeClientId(clinic?.clinicId);
}

const text = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");

/**
 * What Register Clinic's search bar finds: existing clinics (by client ID,
 * name or doctor) and existing doctors (by name), so the Admin opens the
 * record that is already there instead of registering it twice. An exact
 * client-ID match comes first. At most [limit] of each.
 */
export function findExistingClients(query, clinics, doctors, limit = 5) {
  const q = text(query);
  if (q.length < 2) return { clinics: [], doctors: [] };
  const clinicHits = (clinics || [])
    .filter((c) => [c?.clinicId, c?.name, c?.contact].some((v) => text(v).includes(q)))
    .sort((a, b) => Number(text(b?.clinicId) === q) - Number(text(a?.clinicId) === q))
    .slice(0, limit);
  const doctorHits = (doctors || [])
    .filter((d) => d?.active !== false && text(d?.name).includes(q))
    .slice(0, limit);
  return { clinics: clinicHits, doctors: doctorHits };
}

/**
 * The doctor a new clinic's Doctor field refers to: an existing ACTIVE doctor
 * with the same name in the same area, else null (a new doctor is created).
 * Two real doctors may share a name, so a same-named doctor in ANOTHER area is
 * treated as a different person.
 */
export function matchingDoctor(name, areaId, doctors) {
  const wanted = normalizeDoctorName(name);
  if (!wanted) return null;
  return (doctors || []).find(
    (d) => d?.active === true && d.areaId === areaId
      && (d.nameNormalized === wanted || normalizeDoctorName(d.name) === wanted)
  ) ?? null;
}
