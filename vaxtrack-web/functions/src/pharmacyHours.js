"use strict";
// Mirrored by src/services/pharmacyHours.js; cross-layer tests pin these values.
const PHARMACY_HOURS = Object.freeze({ open: 7 * 60, close: 16 * 60 });
const HOURS_MESSAGE = "Requested delivery times must be within pharmacy operating hours, 7:00 AM to 4:00 PM (PHT).";
const { relaxedProjectIds } = require("./pharmacyHoursDemo.json");

function pharmacyHoursEnforced(projectId) {
  // The 7 AM-4 PM rule applies unless the project is listed in
  // pharmacyHoursDemo.json. Production was taken off it on 2026-11-11.
  return !relaxedProjectIds.includes(projectId);
}

module.exports = { PHARMACY_HOURS, HOURS_MESSAGE, pharmacyHoursEnforced };
