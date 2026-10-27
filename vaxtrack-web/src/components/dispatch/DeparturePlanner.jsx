import { useEffect, useId, useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, CalendarClock, CheckCircle2, Info } from "lucide-react";
import { DAY_MINUTES, planDeparture } from "../../services/departurePlanner";
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
 * PLANNING ONLY. Nothing here is saved or sent: it does not dispatch, mark
 * anyone departed, start navigation, change a status or notify the Rider. The
 * actual departure is recorded only by Finalize dispatch.
 *
 * The visiting order is the Dispatcher's (arrows, or "Sort by requested time").
 * Travel and service minutes are typed here because VaxTrack stores no hub
 * location to route from and no service durations; a blank stays blank and
 * makes the plan provisional — nothing is assumed. Entries are keyed by order
 * and its destination revision, so a corrected destination or a changed
 * sequence never reuses a stale number. The plan itself is recomputed from
 * the live orders on every render, so a changed request is reflected at once.
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

function DeparturePlanner({ orders, riderName }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [savedSequence, setSavedSequence] = useState(null);
  const [travel, setTravel] = useState({});
  const [service, setService] = useState({});
  const [allowWaiting, setAllowWaiting] = useState(false);
  const [departure, setDeparture] = useState("");
  const now = useMinuteClock();
  const clock = manilaClock(now);

  const ordersById = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders]);
  const sequence = reconcileSequence(savedSequence, orders);
  const sequenced = sequence.map((oid) => ordersById.get(oid));

  const legKey = (index) => `${index === 0 ? "hub" : keyOf(sequenced[index - 1])}>${keyOf(sequenced[index])}`;
  const plan = planDeparture({
    planDate: clock.date,
    nowMinute: clock.minute,
    allowWaiting,
    departureMinute: minutesOf(departure),
    stops: sequenced.map((order, index) => ({
      id: order.id,
      label: stopName(order),
      requestedDeliveryDate: order.requestedDeliveryDate,
      requestedArrival: order.requestedArrival,
      travelMinutes: travel[legKey(index)] ?? null,
      serviceMinutes: service[keyOf(order)] ?? null,
    })),
  });

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
        <span id={`${id}-title`}>Departure plan</span>
        <small>planning only</small>
      </button>

      {open && (
        <div id={`${id}-body`} className="dp-body">
          <p className="dp-note">
            <Info size={13} aria-hidden="true" />
            Plans when {riderName || "this rider"} should leave the hub for the stops below, from the minutes you enter.
            It saves nothing, dispatches nothing and does not notify the rider. Requested times are arrival at the
            destination; the actual departure is recorded only when dispatch is finalized.
          </p>

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
                          value={travel[leg] ?? ""}
                          onChange={(e) => setTravel((t) => ({ ...t, [leg]: e.target.value }))}
                        />
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
                          value={service[keyOf(order)] ?? ""}
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
    </section>
  );
}

export default DeparturePlanner;
