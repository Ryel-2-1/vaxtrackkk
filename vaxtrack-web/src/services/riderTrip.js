// Rider trips, as the Dispatcher pages describe them. Firebase-free.
//
// The state itself is server-owned (functions/src/riderDispatch.js, one
// `riderDispatchStates/{riderUid}` document per Rider). The pages only read it
// to say where a Rider is and whether an order can be given to them; the
// assignRiderToOrder callable makes the actual decision and refuses anything
// these labels got wrong (a stale snapshot, a Rider who left a second ago).

export const RIDER_TRIP_STATES = Object.freeze({
  AVAILABLE: "available_at_hub",
  FORMING: "trip_forming",
  ON_TRIP: "on_trip",
  RETURNING: "returning_to_hub",
});

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What a Dispatcher needs to know about a Rider's trip.
 *
 * `stateDoc` is the Rider's riderDispatchStates document, or undefined when
 * the server has not classified the Rider yet (a Rider untouched since this
 * release) — then the server decides at assignment, from their orders.
 */
export function riderTripStatus(stateDoc) {
  const state = stateDoc?.state;
  const orders = Array.isArray(stateDoc?.orderIds) ? stateDoc.orderIds.length : 0;
  switch (state) {
    case RIDER_TRIP_STATES.AVAILABLE:
      return { key: "available", label: "At the hub", assignable: true, note: "" };
    case RIDER_TRIP_STATES.FORMING:
      return {
        key: "forming",
        label: `Trip forming · ${plural(orders, "order")}`,
        assignable: true,
        note: "Not dispatched yet — this order joins the same trip.",
      };
    case RIDER_TRIP_STATES.ON_TRIP:
      return {
        key: "on_trip",
        label: "On a trip",
        assignable: false,
        note: "Out on a trip. New orders can be assigned once their return to the hub is confirmed.",
      };
    case RIDER_TRIP_STATES.RETURNING:
      return {
        key: "returning",
        label: "Returning to hub",
        assignable: false,
        note: "Every order on their trip is finished. Confirm their return in Cargo Loading before assigning more.",
      };
    default:
      return { key: "unconfirmed", label: "Trip status not confirmed yet", assignable: true, note: "" };
  }
}

/** Map riderUid → state document, from the live collection. */
export function indexRiderStates(docs) {
  const map = new Map();
  for (const d of docs || []) {
    if (d && typeof d.id === "string") map.set(d.id, d);
  }
  return map;
}

/**
 * Riders a Dispatcher still has to confirm back at the hub, newest settled
 * first. `riders` supplies names; a Rider without a profile row is still
 * listed (by a neutral label), never dropped.
 */
export function ridersReturningToHub(states, riders) {
  const byUid = new Map((riders || []).map((r) => [r.uid, r]));
  return [...(states?.values?.() ?? [])]
    .filter((s) => s?.state === RIDER_TRIP_STATES.RETURNING && typeof s.tripId === "string" && s.tripId)
    .map((s) => {
      const r = byUid.get(s.id);
      return {
        riderUid: s.id,
        tripId: s.tripId,
        name: r?.fullName || r?.name || r?.displayName || r?.email || "Rider",
        plate: r?.vehiclePlate || r?.motorcycle || r?.vehicle || "",
        orderCount: Array.isArray(s.orderIds) ? s.orderIds.length : 0,
        settledAtMs: typeof s.settledAt?.toMillis === "function" ? s.settledAt.toMillis() : 0,
      };
    })
    .sort((a, b) => b.settledAtMs - a.settledAtMs || a.name.localeCompare(b.name));
}

/**
 * Can this rider's loading group be dispatched now, and with which trip id?
 * A group whose Rider is already out (orders given before this release while
 * they were on the road) waits for their return; everything else is the
 * server's to check.
 */
export function cargoGroupDispatch(stateDoc) {
  const state = stateDoc?.state;
  if (state === RIDER_TRIP_STATES.ON_TRIP || state === RIDER_TRIP_STATES.RETURNING) {
    return {
      canFinalize: false,
      tripId: null,
      reason: "This rider is still out on a trip. These orders leave on their next trip, after their return to the hub is confirmed.",
    };
  }
  return { canFinalize: true, tripId: state === RIDER_TRIP_STATES.FORMING ? stateDoc.tripId ?? null : null, reason: "" };
}

/**
 * One sentence for the Dispatcher after a "Re-check trip status": how many
 * Riders were re-checked, how many had a stale status corrected, and how many
 * could not be checked (an order the server could not place — refused, not
 * guessed). `results` are recheckRiderTripStates' per-Rider results.
 */
export function describeRecheck(results) {
  const list = Array.isArray(results) ? results : [];
  const checked = list.filter((r) => !r?.error);
  const corrected = checked.filter((r) => r.changed).length;
  const unknown = list.filter((r) => r?.error === "rider-state-unknown").length;
  const parts = [
    `Trip status re-checked for ${plural(checked.length, "rider")}`,
    corrected > 0 ? `${plural(corrected, "status", "statuses")} corrected from their orders` : "all were up to date",
  ];
  let text = `${parts[0]}: ${parts[1]}.`;
  if (unknown > 0) {
    text += ` ${plural(unknown, "rider")} could not be checked — an order needs review, so no trip decision will be made for them.`;
  }
  return { text, corrected, unknown, tone: unknown > 0 ? "error" : "success" };
}
