import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  Loader2,
  Package,
  X,
} from "lucide-react";
import { subscribeDeliveries } from "../../services/deliveryService";
import { subscribeUsers } from "../../services/userService";
import { fetchOrderMedRepNames } from "../../services/orderMedRepNames";
import { friendlyErrorMessage, liveErrorMessage, logSafeError } from "../../services/liveDataErrors";
import { ORDER_STATUSES, STATUS_LABELS } from "../../services/orderWorkflow";
import { addMonths, isInMonth, manilaToday, monthOf } from "../../services/deliveryCalendar";
import {
  PRIORITY_FILTERS,
  calendarCounts,
  calendarDay,
  filterCalendarOrders,
  isUrgent,
  medRepNameFor,
  originalRequestNote,
  scheduleLabel,
  scheduledDateOf,
  scheduledTimeOf,
  unscheduledOrders,
  validateReschedule,
} from "../../services/deliverySchedule";
import { rescheduleOrderDelivery } from "../../services/scheduleCallables";
import useManilaDayNow from "../useManilaDayNow";
import MonthCalendar from "../ui/MonthCalendar";
import PageNav, { PAGE_SIZE } from "../ui/PageNav";
import { useDialogFocus } from "../ui/useDialogFocus";
import AdminDialogLayer from "../admin/AdminDialogLayer";
import DeliveryEventCard from "./DeliveryEventCard";
import { capitalizedOrderPhrase, orderDestination, orderReference } from "../../services/orderLabel";
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

function RescheduleDialog({ order, todayIso, onClose, onSaved }) {
  const current = scheduledDateOf(order);
  const [date, setDate] = useState(current && current >= todayIso ? current : todayIso);
  const [time, setTime] = useState(scheduledTimeOf(order) || "");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef(null);
  const firstFieldRef = useRef(null);

  // The shared modal behaviour: focus starts on the first field, Escape closes
  // (unless a save is in flight), Tab stays inside — the dialog declares
  // aria-modal, so the page behind must not be reachable — focus returns to
  // the opener, and the page is locked and put back where it was.
  useDialogFocus({ dialogRef, initialRef: firstFieldRef, onDismiss: onClose, busy: saving });

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
      logSafeError("Reschedule delivery", err);
      setError(friendlyErrorMessage(err, "The schedule could not be changed. Nothing was saved — please try again."));
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
            <strong>{orderReference(order, orderDestination(order) || "Order without a number")}</strong> · currently {scheduleLabel(order)}
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
  const [medRepLookup, setMedRepLookup] = useState({ query: null, names: {}, failed: false });

  const now = useManilaDayNow();
  const today = manilaToday(now);
  const [view, setView] = useState(() => monthOf(today) || { year: 2026, month: 0 });
  const [selectedDate, setSelectedDate] = useState(today);
  const [dayPage, setDayPage] = useState(1);
  const [unscheduledPage, setUnscheduledPage] = useState(1);
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
        setError(liveErrorMessage(err, "the delivery calendar"));
        setLoading(false);
      }
    );
    return unsubscribe;
  }, []);

  // Admin may read the staff directory. Dispatcher gets only the names of
  // owners for orders visible on the current calendar pages from a callable.
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
  const currentDayPage = Math.min(dayPage, Math.max(1, Math.ceil(dayOrders.length / PAGE_SIZE)));
  const pageDayOrders = dayOrders.slice((currentDayPage - 1) * PAGE_SIZE, currentDayPage * PAGE_SIZE);
  const currentUnscheduledPage = Math.min(unscheduledPage, Math.max(1, Math.ceil(unscheduled.length / PAGE_SIZE)));
  const pageUnscheduled = unscheduled.slice((currentUnscheduledPage - 1) * PAGE_SIZE, currentUnscheduledPage * PAGE_SIZE);
  const visibleLookupIds = useMemo(() => [...new Set([
    ...dayOrders.slice((currentDayPage - 1) * PAGE_SIZE, currentDayPage * PAGE_SIZE),
    ...unscheduled.slice((currentUnscheduledPage - 1) * PAGE_SIZE, currentUnscheduledPage * PAGE_SIZE),
  ].filter((order) => order.createdByUid && order.id).map((order) => order.id))],
  [dayOrders, currentDayPage, unscheduled, currentUnscheduledPage]);
  useEffect(() => {
    if (isAdmin || visibleLookupIds.length === 0) return undefined;
    let cancelled = false;
    fetchOrderMedRepNames(visibleLookupIds)
      .then((names) => {
        if (!cancelled) setMedRepLookup({ query: visibleLookupIds, names, failed: false });
      })
      .catch((error) => {
        logSafeError("Calendar Med Rep names", error);
        if (!cancelled) setMedRepLookup({ query: visibleLookupIds, names: {}, failed: true });
      });
    return () => { cancelled = true; };
  }, [isAdmin, visibleLookupIds]);
  const dayUrgent = dayOrders.filter(isUrgent).length;
  const filtersActive = statusFilter !== "all" || priorityFilter !== "all";

  const showMonth = (next) => {
    setView(next);
    if (selectedDate && !isInMonth(selectedDate, next)) setSelectedDate(null);
    setDayPage(1);
  };
  const goPrevMonth = () => showMonth(addMonths(view.year, view.month, -1));
  const goNextMonth = () => showMonth(addMonths(view.year, view.month, 1));
  const jumpToMonth = (year, month) => showMonth({ year, month });
  const goCurrentMonth = () => {
    setView(monthOf(today) || view);
    setSelectedDate(today);
    setDayPage(1);
  };

  const selectDay = (date) => {
    setSelectedDate(date);
    setView(monthOf(date) || view);
    setDayPage(1);
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
    setNotice(`${capitalizedOrderPhrase(order)} is now scheduled for ${scheduleLabel(moved)}.`);
    const target = result?.requestedDeliveryDate;
    if (target) {
      setSelectedDate(target);
      setDayPage(1);
      const m = monthOf(target);
      if (m) setView(m);
    }
  };

  const medRepOf = (order) => {
    const resolvedName = medRepLookup.query === visibleLookupIds ? medRepLookup.names[order.id] : null;
    const name = medRepNameFor(order, isAdmin ? usersById : null, resolvedName);
    if (name || isAdmin || !order.createdByUid) return name;
    return medRepLookup.query !== visibleLookupIds
      ? "Looking up Med Rep…"
      : medRepLookup.failed ? "Name unavailable" : null;
  };

  return (
    <div className="dcal">
      {/* The shell top bar owns the page <h1>. The toolbar matches the Med Rep
          Delivery planner's: Status and Priority on the left, the count and
          legend on the right. (The intro line was removed 2026-10-31.) */}
      <div className="dcal-filters" role="group" aria-label="Calendar filters">
        <label className="dcal-filter">
          Status
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setDayPage(1); setUnscheduledPage(1); }}>
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
          <select value={priorityFilter} onChange={(e) => { setPriorityFilter(e.target.value); setDayPage(1); setUnscheduledPage(1); }}>
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
              setDayPage(1);
              setUnscheduledPage(1);
            }}
          >
            Clear filters
          </button>
        ) : null}
        <div className="dcal-filter-meta">
          {!loading && !error ? (
            <p className="dcal-filter-summary" aria-live="polite">
              {filtered.length} of {deliveries.length} order{deliveries.length === 1 ? "" : "s"} shown
            </p>
          ) : null}
          <span className="dcal-legend">
            <CalendarDays size={14} aria-hidden="true" />
            Numbers = scheduled orders · red dot = urgent
          </span>
        </div>
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
              onSelectDate={selectDay}
              onPrevMonth={goPrevMonth}
              onNextMonth={goNextMonth}
              onCurrentMonth={goCurrentMonth}
              onJumpToMonth={jumpToMonth}
              caption="Numbers show scheduled orders · red dot = urgent"
              ariaLabel="Delivery calendar"
            />
          </div>

          <div className="dcal-side">
            <section className="dcal-card dcal-day-card" aria-labelledby="dcal-day-title">
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
                <ul className="dcal-list dcal-day-list">
                  {pageDayOrders.map((o) => (
                    <DeliveryEventCard
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
              {dayOrders.length > PAGE_SIZE && <PageNav page={currentDayPage} total={dayOrders.length} onPageChange={setDayPage} label="Selected day order pages" />}
            </section>

            <section className={`dcal-card dcal-unscheduled-card${unscheduled.length === 0 ? " is-empty" : ""}`} aria-labelledby="dcal-unscheduled-title">
              <div className="dcal-card-head">
                <h2 id="dcal-unscheduled-title">Unscheduled — needs scheduling</h2>
                {unscheduled.length > 0 && <p>
                  {unscheduled.length} active order{unscheduled.length === 1 ? "" : "s"} without
                  a usable delivery date. None can be dispatched until an Admin
                  {isAdmin ? " gives it a date with Change date & time." : " stores a valid date."}
                </p>}
              </div>

              {unscheduled.length === 0 ? (
                <div className="dcal-empty">
                  <CalendarDays size={18} aria-hidden="true" />
                  <strong>{filtersActive ? "No unscheduled orders match these filters" : "All active orders are dated"}</strong>
                </div>
              ) : (
                <ul className="dcal-list dcal-list-scroll">
                  {pageUnscheduled.map((o) => (
                    <DeliveryEventCard
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
              {unscheduled.length > PAGE_SIZE && <PageNav page={currentUnscheduledPage} total={unscheduled.length} onPageChange={setUnscheduledPage} label="Unscheduled order pages" />}
            </section>
          </div>
        </div>
      )}

      {/* Admin-only, and portaled (AdminDialogLayer): inside the Admin page's
          transformed <main> it was centred in the whole long calendar and
          opened off-screen once the page was scrolled. */}
      {isAdmin && editing ? (
        <AdminDialogLayer>
          <RescheduleDialog
            order={editing}
            todayIso={today}
            onClose={closeReschedule}
            onSaved={handleSaved}
          />
        </AdminDialogLayer>
      ) : null}
    </div>
  );
}

export default DeliveryCalendar;
