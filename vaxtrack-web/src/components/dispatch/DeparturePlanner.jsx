import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, CalendarClock, CheckCircle2, Info, Route, SlidersHorizontal, Sparkles, XCircle } from "lucide-react";
import { DAY_MINUTES, PLAN_WARNINGS, planDeparture } from "../../services/departurePlanner";
import { fetchRoute, fetchTravelMatrix, routeThroughStops } from "../../services/routeService";
import { saveOrderRoute, saveRiderTripRoute } from "../../services/orderService";
import { friendlyErrorMessage, logSafeError } from "../../services/liveDataErrors";
import {
  DEADLINE_SLACK_MINUTES,
  matrixMinutes,
  planTrip,
  plannedStopEtas,
  stopLatLng,
  suggestStopOrder,
} from "../../services/timeAwareRouting";
import {
  formatMinute,
  formatRequestedDate,
  hhmmOf,
  manilaClock,
  minutesOf,
  requestedArrivalOf,
} from "../../services/requestedArrival";
import "./DeparturePlanner.css";

/**
 * A Dispatcher's departure plan for one Rider's orders (Cargo Loading).
 *
 * It never dispatches, marks anyone departed, starts navigation, changes a
 * status or notifies the Rider: the actual departure is recorded only by
 * Finalize dispatch. The ONE thing it saves, and only on "Use this plan", is
 * the trip route from the hub in the chosen order with each stop's planned
 * arrival (saveRiderTripRoute) — what the Rider app shows and what the
 * server's delivery timing measures against once dispatched.
 *
 * Travel minutes come from Valhalla motorcycle routing from the hub saved in
 * Admin → Settings → Routing ("Get motorcycle travel times"), with that
 * setting's traffic buffer; any value can still be typed over. Service minutes
 * start at the Admin default. A blank stays blank and makes the plan
 * provisional — nothing is assumed. Entries are keyed by order and its
 * destination revision, so a corrected destination or a changed sequence never
 * reuses a stale number. The plan itself is recomputed from the live orders on
 * every render, so a changed request is reflected at once.
 *
 * The visiting order is the Dispatcher's: arrows, "Sort by requested time", or
 * "Suggest order" (timeAwareRouting.suggestStopOrder).
 */

const keyOf = (order) => `${order.id}@${Number.isInteger(order.destinationRevision) ? order.destinationRevision : 0}`;

function stopName(order) {
  return order.destinationName || order.clinicName || "Destination";
}

/** Saved order of ids, kept to the orders still present; new ones are appended. */
function reconcileSequence(saved, orders) {
  const ids = orders.map((o) => o.id);
  const kept = (saved ?? []).filter((id) => ids.includes(id));
  return [...kept, ...ids.filter((id) => !kept.includes(id))];
}

/**
 * Earliest deadline first: requested date, then latest allowed arrival, then
 * earliest allowed. Ties keep the current order. A heuristic, not optimisation.
 */
function byRequestedTime(sequence, ordersById) {
  const bound = (id) => {
    const spec = requestedArrivalOf(ordersById.get(id));
    switch (spec.mode) {
      case "window":
        return [minutesOf(spec.end), minutesOf(spec.start)];
      case "before":
        return [minutesOf(spec.time) - 1, 0];
      case "exact":
        return [minutesOf(spec.time), minutesOf(spec.time)];
      default:
        return [DAY_MINUTES, 0];
    }
  };
  const dateOf = (id) => {
    const d = ordersById.get(id)?.requestedDeliveryDate;
    return typeof d === "string" ? d : "9999-12-31";
  };
  return [...sequence]
    .map((id, index) => ({ id, index, d: dateOf(id), b: bound(id) }))
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0) || a.b[0] - b.b[0] || a.b[1] - b.b[1] || a.index - b.index)
    .map((x) => x.id);
}

const OUTCOME_LABEL = {
  ok: "Meets request",
  early: "Too early",
  late: "Too late",
  date: "Wrong day",
  unknown: "Unknown",
};

function useMinuteClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30 * 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** The automatic plan, in plain terms: when to leave, and each stop's arrival against its request. */
function TripResult({ result, hubName, ordersById, busy, onSaveAnyway }) {
  const { plan, saved, allMet, exact } = result;
  // The generic caveats live in the manual view; here only what concerns this plan.
  const generic = new Set([PLAN_WARNINGS.destinationHours, PLAN_WARNINGS.hubHours, PLAN_WARNINGS.traffic]);
  const notes = plan.warnings.filter((w) => !generic.has(w) && !w.startsWith("Travel times are Valhalla"));
  return (
    <div className={`dp-result ${allMet ? "dp-result-ok" : "dp-result-conflict"}`} role="status">
      <p className="dp-result-head">
        {allMet ? <CheckCircle2 size={15} aria-hidden="true" /> : <XCircle size={15} aria-hidden="true" />}
        <strong>{allMet ? "Every requested arrival is met" : "A requested arrival cannot be met"}</strong>
        <span>{saved ? "· Saved as the trip" : "· Not saved"}</span>
      </p>
      {Number.isInteger(plan.evaluatedDeparture) && (
        <p className="dp-result-leave tnum">
          Leave {hubName || "the hub"} at <strong>{formatMinute(plan.evaluatedDeparture)}</strong>
        </p>
      )}
      <ol className="dp-result-stops">
        {plan.stops.map((row) => {
          const order = ordersById.get(row.id);
          const met = row.outcome === "ok";
          return (
            <li key={row.id}>
              <span className={`dp-result-mark ${met ? "ok" : "miss"}`} aria-label={met ? "Meets request" : "Misses request"}>
                {met ? "✓" : "✗"}
              </span>
              <div>
                <strong>{order ? stopName(order) : "Destination"}</strong>{" "}
                <span className="tnum">
                  {row.arrival === null ? "arrival unknown" : `arrives ${formatMinute(row.arrival) || "after midnight"}`}
                  {row.wait > 0 && `, waits ${row.wait} min, delivers ${formatMinute(row.serviceStart)}`}
                </span>
                <small>
                  Requested: {row.requestLabel}
                  {!met && row.note ? ` — ${row.note}` : ""}
                </small>
              </div>
            </li>
          );
        })}
      </ol>
      {notes.length > 0 && (
        <ul className="dp-result-notes">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {!exact && <p className="dp-hint">With this many stops the order is a best effort, not every possibility.</p>}
      {!saved && result.etas && (
        <div className="dp-result-confirm">
          <p>This is the closest plan. Nothing is saved unless you confirm.</p>
          <button type="button" className="dp-btn" onClick={onSaveAnyway} disabled={busy}>
            Save this trip anyway
          </button>
        </div>
      )}
    </div>
  );
}

/** Matrix row/column of each point: the hub, then each order's key. */
const hubKeyOf = (hub) => (hub ? `hub@${hub.latLng[0]},${hub.latLng[1]}` : null);

function DeparturePlanner({ orders, riderName, routing = null }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [savedSequence, setSavedSequence] = useState(null);
  const [travel, setTravel] = useState({});
  const [service, setService] = useState({});
  // Waiting is allowed by default; the plan still prefers the least waiting,
  // and a long wait is flagged (routing.longWaitMinutes).
  const [allowWaiting, setAllowWaiting] = useState(true);
  const [departure, setDeparture] = useState("");
  // Valhalla travel times: { hubKey, keys: [orderKey...], seconds } — row i+1 is keys[i].
  const [matrix, setMatrix] = useState(null);
  const [busy, setBusy] = useState(null); // null | "auto" | "times" | "save"
  // The last automatic plan: { plan, order, saved, exact } — shown as the result card.
  const [autoResult, setAutoResult] = useState(null);
  const [manual, setManual] = useState(false);
  const [message, setMessage] = useState(null); // { tone: "error"|"success"|"info", text }
  const inFlight = useRef(false);
  const now = useMinuteClock();
  const clock = manilaClock(now);

  const ordersById = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders]);
  const sequence = reconcileSequence(savedSequence, orders);
  const sequenced = sequence.map((oid) => ordersById.get(oid));

  const hub = routing?.hub ?? null;
  const bufferPercent = routing?.trafficBufferPercent ?? 0;
  const defaultService = routing ? String(routing.serviceMinutes) : null;
  // A matrix is used only for the hub it was fetched from.
  const liveMatrix = matrix && matrix.hubKey === hubKeyOf(hub) ? matrix : null;
  const minutes = useMemo(() => (liveMatrix ? matrixMinutes(liveMatrix.seconds, bufferPercent) : null), [liveMatrix, bufferPercent]);
  const matrixIndexOf = (order) => {
    if (!liveMatrix || !order) return -1;
    const i = liveMatrix.keys.indexOf(keyOf(order));
    return i < 0 ? -1 : i + 1;
  };
  const routedLeg = (index) => {
    if (!minutes) return null;
    const from = index === 0 ? 0 : matrixIndexOf(sequenced[index - 1]);
    const to = matrixIndexOf(sequenced[index]);
    if (from < 0 || to < 0) return null;
    const m = minutes[from]?.[to];
    return Number.isInteger(m) ? m : null;
  };

  const legKey = (index) => `${index === 0 ? "hub" : keyOf(sequenced[index - 1])}>${keyOf(sequenced[index])}`;
  // A typed value wins; otherwise the routed one. Clearing a typed value returns to the routed one.
  const travelValue = (index) => {
    const typed = travel[legKey(index)];
    if (typed !== undefined && String(typed).trim() !== "") return typed;
    const routed = routedLeg(index);
    return routed === null ? "" : String(routed);
  };
  const isRouted = (index) => {
    const typed = travel[legKey(index)];
    return (typed === undefined || String(typed).trim() === "") && routedLeg(index) !== null;
  };
  const serviceValue = (order) => service[keyOf(order)] ?? defaultService ?? "";
  const anyRouted = sequenced.some((_, index) => isRouted(index));

  const routedNote = `Travel times are Valhalla motorcycle estimates plus a ${bufferPercent}% traffic buffer; live traffic and delays are not modelled.`;
  const plan = planDeparture({
    planDate: clock.date,
    nowMinute: clock.minute,
    allowWaiting,
    slackMinutes: DEADLINE_SLACK_MINUTES,
    departureMinute: minutesOf(departure),
    longWaitMinutes: routing?.longWaitMinutes ?? null,
    travelNote: anyRouted ? routedNote : null,
    stops: sequenced.map((order, index) => ({
      id: order.id,
      label: stopName(order),
      requestedDeliveryDate: order.requestedDeliveryDate,
      requestedArrival: order.requestedArrival,
      travelMinutes: travelValue(index) === "" ? null : travelValue(index),
      serviceMinutes: serviceValue(order) === "" ? null : serviceValue(order),
    })),
  });

  // ---- what each action needs ----
  const missingLocation = sequenced.filter((o) => !stopLatLng(o));
  const timesBlocker = !routing
    ? "Loading the routing settings…"
    : !hub
      ? "Set the hub location in Admin → Settings → Routing to get motorcycle travel times."
      : missingLocation.length > 0
        ? `${missingLocation.map(stopName).join(", ")} ${missingLocation.length === 1 ? "has" : "have"} no map location, so travel times cannot be routed.`
        : null;
  const allMatrixed = !!minutes && sequenced.every((o) => matrixIndexOf(o) > 0);
  const etas = plannedStopEtas(plan);
  const saveBlocker = timesBlocker
    ? timesBlocker
    : !allMatrixed
        ? "Get motorcycle travel times first."
        : !etas
          ? "Complete the plan (every travel and service time) before using it."
          : null;

  async function getTravelTimes() {
    if (timesBlocker || inFlight.current) return;
    inFlight.current = true;
    setBusy("times");
    setMessage(null);
    try {
      const keys = sequenced.map(keyOf);
      const seconds = await fetchTravelMatrix([hub.latLng, ...sequenced.map(stopLatLng)]);
      setMatrix({ hubKey: hubKeyOf(hub), keys, seconds });
      const unreachable = seconds.some((row) => row.some((s) => s === Infinity));
      setMessage(
        unreachable
          ? { tone: "info", text: "Motorcycle travel times loaded. Some legs have no motorcycle route — those stay blank." }
          : { tone: "success", text: `Motorcycle travel times loaded from ${hub.name}, with a ${bufferPercent}% traffic buffer.` }
      );
    } catch (err) {
      logSafeError("Departure planner travel times", err);
      setMessage({ tone: "error", text: friendlyErrorMessage(err, "Travel times could not be loaded. Nothing changed — try again.") });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  function suggestOrder() {
    if (!allMatrixed) return;
    const result = suggestStopOrder({
      stops: sequenced.map((order) => ({
        id: order.id,
        matrixIndex: matrixIndexOf(order),
        requestedDeliveryDate: order.requestedDeliveryDate,
        requestedArrival: order.requestedArrival,
        serviceMinutes: serviceValue(order),
      })),
      minutes,
      planDate: clock.date,
      nowMinute: clock.minute,
      allowWaiting,
      slackMinutes: DEADLINE_SLACK_MINUTES,
    });
    if (!result) {
      setMessage({ tone: "error", text: "No order could be suggested: a leg has no motorcycle route, or a service time is missing." });
      return;
    }
    setSavedSequence(result.order);
    // The typed travel overrides belonged to the old legs; the routed times fill the new ones.
    setTravel({});
    setDeparture("");
    setMessage({
      tone: result.score.unmet === 0 ? "success" : "info",
      text:
        (result.score.unmet === 0
          ? "Suggested order meets every requested arrival."
          : `No order meets every requested arrival; this one misses ${result.score.unmet} by the fewest minutes.`) +
        (result.exact ? "" : " With this many stops the order is a best effort, not every possibility."),
    });
  }

  /**
   * Save `ordered` (orders in visiting order) with their planned arrivals:
   * several stops become one trip from the hub; a single stop becomes its
   * order's route from the hub. Throws on failure; nothing is half-saved
   * (the trip is one batch, the single route one update).
   */
  async function saveRoute(ordered, plannedEtas) {
    if (ordered.length === 1) {
      const order = ordered[0];
      const route = await fetchRoute(hub.latLng, stopLatLng(order));
      await saveOrderRoute(
        order.id,
        { ...route, etaText: plannedEtas[0]?.etaText || "" },
        Number.isSafeInteger(order.destinationRevision) ? order.destinationRevision : 0
      );
      return;
    }
    const route = await routeThroughStops(
      hub.latLng,
      ordered.map((order) => ({ orderId: order.id, latLng: stopLatLng(order) }))
    );
    await saveRiderTripRoute({ ...route, stops: plannedEtas });
  }

  async function usePlan() {
    if (saveBlocker || !etas || inFlight.current) return;
    inFlight.current = true;
    setBusy("save");
    setMessage(null);
    try {
      await saveRoute(sequenced, etas);
      setMessage({
        tone: "success",
        text: `Saved as ${riderName || "the rider"}'s trip from ${hub.name}, in this order, with planned arrivals. Delivery timing uses them once dispatch is finalized.`,
      });
      setAutoResult(null);
    } catch (err) {
      logSafeError("Departure planner save", err);
      setMessage({ tone: "error", text: friendlyErrorMessage(err, "The plan could not be saved. Nothing was changed — try again.") });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  /**
   * One click: motorcycle travel times from the hub → the stop order and
   * departure that meet every requested arrival (with slack) → saved as the
   * trip. If a requested arrival cannot be met, nothing is saved until the
   * Dispatcher confirms with "Save anyway".
   */
  async function autoPlan({ force = false } = {}) {
    if (timesBlocker || inFlight.current) return;
    inFlight.current = true;
    setBusy("auto");
    setMessage(null);
    try {
      // Reuse travel times already loaded for exactly these stops and this hub.
      const keys = sequenced.map(keyOf);
      let current = liveMatrix && keys.every((k) => liveMatrix.keys.includes(k)) ? liveMatrix : null;
      if (!current) {
        const seconds = await fetchTravelMatrix([hub.latLng, ...sequenced.map(stopLatLng)]);
        current = { hubKey: hubKeyOf(hub), keys, seconds };
        setMatrix(current);
      }
      const result = planTrip({
        stops: sequenced.map((order) => ({
          id: order.id,
          label: stopName(order),
          matrixIndex: current.keys.indexOf(keyOf(order)) + 1,
          requestedDeliveryDate: order.requestedDeliveryDate,
          requestedArrival: order.requestedArrival,
          serviceMinutes: serviceValue(order),
        })),
        minutes: matrixMinutes(current.seconds, bufferPercent),
        planDate: clock.date,
        nowMinute: clock.minute,
        allowWaiting: true,
        slackMinutes: DEADLINE_SLACK_MINUTES,
        longWaitMinutes: routing.longWaitMinutes,
        travelNote: routedNote,
      });
      if (!result) {
        setAutoResult(null);
        setMessage({ tone: "error", text: "No trip could be planned: a stop has no motorcycle route from the others. Nothing was saved." });
        return;
      }
      // The manual view mirrors the plan, so "Adjust manually" starts from it.
      setSavedSequence(result.order);
      setTravel({});
      setAllowWaiting(true);
      setDeparture(Number.isInteger(result.plan.evaluatedDeparture) ? hhmmOf(result.plan.evaluatedDeparture) : "");
      const ordered = result.order.map((oid) => ordersById.get(oid));
      if (!result.etas) {
        setAutoResult({ ...result, saved: false });
        setMessage({ tone: "error", text: "The plan has an unknown arrival, so it was not saved." });
        return;
      }
      if (!result.allMet && !force) {
        setAutoResult({ ...result, saved: false });
        return;
      }
      await saveRoute(ordered, result.etas);
      setAutoResult({ ...result, saved: true });
    } catch (err) {
      logSafeError("Departure planner automatic plan", err);
      setMessage({ tone: "error", text: friendlyErrorMessage(err, "The trip could not be planned. Nothing was saved — try again.") });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  const move = (index, delta) => {
    const next = [...sequence];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setSavedSequence(next);
  };

  const statusText =
    plan.status === "feasible"
      ? "Every requested arrival is met"
      : plan.status === "incomplete"
        ? "Provisional — some travel or service times are missing"
        : plan.departureInPast
          ? "The planned departure has already passed"
          : plan.conflicts.length > 0 && plan.conflicts.every((c) => c.outcome === "date")
            ? "An order here is requested for another day — no departure today can meet it"
            : plan.infeasible
            ? "No departure today meets every request in this order"
            : "Conflicts with a requested arrival";

  return (
    <section className="dp" aria-labelledby={`${id}-title`}>
      <button
        type="button"
        className="dp-toggle"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={() => setOpen((v) => !v)}
      >
        <CalendarClock size={14} aria-hidden="true" />
        <span id={`${id}-title`}>Plan trip</span>
        <small>stop order and departure that meet requested arrival times</small>
      </button>

      {open && (
        <div id={`${id}-body`} className="dp-body">
          <p className="dp-note">
            <Info size={13} aria-hidden="true" />
            Plans {riderName || "this rider"}&apos;s motorcycle trip from {hub ? hub.name : "the hub"}: the stop order and
            departure time that meet every requested arrival, keeping {DEADLINE_SLACK_MINUTES} min to spare where it can.
            It saves the route and planned arrivals; it does not dispatch or notify the rider.
          </p>

          <div className="dp-route-actions">
            <button
              type="button"
              className="dp-btn dp-btn-primary"
              onClick={() => autoPlan()}
              disabled={!!timesBlocker || busy !== null}
              aria-describedby={timesBlocker ? `${id}-auto-hint` : undefined}
            >
              <Sparkles size={13} aria-hidden="true" />
              {busy === "auto" ? "Planning…" : autoResult?.saved ? "Plan again" : "Plan trip"}
            </button>
          </div>
          {timesBlocker && (
            <p id={`${id}-auto-hint`} className="dp-hint">
              {timesBlocker}
            </p>
          )}
          {message && !manual && (
            <p className={`dp-message dp-message-${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>
              {message.text}
            </p>
          )}

          {autoResult && (
            <TripResult
              result={autoResult}
              hubName={hub?.name}
              ordersById={ordersById}
              busy={busy !== null}
              onSaveAnyway={() => autoPlan({ force: true })}
            />
          )}

          <button
            type="button"
            className="dp-link"
            aria-expanded={manual}
            aria-controls={`${id}-manual`}
            onClick={() => setManual((v) => !v)}
          >
            <SlidersHorizontal size={13} aria-hidden="true" />
            {manual ? "Hide manual adjustments" : "Adjust manually"}
          </button>

          {manual && (
            <div id={`${id}-manual`} className="dp-manual">
          <div className="dp-route-actions">
            <button type="button" className="dp-btn" onClick={getTravelTimes} disabled={!!timesBlocker || busy !== null}>
              <Route size={13} aria-hidden="true" />
              {busy === "times" ? "Getting travel times…" : allMatrixed ? "Refresh travel times" : "Get motorcycle travel times"}
            </button>
            <button type="button" className="dp-btn" onClick={suggestOrder} disabled={!allMatrixed || busy !== null}>
              <Sparkles size={13} aria-hidden="true" />
              Suggest order
            </button>
            <button
              type="button"
              className="dp-btn dp-btn-primary"
              onClick={usePlan}
              disabled={!!saveBlocker || busy !== null}
              aria-describedby={`${id}-save-hint`}
            >
              {busy === "save" ? "Saving…" : plan.status === "conflict" ? "Use this plan anyway" : "Use this plan"}
            </button>
          </div>
          <p id={`${id}-save-hint`} className="dp-hint">
            {saveBlocker ||
              (plan.status === "conflict"
                ? "This plan misses a requested arrival (see Result). Using it saves it as it is."
                : "Saves the motorcycle route from the hub in this order, with each stop's planned arrival.")}
          </p>
          {message && (
            <p className={`dp-message dp-message-${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>
              {message.text}
            </p>
          )}

          <div className="dp-controls">
            <label className="dp-field" htmlFor={`${id}-departure`}>
              <span>Planned departure (today, {formatRequestedDate(clock.date)})</span>
              <input
                id={`${id}-departure`}
                type="time"
                step="60"
                value={departure}
                onChange={(e) => setDeparture(e.target.value)}
              />
            </label>
            {plan.recommended !== null && (
              <button type="button" className="dp-btn" onClick={() => setDeparture(hhmmOf(plan.recommended))}>
                Use suggested {formatMinute(plan.recommended)}
              </button>
            )}
            {departure && (
              <button type="button" className="dp-btn" onClick={() => setDeparture("")}>
                Clear
              </button>
            )}
            <label className="dp-check" htmlFor={`${id}-wait`}>
              <input
                id={`${id}-wait`}
                type="checkbox"
                checked={allowWaiting}
                onChange={(e) => setAllowWaiting(e.target.checked)}
              />
              Rider may wait at a stop until its requested time
            </label>
            <button
              type="button"
              className="dp-btn"
              onClick={() => setSavedSequence(byRequestedTime(sequence, ordersById))}
            >
              Sort by requested time
            </button>
          </div>

          <div className="dp-table-wrap">
            <table className="dp-table">
              <thead>
                <tr>
                  <th scope="col">Stop</th>
                  <th scope="col">Travel in (min)</th>
                  <th scope="col">Requested arrival</th>
                  <th scope="col">Est. arrival</th>
                  <th scope="col">Service (min)</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {plan.stops.map((row, index) => {
                  const order = sequenced[index];
                  const name = stopName(order);
                  const leg = legKey(index);
                  return (
                    <tr key={order.id} className={`dp-row dp-${row.outcome}`}>
                      <td>
                        <div className="dp-stop">
                          <span className="dp-seq tnum">{index + 1}</span>
                          <div>
                            <strong>{name}</strong>
                            <small className="tnum">{order.orderNumber || order.id}</small>
                          </div>
                          <span className="dp-move">
                            <button type="button" className="dp-move-btn" aria-label={`Move ${name} earlier`} disabled={index === 0} onClick={() => move(index, -1)}>
                              <ArrowUp size={12} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="dp-move-btn"
                              aria-label={`Move ${name} later`}
                              disabled={index === plan.stops.length - 1}
                              onClick={() => move(index, 1)}
                            >
                              <ArrowDown size={12} aria-hidden="true" />
                            </button>
                          </span>
                        </div>
                      </td>
                      <td>
                        <input
                          className="dp-min"
                          type="number"
                          inputMode="numeric"
                          min="0"
                          max={DAY_MINUTES}
                          step="1"
                          aria-label={`Travel minutes into stop ${index + 1}, ${name}, from ${index === 0 ? "the hub" : "the previous stop"}`}
                          value={travelValue(index)}
                          onChange={(e) => setTravel((t) => ({ ...t, [leg]: e.target.value }))}
                        />
                        {isRouted(index) && <small className="dp-routed">Valhalla +{bufferPercent}%</small>}
                      </td>
                      <td>
                        {row.requestLabel}
                        {row.dateIssue && <small className="dp-date">{formatRequestedDate(row.requestedDeliveryDate) || "No date"}</small>}
                      </td>
                      <td className="tnum">
                        {row.arrival === null ? (
                          "—"
                        ) : (
                          <>
                            {formatMinute(row.arrival) || "After midnight"}
                            {row.wait > 0 && (
                              <small>
                                waits {row.wait} min · delivers {formatMinute(row.serviceStart)}
                              </small>
                            )}
                          </>
                        )}
                      </td>
                      <td>
                        <input
                          className="dp-min"
                          type="number"
                          inputMode="numeric"
                          min="0"
                          max={DAY_MINUTES}
                          step="1"
                          aria-label={`Service minutes at stop ${index + 1}, ${name}`}
                          value={serviceValue(order)}
                          onChange={(e) => setService((s) => ({ ...s, [keyOf(order)]: e.target.value }))}
                        />
                      </td>
                      <td>
                        <span className={`dp-outcome dp-outcome-${row.outcome}`}>{OUTCOME_LABEL[row.outcome]}</span>
                        {row.note && <small>{row.note}</small>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className={`dp-summary dp-summary-${plan.status}`} role="status">
            <p className="dp-status">
              {plan.status === "feasible" ? <CheckCircle2 size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}
              <strong>{statusText}</strong>
            </p>
            <dl className="dp-facts">
              <div>
                <dt>Suggested departure</dt>
                <dd className="tnum">{plan.recommended !== null ? formatMinute(plan.recommended) : "—"}</dd>
              </div>
              <div>
                <dt>{plan.dateBlocked ? "Departures that meet every other request" : "Departures that meet every request"}</dt>
                <dd className="tnum">
                  {plan.window
                    ? plan.window.from === plan.window.to
                      ? `Only ${formatMinute(plan.window.from)}`
                      : `${formatMinute(plan.window.from)} to ${formatMinute(plan.window.to)}`
                    : plan.missing.length > 0
                      ? "Enter the missing minutes"
                      : "None today"}
                </dd>
              </div>
              <div>
                <dt>Times shown for</dt>
                <dd className="tnum">
                  {plan.evaluatedDeparture === null
                    ? "—"
                    : `${plan.evaluatedSource === "planned" ? "Planned" : plan.evaluatedSource === "recommended" ? "Suggested" : "Closest possible"} departure ${formatMinute(plan.evaluatedDeparture)}`}
                </dd>
              </div>
              {plan.totalWait > 0 && (
                <div>
                  <dt>Total waiting</dt>
                  <dd className="tnum">{plan.totalWait} min</dd>
                </div>
              )}
            </dl>
            {plan.missing.length > 0 && (
              <p className="dp-missing">
                Missing:{" "}
                {plan.missing
                  .map((m) => `${m.kind === "travel" ? "travel into" : "service at"} stop ${m.index + 1}`)
                  .join(", ")}
                .
              </p>
            )}
            <ul className="dp-warnings">
              {plan.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            <p className="dp-objective">How the suggestion is chosen: {plan.objective}</p>
          </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default DeparturePlanner;
