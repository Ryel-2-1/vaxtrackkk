// Routing settings — the hub every planned trip departs from and the planning
// defaults. Firebase-free, so the rules, the Admin form and the planner share
// one validator (the Firestore side is routingSettingsService.js).
//
// Stored as ONE document, operationsSettings/routing: Admin writes it,
// Dispatcher reads it (firestore.rules validRoutingSettings).

export const ROUTING_SETTINGS_COLLECTION = "operationsSettings";
export const ROUTING_SETTINGS_DOC = "routing";

export const ROUTING_DEFAULTS = Object.freeze({
  // Time a Rider spends at each stop (handover, signature, cold-chain check).
  serviceMinutes: 10,
  // Added to every Valhalla travel time: the public server has no live traffic.
  trafficBufferPercent: 15,
  // A wait longer than this at one stop is flagged — vaccines sit in the cooler box.
  longWaitMinutes: 30,
});

export const ROUTING_LIMITS = Object.freeze({
  serviceMinutes: [0, 120],
  trafficBufferPercent: [0, 100],
  longWaitMinutes: [5, 240],
  hubNameLength: 80,
});

// The pharmacy's pin (Google Maps: Puremart Zapote). Only ever a pre-fill for
// the Admin form — nothing is planned from it until an Admin saves it.
export const SUGGESTED_HUB = Object.freeze({ name: "Puremart Zapote", latitude: 14.3123223, longitude: 121.0848667 });

const LABELS = {
  serviceMinutes: "Time at each stop",
  trafficBufferPercent: "Traffic buffer",
  longWaitMinutes: "Long-wait warning",
};

function wholeNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isInteger(n) ? n : NaN;
}

function coordinate(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Validate the Admin form. Returns { ok, value, errors }: `value` is exactly
 * the document fields (minus updatedAt / updatedByUid, which the service adds).
 */
export function validateRoutingSettings(input = {}) {
  const errors = {};
  const hubName = typeof input.hubName === "string" ? input.hubName.trim() : "";
  if (!hubName) errors.hubName = "Enter the hub's name.";
  else if (hubName.length > ROUTING_LIMITS.hubNameLength) errors.hubName = `Use at most ${ROUTING_LIMITS.hubNameLength} characters.`;

  const lat = coordinate(input.latitude);
  const lng = coordinate(input.longitude);
  if (lat === null || lng === null) errors.location = "Place the hub on the map, or enter its latitude and longitude.";
  else {
    if (Number.isNaN(lat) || lat < -90 || lat > 90) errors.latitude = "Latitude must be between -90 and 90.";
    if (Number.isNaN(lng) || lng < -180 || lng > 180) errors.longitude = "Longitude must be between -180 and 180.";
  }

  const numbers = {};
  for (const key of ["serviceMinutes", "trafficBufferPercent", "longWaitMinutes"]) {
    const n = wholeNumber(input[key]);
    const [min, max] = ROUTING_LIMITS[key];
    if (n === null) errors[key] = `Enter ${LABELS[key].toLowerCase()}.`;
    else if (Number.isNaN(n) || n < min || n > max) errors[key] = `${LABELS[key]} must be a whole number from ${min} to ${max}.`;
    else numbers[key] = n;
  }

  if (Object.keys(errors).length > 0) return { ok: false, value: null, errors };
  return {
    ok: true,
    errors: {},
    value: { hubName, hubLatitude: lat, hubLongitude: lng, ...numbers },
  };
}

/**
 * The settings the planner uses, from the stored document (or null). A missing
 * or malformed hub is `hub: null` — never a guessed location. Defaults fill in
 * only the planning numbers.
 */
export function routingSettingsOf(doc) {
  const inRange = (v, [min, max]) => Number.isInteger(v) && v >= min && v <= max;
  const pick = (key) => (inRange(doc?.[key], ROUTING_LIMITS[key]) ? doc[key] : ROUTING_DEFAULTS[key]);
  const lat = doc?.hubLatitude;
  const lng = doc?.hubLongitude;
  const validHub =
    typeof doc?.hubName === "string" && doc.hubName.trim() !== "" &&
    Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  return {
    hub: validHub ? { name: doc.hubName.trim(), latLng: [lat, lng] } : null,
    serviceMinutes: pick("serviceMinutes"),
    trafficBufferPercent: pick("trafficBufferPercent"),
    longWaitMinutes: pick("longWaitMinutes"),
  };
}

/** The Admin form's starting values: the saved document, else the suggested hub and defaults. */
export function routingFormValues(doc) {
  const s = routingSettingsOf(doc);
  return {
    hubName: s.hub?.name ?? SUGGESTED_HUB.name,
    latitude: String(s.hub?.latLng[0] ?? SUGGESTED_HUB.latitude),
    longitude: String(s.hub?.latLng[1] ?? SUGGESTED_HUB.longitude),
    serviceMinutes: String(s.serviceMinutes),
    trafficBufferPercent: String(s.trafficBufferPercent),
    longWaitMinutes: String(s.longWaitMinutes),
  };
}
