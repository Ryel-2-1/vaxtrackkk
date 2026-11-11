"use strict";
// Mirrored by src/services/pharmacyHours.js; cross-layer tests pin these values.
const PHARMACY_HOURS = Object.freeze({ open: 7 * 60, close: 16 * 60 });
const HOURS_MESSAGE = "Requested delivery times must be within pharmacy operating hours, 7:00 AM to 4:00 PM (PHT).";
module.exports = { PHARMACY_HOURS, HOURS_MESSAGE };
