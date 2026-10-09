"use strict";

/**
 * Status attribution written by the callables.
 *
 * An order carries the status-attribution trio statusUpdatedAt /
 * statusUpdatedByUid / statusUpdatedByEmail, and Admin's Activity panel shows
 * the email as "Updated by". A writer that stamps the time and uid but not the
 * email leaves the PREVIOUS writer's email behind — which is how a delivery the
 * rider completed showed "Updated by dispatcher@…". Every callable status write
 * therefore sets the email together with the uid.
 *
 * The email comes from the caller's verified Firebase Auth token (index.js),
 * never from the request payload. With no email on the token the field is
 * DELETED rather than left stale: no attribution is better than a wrong one.
 */
function statusUpdatedByEmailValue(email, FieldValue) {
  return typeof email === "string" && email.trim() !== "" ? email.trim() : FieldValue.delete();
}

module.exports = { statusUpdatedByEmailValue };
