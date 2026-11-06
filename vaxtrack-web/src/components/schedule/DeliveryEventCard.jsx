import { AlertTriangle, CalendarClock, Clock } from "lucide-react";
import {
  dispatchEligibility,
  isEarlyDispatchAnomaly,
  SCHEDULED_DATE_NOT_REACHED,
} from "../../services/dispatchEligibility";
import {
  canReschedule,
  eventDestination,
  isUrgent,
  originalRequestNote,
  priorityLabel,
  scheduleLabel,
  scheduledDateOf,
  scheduledTimeOf,
} from "../../services/deliverySchedule";
import StatusBadge from "../ui/StatusBadge";
import { orderDestination, orderReference } from "../../services/orderLabel";
import { requestedArrivalLabel, requestedArrivalOf } from "../../services/requestedArrival";
import "./DeliveryEventCard.css";

/**
 * One scheduled order as a calendar card — shared by the Delivery Calendar
 * (Admin, Dispatcher) and the Med Rep dashboard's Delivery planner, so an
 * order reads the same on every role's calendar.
 *
 * Urgent orders get a tinted card, a red "Urgent" chip beside the status (the
 * chip carries the meaning in text, so colour is never the only signal) and
 * the full fields — requested arrival, doctor, clinic, location, Med Rep.
 * Standard orders are compact: one line naming doctor and clinic.
 *
 * Options for the Med Rep planner, which lists only the rep's own orders:
 *   showMedRep={false}       — the Med Rep row would always be themselves;
 *   showScheduleNote={false} — the dispatch-eligibility note is operations
 *                              detail for Dispatcher and Admin.
 * `isAdmin` + `onReschedule` add Admin's "Change date & time" control.
 */

// Statuses still waiting to (re-)enter dispatch, where a blocked date matters.
const PRE_DISPATCH = new Set(["pending_dispatch", "assigned", "loading", "delivery_failed"]);

// The schedule's own reading of an order, from the same rule the dispatch
// queue, the services and firestore.rules apply. Null when there is nothing
// to add to the status badge.
function scheduleNote(order, now) {
  const schedule = dispatchEligibility(order, now);
  if (isEarlyDispatchAnomaly(order, order.statusKey, now)) {
    return { tone: "anomaly", text: "Early dispatch — dispatched before its scheduled date" };
  }
  if (!PRE_DISPATCH.has(order.statusKey) || schedule.eligible) return null;
  if (schedule.code === SCHEDULED_DATE_NOT_REACHED) {
    return { tone: "hold", text: "Upcoming — not dispatchable until 00:00 that day" };
  }
  // Missing or invalid: the exact operator message from the shared rule.
  return { tone: "anomaly", text: schedule.message };
}

function Field({ label, value }) {
  return (
    <div className="dcal-field">
      <dt>{label}</dt>
      <dd className={value ? "" : "dcal-field-missing"}>{value || "Not recorded"}</dd>
    </div>
  );
}

export default function DeliveryEventCard({
  order,
  now,
  medRep,
  isAdmin = false,
  onReschedule,
  showMedRep = true,
  showScheduleNote = true,
}) {
  const urgent = isUrgent(order);
  const where = eventDestination(order);
  const original = originalRequestNote(order);
  const note = showScheduleNote ? scheduleNote(order, now) : null;
  const titleId = `dcal-ev-${order.id}`;

  return (
    <li className={`dcal-event${urgent ? " dcal-event-urgent" : ""}`} aria-labelledby={titleId}>
      <div className="dcal-event-head">
        <strong id={titleId} className="dcal-event-id">{orderReference(order, orderDestination(order) || "Order without a number")}</strong>
        <span className={`dcal-priority${urgent ? " dcal-priority-urgent" : ""}`}>
          {urgent ? <AlertTriangle size={12} aria-hidden="true" /> : null}
          {priorityLabel(order)}
        </span>
        <StatusBadge statusKey={order.statusKey} />
      </div>

      <p className="dcal-event-when">
        <Clock size={13} aria-hidden="true" />
        <span className="tnum">{scheduleLabel(order)}</span>
        {!scheduledTimeOf(order) && scheduledDateOf(order) ? (
          <span className="dcal-muted"> · no set time</span>
        ) : null}
      </p>
      {original ? <p className="dcal-event-original">{original}</p> : null}

      {urgent ? (
        <dl className="dcal-fields">
          {/* The Med Rep's requested ARRIVAL at the destination — separate from
              any time an Admin schedule sets above. */}
          <Field label="Requested arrival" value={requestedArrivalLabel(requestedArrivalOf(order))} />
          <Field label="Doctor" value={where.doctor} />
          <Field label="Clinic" value={where.clinic} />
          <Field label="Location" value={where.location} />
          {showMedRep ? <Field label="Med Rep" value={medRep} /> : null}
        </dl>
      ) : (
        /* Standard orders are compact (2026-11-01): one line naming where it
           goes; the full fields are kept for urgent orders. */
        <p className="dcal-event-summary">
          {[where.doctor, where.clinic].filter(Boolean).join(" · ") || "Destination not recorded"}
          {showMedRep && medRep ? <span className="dcal-muted"> · {medRep}</span> : null}
        </p>
      )}

      {note ? (
        <p className={note.tone === "anomaly" ? "dcal-note dcal-note-anomaly" : "dcal-note"}>
          {note.text}
        </p>
      ) : null}

      {isAdmin ? (
        canReschedule(order) ? (
          <button
            type="button"
            className="dcal-action"
            onClick={(e) => onReschedule(order, e.currentTarget)}
          >
            <CalendarClock size={14} aria-hidden="true" />
            Change date &amp; time
          </button>
        ) : (
          <p className="dcal-muted dcal-closed-note">Closed orders keep their final schedule.</p>
        )
      ) : null}
    </li>
  );
}
