import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { HUB, RIDERS, SCENARIOS, SIM_PROJECT, STOPS } from "../../src/components/dev/explorerFixtures.js";
import { manilaClock } from "../../src/services/requestedArrival.js";
import { legMinutes, planTrip } from "../../src/services/timeAwareRouting.js";
import { encodePolyline, motorcycleRequest } from "../../src/services/routeService.js";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const orders = require("./src/operations.js");
const dispatch = require("./src/riderDispatchOps.js");
const { STATE: CUSTODY } = require("./src/riderDispatch.js");
const tracking = require("./src/riderTrackingOps.js");
const { haversineMeters, distanceToPolylineMeters } = require("./src/riderTracking.js");
const { allocatableUnits } = require("./src/allocation.js");
const { addStockBatchWithAllocation } = require("./src/inventoryWorkflow.js");
const { timingFieldsOnDispatch } = require("./src/deliveryTimingOps.js");
const { canonicalProofPath, canonicalInvoicePath } = require("./src/deliveryEvidence.js");

export const EMULATOR_HOST = "127.0.0.1:8293";
const NOW = Date.parse("2026-11-26T00:00:00Z");
const DAY = manilaClock(new Date(NOW)).date;
const PRICE = 125000;
let firestore;

export async function emulatorReady() {
  try {
    const response = await fetch(`http://${EMULATOR_HOST}/`, { signal: AbortSignal.timeout(1200) });
    return response.ok && (await response.text()).trim() === "Ok";
  } catch {
    return false;
  }
}

function connect() {
  if (firestore) return firestore;
  process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
  firestore = getFirestore(initializeApp({ projectId: SIM_PROJECT }, SIM_PROJECT));
  return firestore;
}

export function labError(message, code = "invalid-action") {
  return Object.assign(new Error(message), { code });
}

const value = (snapshot) => snapshot.exists ? { ...snapshot.data(), id: snapshot.id } : null;
const queryValues = (snapshot) => snapshot.docs.map(value);
const stamp = (ms) => Timestamp.fromMillis(ms);
const kilometers = ([lat, lng], [toLat, toLng]) =>
  haversineMeters({ lat, lng }, { lat: toLat, lng: toLng }) / 1000;
const minutesFrom = (a, b) => a === b ? 0 : Math.max(1, Math.ceil(kilometers(a, b) * 3.1));

export function loadCenter(list) {
  const valid = list.filter((order) =>
    Number.isFinite(order.destinationLat) && Number.isFinite(order.destinationLng) &&
    Number.isFinite(order.quantity) && order.quantity > 0 && order.allocationState === "fully_reserved"
  );
  const units = valid.reduce((sum, order) => sum + order.quantity, 0);
  if (!units) return null;
  return {
    units,
    point: [
      valid.reduce((sum, order) => sum + order.destinationLat * order.quantity, 0) / units,
      valid.reduce((sum, order) => sum + order.destinationLng * order.quantity, 0) / units,
    ],
  };
}

/** Lab allocation of vials to riders. The production planner orders each rider's stops. */
export function balanceStops(list, riders) {
  const loads = riders.map((rider, i) => ({
    rider,
    units: rider.units ?? 0,
    point: rider.lastStop ?? HUB.point,
    orders: [],
    i,
  }));
  const waiting = [];
  for (const order of list) {
    const point = [order.destinationLat, order.destinationLng];
    const candidates = loads
      .filter((load) => load.units + order.quantity <= load.rider.capacity)
      .sort((a, b) =>
        (minutesFrom(a.point, point) + a.units * 2)
        - (minutesFrom(b.point, point) + b.units * 2) || a.i - b.i
      );
    const load = candidates[0];
    if (!load) { waiting.push(order.id); continue; }
    load.units += order.quantity;
    load.point = point;
    load.orders.push(order);
  }
  return { loads, waiting };
}

export function routeForOrders(list, nowMs) {
  const points = [HUB.point, ...list.map((order) => [order.destinationLat, order.destinationLng])];
  const minutes = points.map((a) => points.map((b) => minutesFrom(a, b)));
  const now = manilaClock(new Date(nowMs));
  const input = {
    stops: list.map((order, i) => ({
      id: order.id, matrixIndex: i + 1, requestedDeliveryDate: order.requestedDeliveryDate,
      requestedArrival: order.requestedArrival, serviceMinutes: 5,
    })),
    minutes, planDate: now.date, nowMinute: now.minute, allowWaiting: true, hubReturnIndex: 0,
  };
  const result = planTrip(input);
  if (!result?.etas) return { input, result, route: null };
  const ordered = result.order.map((id) => input.stops.find((stop) => stop.id === id).matrixIndex);
  const sequence = [HUB.point, ...ordered.map((index) => points[index])];
  const distance = sequence.slice(1).reduce((sum, point, i) => sum + kilometers(sequence[i], point), 0);
  return {
    input,
    result,
    route: {
      points: sequence,
      orderIds: result.order,
      distanceMeters: Math.round(distance * 1000),
      durationSeconds: legMinutes(minutes, ordered).reduce((sum, min) => sum + min * 60, 0),
    },
  };
}

export async function makeSession(runId, scenario) {
  const db = connect();
  const id = (suffix) => `${runId}-${suffix}`;
  const ids = { rep: id("rep"), admin: id("admin"), dispatcher: id("dispatcher"), area: id("area"), product: id("vaccine"), quote: id("batch-a") };
  const riders = RIDERS.map((rider) => ({
    ...rider, uid: id(rider.key), offline: false, detour: false, accuracy: 12,
    progress: 0, pendingFix: null, lastFix: null, temperature: 5, activeOrderId: null,
  }));
  const inventory = db.collection("inventory").where("vaccineId", "==", ids.product);
  const orderQuery = db.collection("orders").where("createdByUid", "==", ids.rep);
  const simulate = {
    runId, scenario, db, ids, riders, nowMs: NOW, inventory, orderQuery, events: [],
    clients: new Set(), listeners: new Map(), routes: {}, snapshots: {},
  };
  const batch = db.batch();
  const put = (collection, docId, data) => batch.set(db.collection(collection).doc(docId), data);
  put("users", ids.rep, {
    role: "salesrep", status: "approved", name: "Demo Med Rep",
    assignedAreaIds: [ids.area], assignedClinicIds: STOPS.map((stop) => id(stop.key)),
  });
  put("users", ids.admin, { role: "admin", status: "approved", name: "Demo Admin" });
  put("users", ids.dispatcher, { role: "dispatcher", status: "approved", name: "Demo Dispatcher" });
  put("areas", ids.area, { name: "Demo territory", active: true });
  put("vaccines", ids.product, { vaccineName: "Demo vaccine", vaccineType: "Training", vatClassification: "vatable" });
  put("inventory", ids.quote, {
    vaccineId: ids.product, vaccineName: "Demo vaccine", vaccineType: "Training", batchId: "EXPLORER-A",
    status: "Stable", expiryDate: "2027-12-01", arrivalDate: "2026-11-01",
    quantity: SCENARIOS[scenario].stock, reservedQuantity: 0, sellingPriceCentavos: PRICE, priceIsVatInclusive: true,
  });
  for (const rider of riders) put("users", rider.uid, { role: "rider", status: "approved", name: rider.name });
  const doctor = id("doctor");
  put("doctors", doctor, { name: "Demo Doctor", areaId: ids.area, area: "Demo territory", active: true });
  for (const stop of STOPS) {
    const clinic = id(stop.key);
    put("clinics", clinic, {
      clinicId: stop.key.toUpperCase(), name: stop.name, location: "Synthetic demo coordinate",
      areaId: ids.area, area: "Demo territory", status: "active", locationVerified: true,
      latitude: stop.point[0], longitude: stop.point[1], geofenceRadiusM: 300,
    });
    batch.set(db.collection("doctors").doc(doctor).collection("deliveryAddresses").doc(clinic), { active: true });
  }
  await batch.commit();
  trace(simulate, "lab", "Isolated fixtures created", { projectId: SIM_PROJECT, scenario, stops: STOPS.length, stock: SCENARIOS[scenario].stock });
  return simulate;
}

export function trace(s, channel, title, payload) {
  const event = { id: randomUUID(), channel, title, at: new Date(s.nowMs).toISOString(), payload };
  s.events = [...s.events.slice(-99), event];
  for (const response of s.clients) response.write(`event: trace\ndata: ${JSON.stringify(event)}\n\n`);
}

export function readState(s) {
  const list = s.snapshots.orders ?? [];
  const batches = s.snapshots.inventory ?? [];
  return {
    scenario: s.scenario, nowMs: s.nowMs, orders: list, batches,
    stock: {
      onHand: batches.reduce((sum, batch) => sum + (batch.quantity ?? 0), 0),
      reserved: batches.reduce((sum, batch) => sum + (batch.reservedQuantity ?? 0), 0),
      available: batches.reduce((sum, batch) => sum + allocatableUnits(batch, new Date(s.nowMs)), 0),
    },
    routes: s.routes, riders: s.riders.map(({ pendingFix, lastFix, ...rider }) => ({
      ...rider,
      cached: Boolean(pendingFix),
      location: s.snapshots[`riderLocations/${rider.key}`] ?? null,
      deviation: s.snapshots[`riderDeviationStates/${rider.key}`] ?? null,
      custody: s.snapshots[`riderDispatchStates/${rider.key}`]?.state ?? CUSTODY.AVAILABLE,
      canDepart: s.snapshots[`riderDispatchStates/${rider.key}`]?.state === CUSTODY.FORMING,
    })),
    alerts: s.riders.flatMap((rider) => s.snapshots[`alerts/${rider.key}`] ?? []),
    center: loadCenter(list.filter((order) => order.status !== "delivered" && order.status !== "cancelled")),
    listeners: [...s.listeners.keys()],
  };
}

export function broadcast(s) {
  if (!s.clients.size) return;
  const message = `event: state\ndata: ${JSON.stringify(readState(s))}\n\n`;
  for (const response of s.clients) response.write(message);
}

export function attachListeners(s) {
  if (s.listeners.size) return;
  const watch = (name, ref, transform) => {
    const unsubscribe = ref.onSnapshot((snapshot) => {
      const data = transform(snapshot);
      s.snapshots[name] = data;
      const changes = typeof snapshot.docChanges === "function"
        ? snapshot.docChanges().map(({ type, doc }) => ({ type, doc: value(doc) }))
        : { exists: snapshot.exists, document: data };
      trace(s, "firestore", name, changes);
      broadcast(s);
    }, (error) => trace(s, "firestore", `${name} listener stopped`, { code: error.code ?? "listener-error" }));
    s.listeners.set(name, unsubscribe);
  };
  watch("orders", s.orderQuery, queryValues);
  watch("inventory", s.inventory, queryValues);
  for (const rider of s.riders) {
    for (const name of ["riderLocations", "riderDeviationStates", "riderDispatchStates", "riderNavigationSessions"]) {
      watch(`${name}/${rider.key}`, s.db.collection(name).doc(rider.uid), value);
    }
    watch(`alerts/${rider.key}`, s.db.collection("alerts").where("riderId", "==", rider.uid), queryValues);
  }
}

async function place(s, { stopKey, quantity, urgent }) {
  const stop = STOPS.find((candidate) => candidate.key === stopKey);
  if (!stop || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    throw labError("Choose a stop and a quantity from 1 to 100.");
  }
  const payload = {
    requestId: randomUUID(), doctorId: `${s.runId}-doctor`, doctorAddressId: `${s.runId}-${stopKey}`,
    requestedDeliveryDate: DAY, priority: urgent ? "Urgent" : "Standard",
    requestedArrival: s.scenario === "windows" ? { version: 1, mode: "exact", time: "08:35" } : { version: 1, mode: "any_time" },
    items: [{ inventoryId: s.ids.quote, quantity, expectedUnitPriceCentavos: PRICE }],
  };
  trace(s, "http", "createOrderWithReservation → request", { uid: s.ids.rep, payload });
  const result = await orders.createOrderWithReservation({ db: s.db, FieldValue, uid: s.ids.rep, payload, now: new Date(s.nowMs) });
  trace(s, "http", "createOrderWithReservation ← result", result);
  const reservation = await s.db.collection("inventoryReservations").doc(result.orderId).get();
  trace(s, "firestore", "inventoryReservations · read", value(reservation));
  s.nowMs += 1000;
}

async function optimize(s, body) {
  const list = queryValues(await s.orderQuery.get());
  const pending = list
    .filter((order) => order.status === "pending_dispatch" && order.allocationState === "fully_reserved")
    .sort((a, b) => a.allocationPriorityKey.localeCompare(b.allocationPriorityKey));
  const riders = [];
  for (const rider of s.riders) {
    const custody = value(await s.db.collection("riderDispatchStates").doc(rider.uid).get());
    if (custody && ![CUSTODY.AVAILABLE, CUSTODY.FORMING].includes(custody.state)) continue;
    const assigned = list.filter((order) => order.assignedRiderId === rider.uid && ["assigned", "loading"].includes(order.status));
    const last = assigned.at(-1);
    riders.push({
      ...rider, assigned, units: assigned.reduce((sum, order) => sum + order.quantity, 0),
      lastStop: last ? [last.destinationLat, last.destinationLng] : null,
    });
  }
  const eligible = body.rider === "fleet" ? riders : riders.filter((rider) => rider.key === body.rider);
  if (!eligible.length) throw labError("No available riders can take another trip.");
  const { loads, waiting } = balanceStops(pending, eligible);
  trace(s, "lab", "Fleet assignment heuristic", { loads: loads.map(({ rider, units, orders: assigned }) => ({ rider: rider.key, units, orders: assigned.map((order) => order.id) })), waiting });
  for (const load of loads) {
    const assigned = [...load.rider.assigned];
    for (const order of load.orders) {
      const payload = { orderId: order.id, riderUid: load.rider.uid };
      trace(s, "http", "assignRiderToOrder → request", payload);
      const result = await dispatch.assignRiderToOrder({ db: s.db, FieldValue, uid: s.ids.dispatcher, payload, now: new Date(s.nowMs) });
      trace(s, "http", "assignRiderToOrder ← result", result);
      assigned.push(order);
    }
    if (!assigned.length) continue;
    const { input, result, route } = routeForOrders(assigned, s.nowMs);
    trace(s, "vrp", "Production planner → synthetic travel matrix", { routingProfile: motorcycleRequest(), ...input });
    trace(s, "vrp", "Production planner ← stop order, arrivals and scores", {
      order: result?.order, exact: result?.exact, allMet: result?.allMet,
      stops: result?.plan.stops, return: result?.plan.hubReturn, route,
    });
    if (!route) continue;
    const planId = randomUUID();
    const shape = encodePolyline(route.points);
    s.routes[load.rider.key] = { ...route, exact: result.exact, allMet: result.allMet, stops: result.plan.stops, saved: result.allMet || body.acceptConflicts === true };
    if (!s.routes[load.rider.key].saved) continue;
    const batch = s.db.batch();
    for (const eta of result.etas) {
      const single = result.etas.length === 1;
      const fields = single ? {
        routePolyline: shape, routeDistanceMeters: route.distanceMeters, routeDurationSeconds: eta.etaSeconds,
        routeEtaText: eta.etaText, routeGeneratedAt: FieldValue.serverTimestamp(),
        routeDestinationRevision: 0,
      } : {
        tripId: planId, tripStopCount: result.etas.length, tripPolyline: shape,
        tripDistanceMeters: route.distanceMeters, tripDurationSeconds: route.durationSeconds,
        stopSequence: eta.sequence, stopEtaSeconds: eta.etaSeconds, stopEtaText: eta.etaText,
        tripGeneratedAt: FieldValue.serverTimestamp(),
      };
      batch.update(s.db.collection("orders").doc(eta.orderId), { ...fields, updatedAt: FieldValue.serverTimestamp() });
    }
    await batch.commit();
  }
  if (!loads.some((load) => load.orders.length || load.rider.assigned.length)) {
    throw labError("Place fully reserved orders first. Backordered orders stay in the stock queue.");
  }
}

async function depart(s, rider) {
  const route = s.routes[rider.key];
  if (!route?.saved) throw labError("Save a route for this rider before loading the trip.");
  const refs = route.orderIds.map((id) => s.db.collection("orders").doc(id));
  const before = (await s.db.getAll(...refs)).map(value);
  if (before.some((order) => order?.assignedRiderId !== rider.uid || !["assigned", "loading"].includes(order.status))) {
    throw labError("This rider’s planned orders are no longer waiting to depart.");
  }
  const batch = s.db.batch();
  for (const ref of refs) batch.update(ref, {
    status: "loading", isLoaded: true, loadedAt: FieldValue.serverTimestamp(),
    loadedByUid: s.ids.dispatcher, updatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();
  trace(s, "firestore", "Cargo loading · simulated client write", { status: "loading", isLoaded: true, orderIds: route.orderIds });
  const payload = { riderUid: rider.uid, orderIds: route.orderIds, tripId: before[0].dispatchTripId };
  const result = await dispatch.finalizeRiderDispatch({ db: s.db, FieldValue, uid: s.ids.dispatcher, payload, now: new Date(s.nowMs) });
  trace(s, "http", "finalizeRiderDispatch ← result", result);
  for (const snapshot of await s.db.getAll(...refs)) {
    const stored = value(snapshot);
    const fields = timingFieldsOnDispatch({ dispatched: stored, dispatchedAt: stored.dispatchedAt, current: stored, Timestamp });
    await snapshot.ref.update(fields);
  }
  rider.progress = 0;
  await startNavigation(s, rider, route.orderIds[0]);
}

async function startNavigation(s, rider, orderId) {
  rider.activeOrderId = orderId;
  rider.sessionId = randomUUID();
  const doc = {
    riderUid: rider.uid, orderId, sessionId: rider.sessionId, state: "navigating",
    startedAt: stamp(s.nowMs), updatedAt: stamp(s.nowMs), endedAt: null, endReason: null, continuityVersion: 1,
  };
  await s.db.collection("riderNavigationSessions").doc(rider.uid).set(doc);
  await tracking.handleSessionWrite({ db: s.db, FieldValue, riderUid: rider.uid, after: doc });
}

function riderFix(s, rider) {
  s.nowMs += 30_000;
  const route = s.routes[rider.key].points;
  const target = s.routes[rider.key].orderIds.indexOf(rider.activeOrderId) + 1;
  rider.progress = Math.min(target, rider.progress + 0.25);
  const index = Math.min(route.length - 2, Math.floor(rider.progress));
  const fraction = rider.progress - index;
  const a = route[index], b = route[index + 1];
  const lat = a[0] + (b[0] - a[0]) * fraction;
  const lng = a[1] + (b[1] - a[1]) * fraction;
  const points = route.map(([lat, lng]) => ({ lat, lng }));
  const detour = rider.detour
    ? [[0.015, 0], [-0.015, 0], [0, 0.015], [0, -0.015], [0.11, 0]]
        .map(([dLat, dLng]) => ({ lat: lat + dLat, lng: lng + dLng }))
        .find((candidate) => distanceToPolylineMeters(candidate, points) > 650)
    : null;
  return {
    riderUid: rider.uid,
    latitude: detour?.lat ?? lat,
    longitude: detour?.lng ?? lng,
    accuracyMeters: rider.accuracy, headingDegrees: null, speedMps: null,
    capturedAt: stamp(s.nowMs), trackingState: "active", activeOrderId: rider.activeOrderId,
    navigationSessionId: rider.sessionId, source: "geolocator", schemaVersion: 1,
  };
}

async function sendFix(s, rider, fix) {
  const ref = s.db.collection("riderLocations").doc(rider.uid);
  const previous = rider.lastFix;
  const location = { ...fix, updatedAt: stamp(s.nowMs) };
  await ref.set(location);
  rider.lastFix = location;
  trace(s, "http", "GPS relay → riderLocations", location);
  const result = await tracking.processLocationWrite({ db: s.db, FieldValue, riderUid: rider.uid, location, previous });
  trace(s, "http", "trackRiderLocation ← decision", result);
  if (location.accuracyMeters <= 100 && location.updatedAt.toMillis() - location.capturedAt.toMillis() <= 60_000) {
    await s.db.collection("riderNavigationSessions").doc(rider.uid).update({ lastNavigationFixAt: location.updatedAt, updatedAt: location.updatedAt });
  }
}

async function tick(s, rider) {
  if (!rider.activeOrderId) throw labError("Dispatch a trip before sending GPS.");
  const fix = riderFix(s, rider);
  if (rider.offline) {
    rider.pendingFix = fix;
    trace(s, "lab", "Offline GPS cached · latest sample", fix);
    return;
  }
  await sendFix(s, rider, fix);
}

async function checkIn(s, rider, complete) {
  if (!rider.activeOrderId) throw labError("There is no active stop.");
  if (rider.offline) throw labError("Reconnect this rider before trying the server check-in.");
  const orderId = rider.activeOrderId;
  const now = new Date(s.nowMs);
  const result = await orders.validateDeliveryCompletionGeofence({ db: s.db, uid: rider.uid, orderId, now });
  trace(s, "http", "validateDeliveryCompletionGeofence ← result", result);
  if (!complete) return;
  const ref = s.db.collection("orders").doc(orderId);
  await ref.update({
    proofOfDeliveryPath: canonicalProofPath(orderId), proofOfDeliveryUrl: "https://example.invalid/proof.jpg",
    proofSubmittedAt: FieldValue.serverTimestamp(), proofSubmittedByUid: rider.uid, proofRecipientName: "Demo Recipient",
    invoicePath: canonicalInvoicePath(orderId), invoiceUrl: "https://example.invalid/invoice.jpg",
    invoiceSubmittedAt: FieldValue.serverTimestamp(), invoiceSubmittedByUid: rider.uid,
  });
  trace(s, "lab", "Synthetic delivery and invoice evidence attached", { orderId });
  const delivery = await orders.markOrderDeliveredWithInventoryConsumption({ db: s.db, FieldValue, uid: rider.uid, orderId, now });
  trace(s, "http", "markOrderDeliveredWithInventoryConsumption ← result", delivery);
  const route = s.routes[rider.key];
  const index = route.orderIds.indexOf(orderId);
  const next = route.orderIds[index + 1];
  if (next) await startNavigation(s, rider, next);
  else {
    rider.activeOrderId = null;
    const ended = { state: "ended", endedAt: stamp(s.nowMs), endReason: "completed", updatedAt: stamp(s.nowMs) };
    await s.db.collection("riderNavigationSessions").doc(rider.uid).update(ended);
    await tracking.handleSessionWrite({ db: s.db, FieldValue, riderUid: rider.uid, after: ended });
    await dispatch.reconcileRider({ db: s.db, FieldValue, riderUid: rider.uid });
  }
}

export async function runAction(s, action, body) {
  if (action === "place") return place(s, body);
  if (action === "seed") {
    if (!(await s.orderQuery.limit(1).get()).empty) throw labError("Start a fresh scenario to seed all ten orders.");
    for (const stop of STOPS) await place(s, { stopKey: stop.key, quantity: stop.units, urgent: stop.key === "s05" });
    return;
  }
  if (action === "stock") {
    const quantity = body.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw labError("Enter 1 to 100 vials.");
    const result = await addStockBatchWithAllocation({
      db: s.db, FieldValue, uid: s.ids.admin, now: new Date(s.nowMs),
      payload: {
        vaccineId: s.ids.product, batchId: `LAB-${randomUUID().slice(0, 8)}`, quantity, sellingPriceCentavos: PRICE,
        manufacturingDate: "2026-10-01", arrivalDate: DAY, expiryDate: "2027-11-01", priceIsVatInclusive: true,
      },
    });
    trace(s, "http", "addStockBatchWithAllocation ← result", result);
    return;
  }
  if (action === "optimize") return optimize(s, body);
  const rider = s.riders.find((item) => item.key === body.rider);
  if (!rider) throw labError("Choose a rider.");
  switch (action) {
    case "depart": return depart(s, rider);
    case "tick": return tick(s, rider);
    case "checkIn": return checkIn(s, rider, false);
    case "complete": return checkIn(s, rider, true);
    case "accuracy":
      rider.accuracy = rider.accuracy === 12 ? 150 : 12;
      return trace(s, "lab", "GPS accuracy changed", { rider: rider.key, accuracyMeters: rider.accuracy });
    case "detour":
      rider.detour = !rider.detour;
      return trace(s, "lab", "GPS detour changed", { rider: rider.key, offRoute: rider.detour });
    case "offline":
      rider.offline = !rider.offline;
      trace(s, "lab", rider.offline ? "Rider link paused" : "Rider link restored", { rider: rider.key });
      if (!rider.offline && rider.pendingFix) {
        const fix = rider.pendingFix;
        rider.pendingFix = null;
        await sendFix(s, rider, fix);
      }
      return;
    case "temperature": {
      rider.temperature = rider.temperature > 8 ? 5 : 10;
      const title = rider.temperature > 8 ? "Temperature breach" : "Temperature restored";
      const alert = {
        type: "temperature_simulation", status: rider.temperature > 8 ? "active" : "resolved",
        title, message: `${rider.name} · ${rider.temperature} °C`, source: "simulator",
        riderId: rider.uid, updatedAt: FieldValue.serverTimestamp(),
      };
      await s.db.collection("alerts").doc(`thermal-${rider.uid}`).set(alert);
      return trace(s, "lab", title, { ...alert, rider: rider.key, temperatureC: rider.temperature, thresholdC: 8 });
    }
    default: throw labError("Unknown simulator action.");
  }
}
