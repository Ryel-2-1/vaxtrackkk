import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CalendarDays,
  Clock,
  Loader2,
  Package,
  X,
} from "lucide-react";
import { subscribeDeliveries } from "../../services/deliveryService";
import { subscribeUsers } from "../../services/userService";
import { ORDER_STATUSES, STATUS_LABELS } from "../../services/orderWorkflow";
import { addMonths, manilaToday, monthOf } from "../../services/deliveryCalendar";
import {
  dispatchEligibility,
  isEarlyDispatchAnomaly,
  SCHEDULED_DATE_NOT_REACHED,
} from "../../services/dispatchEligibility";
import {
  PRIORITY_FILTERS,
  calendarCounts,
  calendarDay,
  canReschedule,
  eventDestination,
  filterCalendarOrders,
  isUrgent,
  medRepNameFor,
  originalRequestNote,
  priorityLabel,
  scheduleLabel,
  scheduledDateOf,
  scheduledTimeOf,
  unscheduledOrders,
  validateReschedule,
} from "../../services/deliverySchedule";
import { rescheduleOrderDelivery } from "../../services/scheduleCallables";
import useManilaDayNow from "../useManilaDayNow";
import MonthCalendar from "../ui/MonthCalendar";
import StatusBadge from "../ui/StatusBadge";
import "./DeliveryCalendar.css";

/**
 * The Delivery Calendar, shared by Admin and Dispatcher.
 *
 * Orders sit on their scheduled Manila day — the date the Med Rep requested,
 * unless an Admin has since moved it (then the original request is shown too).
 * Both roles read the same `orders` subscription; only `role="admin"` gets the
 * "Change date & time" control, and even that only calls the server
 * (rescheduleOrderDelivery) — the rules refuse a direct write.
 *
 * Urgent orders are listed first and marked, but urgency changes no figure.
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

function longDate(iso) {
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function Field({ label, value }) {
  return (
    <div className="dcal-field">
      <dt>{label}</dt>
      <dd className={value ? "" : "dcal-field-missing"}>{value || "Not recorded"}</dd>
    </div>
  );
}

function EventCard({ order, now, medRep, isAdmin, onReschedule }) {
  const urgent = isUrgent(order);
  const where = eventDestination(order);
  const original = originalRequestNote(order);
  const note = scheduleNote(order, now);
  const titleId = `dcal-ev-${order.id}`;

  return (
    <li className={`dcal-event${urgent ? " dcal-event-urgent" : ""}`} aria-labelledby={titleId}>
      <div className="dcal-event-head">
        <strong id={titleId} className="dcal-event-id">{order.orderNumber || order.id}</strong>
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

      <dl className="dcal-fields">
        <Field label="Doctor" value={where.doctor} />
        <Field label="Clinic" value={where.clinic} />
        <Field label="Location" value={where.location} />
        <Field label="Med Rep" value={medRep} />
      </dl>

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

function RescheduleDialog({ order, todayIso, onClose, onSaved }) {
  const current = scheduledDateOf(order);
  const [date, setDate] = useState(current && current >= todayIso ? current : todayIso);
  const [time, setTime] = useState(scheduledTimeOf(order) || "");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef(null);
  const firstFieldRef = useRef(null);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  // Escape closes (unless a save is in flight) and Tab stays inside: the dialog
  // declares aria-modal, so the page behind must not be reachable.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        if (!saving) {
          e.stopPropagation();
          onClose();
        }
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const items = [
        ...root.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      ].filter((el) => !el.disabled && el.getClientRects().length > 0);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!root.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [saving, onClose]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    const check = validateReschedule({ date, time, order, todayIso });
    if (!check.ok) {
      setError(check.message);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result = await rescheduleOrderDelivery({
        orderId: order.id,
        requestedDeliveryDate: check.value.requestedDeliveryDate,
        scheduledDeliveryTime: check.value.scheduledDeliveryTime,
        reason,
      });
      onSaved(order, result);
    } catch (err) {
      setError(err?.message || "The schedule could not be changed. Nothing was saved.");
      setSaving(false);
    }
  };

  const dispatched = ["assigned", "loading", "in_transit", "delayed", "delivery_failed"].includes(order.statusKey);

  return (
    <div className="dcal-overlay">
      <div
        ref={dialogRef}
        className="dcal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dcal-dialog-title"
        aria-describedby="dcal-dialog-desc"
      >
        <div className="dcal-dialog-head">
          <h3 id="dcal-dialog-title">Change delivery schedule</h3>
          <button
            type="button"
            className="dcal-icon-btn"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div id="dcal-dialog-desc" className="dcal-dialog-desc">
          <p>
            <strong>{order.orderNumber || order.id}</strong> · currently {scheduleLabel(order)}
          </p>
          {originalRequestNote(order) ? <p>{originalRequestNote(order)}</p> : null}
          {dispatched ? (
            <p className="dcal-dialog-warn">
              This order is already {String(order.statusLabel || order.statusKey).toLowerCase()}.
              The rider assignment stays as it is — let the rider know about the new schedule.
            </p>
          ) : null}
          <p className="dcal-muted">
            Only the date and time change. Price, VAT, discount, reserved stock and
            destination are left exactly as they are.
          </p>
        </div>

        <form className="dcal-form" onSubmit={handleSubmit} noValidate>
          <label className="dcal-label">
            Delivery date <span className="dcal-muted">(Asia/Manila)</span>
            <input
              ref={firstFieldRef}
              type="date"
              value={date}
              min={todayIso}
              onChange={(e) => setDate(e.target.value)}
              required
              disabled={saving}
            />
          </label>
          <label className="dcal-label">
            Delivery time <span className="dcal-muted">(optional)</span>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              disabled={saving}
            />
          </label>
          <label className="dcal-label">
            Reason <span className="dcal-muted">(optional, kept in the history)</span>
            <textarea
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={saving}
            />
          </label>

          {error ? (
            <p className="dcal-form-error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="dcal-dialog-actions">
            <button type="button" className="dcal-secondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="dcal-primary" disabled={saving}>
              {saving ? <Loader2 size={14} className="spin" aria-hidden="true" /> : null}
              {saving ? "Saving…" : "Save schedule"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * @param {object} props
 * @param {"admin"|"dispatcher"} props.role
 */
function DeliveryCalendar({ role }) {
  const isAdmin = role === "admin";
  const [deliveries, setDeliveries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [usersById, setUsersById] = useState(null);

  const now = useManilaDayNow();
  const today = manilaToday(now);
  const [view, setView] = useState(() => monthOf(today) || { year: 2026, month: 0 });
  const [selectedDate, setSelectedDate] = useState(today);
  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState("");
  const triggerRef = useRef(null);

  useEffect(() => {
    const unsubscribe = subscribeDeliveries(
      (orders) => {
        setDeliveries(orders);
        setLoading(false);
        setError("");
      },
      (err) => {
        setError(
          err?.code === "permission-denied"
            ? "You do not have permission to view the delivery calendar."
            : "Unable to load the delivery calendar."
        );
        setLoading(false);
      }
    );
    return unsubscribe;
  }, []);

  // Med Rep names come from the user directory, which only an Admin may read.
  // A failure here is not fatal: entries fall back to the order's own snapshot.
  useEffect(() => {
    if (!isAdmin) return undefined;
    return subscribeUsers(
      (users) => setUsersById(new Map(users.map((u) => [u.id, u]))),
      () => setUsersById(null)
    );
  }, [isAdmin]);

  const filtered = useMemo(
    () => filterCalendarOrders(deliveries, { status: statusFilter, priority: priorityFilter }),
    [deliveries, statusFilter, priorityFilter]
  );
  const { counts, urgent } = useMemo(() => calendarCounts(filtered), [filtered]);
  const dayOrders = useMemo(
    () => (selectedDate ? calendarDay(filtered, selectedDate) : []),
    [filtered, selectedDate]
  );
  const unscheduled = useMemo(() => unscheduledOrders(filtered), [filtered]);
  const dayUrgent = dayOrders.filter(isUrgent).length;
  const filtersActive = statusFilter !== "all" || priorityFilter !== "all";

  const goPrevMonth = () => setView((v) => addMonths(v.year, v.month, -1));
  const goNextMonth = () => setView((v) => addMonths(v.year, v.month, 1));
  const goCurrentMonth = () => {
    setView(monthOf(today) || view);
    setSelectedDate(today);
  };

  const openReschedule = (order, trigger) => {
    triggerRef.current = trigger || null;
    setNotice("");
    setEditing(order);
  };
  const closeReschedule = useCallback(() => {
    setEditing(null);
    if (triggerRef.current) {
      triggerRef.current.focus();
      triggerRef.current = null;
    }
  }, []);
  const handleSaved = (order, result) => {
    setEditing(null);
    triggerRef.current = null;
    const moved = { ...order, requestedDeliveryDate: result?.requestedDeliveryDate, scheduledDeliveryTime: result?.scheduledDeliveryTime };
    setNotice(`${order.orderNumber || order.id} is now scheduled for ${scheduleLabel(moved)}.`);
    const target = result?.requestedDeliveryDate;
    if (target) {
      setSelectedDate(target);
      const m = monthOf(target);
      if (m) setView(m);
    }
  };

  const medRepOf = (order) => medRepNameFor(order, isAdmin ? usersById : null);

  return (
    <div className="dcal">
      {/* The shell top bar owns the page <h1>; this is the intro line only. */}
      <header className="dcal-head">
        <div>
          <p>
            Orders appear on their scheduled day — the date the Med Rep requested,
            unless an Admin has since changed it. Dates and times are Asia/Manila.
            Urgent orders are listed first.
          </p>
        </div>
      </header>

      <div className="dcal-filters" role="group" aria-label="Calendar filters">
        <label className="dcal-filter">
          Status
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All statuses</option>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s] || s}
              </option>
            ))}
          </select>
        </label>
        <label className="dcal-filter">
          Priority
          <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}>
            {PRIORITY_FILTERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {filtersActive ? (
          <button
            type="button"
            className="dcal-secondary dcal-clear"
            onClick={() => {
              setStatusFilter("all");
              setPriorityFilter("all");
            }}
          >
            Clear filters
          </button>
        ) : null}
        {!loading && !error ? (
          <p className="dcal-filter-summary" aria-live="polite">
            {filtered.length} of {deliveries.length} order{deliveries.length === 1 ? "" : "s"} shown
          </p>
        ) : null}
      </div>

      {notice ? (
        <p className="dcal-notice" role="status">
          {notice}
        </p>
      ) : null}

      {loading ? (
        <div className="dcal-state" role="status">
          <Loader2 size={28} className="spin" aria-hidden="true" />
          <p>Loading delivery calendar…</p>
        </div>
      ) : error ? (
        <div className="dcal-state" role="alert">
          <AlertTriangle size={22} aria-hidden="true" />
          <strong>Could not load the delivery calendar</strong>
          <p>{error}</p>
        </div>
      ) : deliveries.length === 0 ? (
        <div className="dcal-state">
          <Package size={22} aria-hidden="true" />
          <strong>No orders yet</strong>
          <p>Deliveries appear here as Med Reps place orders.</p>
        </div>
      ) : (
        <div className="dcal-body">
          <div className="dcal-card dcal-calendar-card">
            <MonthCalendar
              year={view.year}
              month={view.month}
              today={today}
              counts={counts}
              urgentCounts={urgent}
              selectedDate={selectedDate}
              onSelectDate={setSelectedDate}
              onPrevMonth={goPrevMonth}
              onNextMonth={goNextMonth}
              onCurrentMonth={goCurrentMonth}
              caption="Numbers show scheduled orders · red dot = urgent"
              ariaLabel="Delivery calendar"
            />
          </div>

          <div className="dcal-side">
            <section className="dcal-card" aria-labelledby="dcal-day-title">
              <div className="dcal-card-head">
                <h2 id="dcal-day-title">{selectedDate ? longDate(selectedDate) : "Select a day"}</h2>
                <p>
                  {dayOrders.length} scheduled order{dayOrders.length === 1 ? "" : "s"}
                  {dayUrgent > 0 ? ` · ${dayUrgent} urgent` : ""}
                  {filtersActive ? " (filtered)" : ""}
                </p>
              </div>

              {dayOrders.length === 0 ? (
                <div className="dcal-empty">
                  <CalendarDays size={18} aria-hidden="true" />
                  <strong>Nothing scheduled</strong>
                  <p>
                    {filtersActive
                      ? "No order on this day matches the current filters."
                      : "No delivery is scheduled for this day."}
                  </p>
                </div>
              ) : (
                <ul className="dcal-list">
                  {dayOrders.map((o) => (
                    <EventCard
                      key={o.id}
                      order={o}
                      now={now}
                      medRep={medRepOf(o)}
                      isAdmin={isAdmin}
                      onReschedule={openReschedule}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section className="dcal-card" aria-labelledby="dcal-unscheduled-title">
              <div className="dcal-card-head">
                <h2 id="dcal-unscheduled-title">Unscheduled — needs scheduling</h2>
                <p>
                  {unscheduled.length} active order{unscheduled.length === 1 ? "" : "s"} without
                  a usable delivery date. None can be dispatched until an Admin
                  {isAdmin ? " gives it a date with Change date & time." : " stores a valid date."}
                </p>
              </div>

              {unscheduled.length === 0 ? (
                <div className="dcal-empty">
                  <CalendarDays size={18} aria-hidden="true" />
                  <strong>All active orders are dated</strong>
                  <p>Every open order has a delivery date.</p>
                </div>
              ) : (
                <ul className="dcal-list dcal-list-scroll">
                  {unscheduled.map((o) => (
                    <EventCard
                      key={o.id}
                      order={o}
                      now={now}
                      medRep={medRepOf(o)}
                      isAdmin={isAdmin}
                      onReschedule={openReschedule}
                    />
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}

      {isAdmin && editing ? (
        <RescheduleDialog
          order={editing}
          todayIso={today}
          onClose={closeReschedule}
          onSaved={handleSaved}
        />
      ) : null}
    </div>
  );
}

export default DeliveryCalendar;
