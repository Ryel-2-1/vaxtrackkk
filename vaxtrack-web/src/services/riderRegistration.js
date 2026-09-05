/**
 * New-rider registration shape.
 *
 * The company operates motorcycles only for rider delivery work, so
 * `Motorcycle` is the single supported vehicle type for a NEW registration.
 * This module owns that fact once, so the form and any future write cannot
 * disagree about it.
 *
 * WHY A MODULE AND NOT JUST THE FORM: a `<select>` with one option still sends
 * whatever the DOM node holds, and React state can go stale. Normalising here
 * means the value is decided by code, not by markup — a tampered option, a
 * stale draft, or a caller passing its own `vehicle` all end up canonical.
 *
 * SCOPE — new registrations only. Nothing here reads, migrates or rewrites
 * existing rider documents. Riders already recorded with a van, truck or auto
 * keep exactly what they have; `subscribeRiders` and the Admin list are
 * untouched.
 *
 * NOTE ON THE WRITE PATH: the Admin "New Rider" form does not create an
 * account. Rider accounts come from Firebase Auth self-registration in the
 * Flutter app, and the form only explains that. `buildNewRiderPayload` is
 * therefore the boundary any future write must pass through, and is exercised
 * by the form's submit handler today so the normalisation is real rather than
 * theoretical. It deliberately fabricates nothing: no rider id, no plate, no
 * motorcycle id.
 */

/** The only vehicle type a new rider may be registered with. */
export const RIDER_VEHICLE_TYPE = "Motorcycle";

/** Defaults for the New Rider form. Unchanged from the original form state. */
const DEFAULT_HUB = "Manila Central Hub";
const DEFAULT_STATUS = "standby";

/**
 * A fresh New Rider draft.
 *
 * Returns a NEW object each call, so opening the modal a second time cannot
 * inherit the previous draft — including a vehicle type left over from before
 * this restriction existed.
 */
export function createEmptyNewRider() {
  return {
    name: "",
    id: "",
    phone: "",
    vehicle: RIDER_VEHICLE_TYPE,
    hub: DEFAULT_HUB,
    status: DEFAULT_STATUS,
  };
}

/**
 * Normalise a New Rider draft into the payload that would be stored.
 *
 * The vehicle type is SET, never read from the draft, so a conflicting value —
 * from stale state, a tampered DOM node, or a caller supplying its own — cannot
 * survive. Every other field is passed through untouched: this function
 * validates nothing and invents nothing, so the form's existing name / rider id
 * / phone / hub / status rules remain the only authority on those.
 *
 * @param {object} draft The current form draft.
 * @returns {{name: string, id: string, phone: string, vehicle: string, hub: string, status: string}}
 */
export function buildNewRiderPayload(draft = {}) {
  const source = draft && typeof draft === "object" ? draft : {};

  return {
    name: source.name ?? "",
    id: source.id ?? "",
    phone: source.phone ?? "",
    hub: source.hub ?? DEFAULT_HUB,
    status: source.status ?? DEFAULT_STATUS,
    // Last and unconditional: nothing the caller supplies can override it.
    vehicle: RIDER_VEHICLE_TYPE,
  };
}
