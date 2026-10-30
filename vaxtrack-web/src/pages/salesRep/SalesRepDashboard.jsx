import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  Loader2,
  Package,
  Plus,
} from "lucide-react";
import { subscribeSalesRepOrders } from "../../services/orderService";
import { subscribeInventory } from "../../services/inventoryService";
import { subscribeVaccines } from "../../services/vaccineCatalogService";
import { useInventoryVisibility } from "../../components/useInventoryVisibility";
import {
  normalizeStatusKey,
  getOrderStatusValue,
  mapOrderStatusType,
} from "../../services/deliveryService";
import { ORDER_STATUSES, STATUS_LABELS } from "../../services/orderWorkflow";
import { PRIORITY_FILTERS, calendarCounts, filterCalendarOrders } from "../../services/deliverySchedule";
import {
  addMonths,
  isInMonth,
  manilaToday,
  monthOf,
  ordersOnDate,
} from "../../services/deliveryCalendar";
import { auth } from "../../firebase";
import KpiCard from "../../components/ui/KpiCard";
import MonthCalendar from "../../components/ui/MonthCalendar";
import StatusBadge from "../../components/ui/StatusBadge";
import RequestedArrivalNote from "../../components/schedule/RequestedArrivalNote";
import { kpiValue, liveErrorMessage } from "../../services/liveDataErrors";

// The key the planner leaves for the checkout page to pick up, so a day chosen
// here pre-fills the order's requested delivery date. Read once and cleared by
// SalesRepPlaceOrder — a one-shot handoff, not persistent state.
const PLANNED_DATE_KEY = "salesRepPlannedDate";

// Pretty label for the selected day, e.g. "Wed, Sep 23, 2026".
function longDate(iso) {
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatDate(ts) {
  if (!ts) return "—";
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatExpiry(dateStr) {
  if (!dateStr) return "—";
  const date = new Date(dateStr + "T00:00:00");
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function getDaysUntilExpiry(dateStr) {
  if (!dateStr) return Infinity;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(dateStr + "T00:00:00");
  return Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function normalizeInventoryRow(raw) {
  const qty = raw.quantity != null ? Number(raw.quantity) : 0;
  const days = getDaysUntilExpiry(raw.expiryDate);

  let status = "Available";
  let statusClass = "available";
  let watch = false;

  if (qty <= 0) {
    status = "Out of stock";
    statusClass = "out";
    watch = true;
  } else if (days <= 30 && days >= 0) {
    status = "Near expiry";
    statusClass = "expiry";
    watch = true;
  } else if (qty <= 100) {
    status = "Low stock";
    statusClass = "low";
    watch = true;
  }

  return {
    id: raw.id,
    vaccineId: raw.vaccineId,
    vaccine: raw.vaccineName || "Unknown vaccine",
    batchId: raw.batchId || raw.id,
    quantity: qty,
    expiry: formatExpiry(raw.expiryDate),
    status,
    statusClass,
    watch,
  };
}

function SalesRepDashboard() {
  const navigate = useNavigate();

  const [orders, setOrders] = useState([]);
  const [ordersLoadingState, setOrdersLoading] = useState(true);
  const [ordersErrorState, setOrdersError] = useState("");
  // Signed-out is derived rather than set from inside the effect.
  const uid = auth.currentUser?.uid ?? null;
  const ordersLoading = uid ? ordersLoadingState : false;
  const ordersError = uid ? ordersErrorState : "Not logged in.";

  const [inventory, setInventory] = useState([]);
  const [rawInventory, setRawInventory] = useState([]);
  const [vaccines, setVaccines] = useState([]);
  const inactiveIds = useInventoryVisibility(vaccines, rawInventory);
  useEffect(() => subscribeVaccines(setVaccines, () => setVaccines([])), []);
  const [invLoading, setInvLoading] = useState(true);
  const [invError, setInvError] = useState("");

  // Planner calendar. `today` is the Manila date the order form validates
  // against, so the highlighted cell and the "no past dates" rule agree with it.
  const today = manilaToday();
  const [view, setView] = useState(() => monthOf(today) || { year: 2026, month: 0 });
  const [selectedDate, setSelectedDate] = useState("");
  const [plannerStatusFilter, setPlannerStatusFilter] = useState("all");
  const [plannerPriorityFilter, setPlannerPriorityFilter] = useState("all");
  const plannerCalendarRef = useRef(null);
  const [plannerCalendarHeight, setPlannerCalendarHeight] = useState(0);

  useEffect(() => {
    const calendar = plannerCalendarRef.current;
    if (!calendar || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => setPlannerCalendarHeight(Math.ceil(calendar.getBoundingClientRect().height)));
    observer.observe(calendar);
    return () => observer.disconnect();
  }, [ordersLoading, invLoading]);

  useEffect(() => {
    if (!uid) return undefined;

    const unsubscribe = subscribeSalesRepOrders(
      uid,
      (raw) => {
        const normalized = raw.map((o) => {
          const rawStatus = getOrderStatusValue(o);
          const statusKey = normalizeStatusKey(rawStatus);
          return {
            id: o.id,
            orderNumber: o.orderNumber || o.id,
            clinicName: o.clinicName || "Unknown clinic",
            clinicAddress: o.clinicAddress || "—",
            vaccineName: o.vaccineName || "—",
            quantity: o.quantity != null ? Number(o.quantity) : 0,
            unit: o.unit || "vials",
            statusKey,
            statusType: mapOrderStatusType(statusKey),
            priority: o.priority,
            date: formatDate(o.createdAt),
            requestedDeliveryDate: o.requestedDeliveryDate || null,
            originalRequestedDeliveryDate: o.originalRequestedDeliveryDate ?? null,
            requestedArrival: o.requestedArrival ?? null,
          };
        });
        setOrders(normalized);
        setOrdersLoading(false);
        setOrdersError("");
      },
      (err) => {
        setOrdersError(liveErrorMessage(err, "your orders"));
        setOrdersLoading(false);
      }
    );

    return unsubscribe;
  }, [uid]);

  useEffect(() => {
    const unsubscribe = subscribeInventory(
      (raw) => {
        setRawInventory(raw);
        // A voided batch (an Admin's record of a mistaken entry) is not stock.
        setInventory(raw.filter((item) => item.voided !== true).map(normalizeInventoryRow));
        setInvLoading(false);
        setInvError("");
      },
      (err) => {
        setInvError(liveErrorMessage(err, "inventory"));
        setInvLoading(false);
      }
    );

    return unsubscribe;
  }, []);

  const metrics = useMemo(() => {
    const total = orders.length;
    const pending = orders.filter(
      (o) => o.statusKey === "pending" || o.statusKey === "pending_dispatch"
    ).length;
    const inTransit = orders.filter((o) => o.statusKey === "in_transit").length;
    const delivered = orders.filter(
      (o) => o.statusKey === "delivered" || o.statusKey === "completed"
    ).length;
    return { total, pending, inTransit, delivered };
  }, [orders]);

  const recentOrders = useMemo(() => orders.slice(0, 6), [orders]);

  const plannerOrders = useMemo(
    () => filterCalendarOrders(orders, { status: plannerStatusFilter, priority: plannerPriorityFilter }),
    [orders, plannerStatusFilter, plannerPriorityFilter]
  );
  const plannerFiltersActive = plannerStatusFilter !== "all" || plannerPriorityFilter !== "all";
  // Day markers reflect the planner filters; checkout validates the chosen date.
  const { counts: planCounts, urgent: planUrgentCounts } = useMemo(() => calendarCounts(plannerOrders), [plannerOrders]);
  const selectedDayOrders = useMemo(
    () => (selectedDate ? ordersOnDate(plannerOrders, selectedDate) : []),
    [plannerOrders, selectedDate]
  );

  // Moving to another month (arrows or the month/year pickers) keeps the
  // selected day only if it is in that month; otherwise the selection is
  // cleared, so the details never describe a day the grid is not showing.
  const showMonth = (next) => {
    setView(next);
    if (selectedDate && !isInMonth(selectedDate, next)) setSelectedDate("");
  };
  const goPrevMonth = () => showMonth(addMonths(view.year, view.month, -1));
  const goNextMonth = () => showMonth(addMonths(view.year, view.month, 1));
  const goCurrentMonth = () => showMonth(monthOf(manilaToday()) || view);
  const jumpToMonth = (year, month) => showMonth({ year, month });

  // Picking a day — including a dimmed day of the previous or next month —
  // also brings that day's month into view, so the grid always shows the
  // selected day and the details beside it.
  const selectPlannerDate = (iso) => {
    setSelectedDate(iso);
    const m = monthOf(iso);
    if (m) setView(m);
  };

  // A date can be viewed at any time, but only today-or-later can be scheduled —
  // the same floor the checkout field and the Cloud Function enforce.
  const canSchedule = Boolean(selectedDate) && selectedDate >= today;

  const scheduleForSelected = () => {
    if (!canSchedule) return;
    try {
      localStorage.setItem(PLANNED_DATE_KEY, selectedDate);
    } catch {
      // A blocked localStorage just means no pre-fill; the date field still works.
    }
    navigate("/sales-rep/request-order");
  };

  const stockToWatch = useMemo(
    () => inventory.filter((r) => r.watch && !inactiveIds.has(r.vaccineId)).slice(0, 8),
    [inventory, inactiveIds]
  );

  const isLoading = ordersLoading || invLoading;

  if (isLoading) {
    return (
      <>
        <div className="srd-loading">
          <Loader2 size={30} className="spin" />
          <p>Loading dashboard...</p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="srd">
        <header className="srd-head">
          <div>
            <h2>Order overview</h2>
            <p>Track your vaccine orders and stock at a glance.</p>
          </div>
          <button
            type="button"
            className="srd-btn srd-btn-primary"
            onClick={() => navigate("/sales-rep/request-order")}
          >
            <Plus size={15} />
            Place order
          </button>
        </header>

        <section className="srd-kpis">
          <KpiCard
            label="Total orders"
            value={kpiValue(metrics.total.toLocaleString(), { error: ordersError })}
            context={`${metrics.delivered} delivered`}
            tone="neutral"
          />
          <KpiCard
            label="Pending dispatch"
            value={kpiValue(metrics.pending.toLocaleString(), { error: ordersError })}
            context="Awaiting dispatch"
            tone="neutral"
          />
          <KpiCard
            label="Delivered"
            value={kpiValue(metrics.delivered.toLocaleString(), { error: ordersError })}
            context="Completed orders"
            tone="success"
          />
          <KpiCard
            label="In transit"
            value={kpiValue(metrics.inTransit.toLocaleString(), { error: ordersError })}
            context="Active shipments"
            tone="info"
          />
        </section>

        <section className="srd-planner-section">
          <div className="srd-card srd-planner">
            <div className="srd-card-head">
              <div>
                <h2>Delivery planner</h2>
                <p>Pick the date your client wants delivery, then build the order.</p>
              </div>
              <span className="srd-planner-legend">
                <CalendarDays size={14} />
                Numbers show orders you've scheduled · red dot = urgent
              </span>
            </div>

            <div className="srd-planner-filters" role="group" aria-label="Delivery planner filters">
              <label className="srd-planner-filter">
                Status
                <select value={plannerStatusFilter} onChange={(event) => setPlannerStatusFilter(event.target.value)}>
                  <option value="all">All statuses</option>
                  {ORDER_STATUSES.map((status) => (
                    <option key={status} value={status}>{STATUS_LABELS[status]}</option>
                  ))}
                </select>
              </label>
              <label className="srd-planner-filter">
                Priority
                <select value={plannerPriorityFilter} onChange={(event) => setPlannerPriorityFilter(event.target.value)}>
                  {PRIORITY_FILTERS.map((priority) => (
                    <option key={priority.value} value={priority.value}>{priority.label}</option>
                  ))}
                </select>
              </label>
              {plannerFiltersActive && (
                <button
                  type="button"
                  className="srd-btn srd-btn-secondary srd-planner-clear"
                  onClick={() => { setPlannerStatusFilter("all"); setPlannerPriorityFilter("all"); }}
                >
                  Clear filters
                </button>
              )}
              <span className="srd-planner-filter-summary" aria-live="polite">
                {plannerOrders.length} of {orders.length} orders shown
              </span>
            </div>

            <div className="srd-planner-body" style={plannerCalendarHeight ? { "--planner-calendar-height": `${plannerCalendarHeight}px` } : undefined}>
              <div className="srd-planner-calendar" ref={plannerCalendarRef}>
                <MonthCalendar
                  year={view.year}
                  month={view.month}
                  today={today}
                  counts={planCounts}
                  urgentCounts={planUrgentCounts}
                  selectedDate={selectedDate}
                  onSelectDate={selectPlannerDate}
                  onPrevMonth={goPrevMonth}
                  onNextMonth={goNextMonth}
                  onCurrentMonth={goCurrentMonth}
                  onJumpToMonth={jumpToMonth}
                  ariaLabel="Delivery planner calendar"
                />
              </div>

              <div className="srd-planner-detail">
                {!selectedDate ? (
                  <div className="srd-planner-empty">
                    <CalendarDays size={20} />
                    <strong>Select a date</strong>
                    <p>
                      Choose a day to schedule a delivery or review what's already
                      booked.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="srd-planner-detail-head">
                      <strong>{longDate(selectedDate)}</strong>
                      <span className="srd-planner-count tnum">
                        {selectedDayOrders.length} scheduled
                      </span>
                    </div>

                    {selectedDayOrders.length === 0 ? (
                      <div className="srd-planner-none">
                        <CalendarDays size={24} aria-hidden="true" />
                        <strong>{plannerFiltersActive ? "No matching orders" : "No orders scheduled"}</strong>
                        <span>{plannerFiltersActive ? "No orders on this date match the filters." : "Orders for this date will appear here."}</span>
                      </div>
                    ) : (
                      <div className="srd-planner-list">
                        {selectedDayOrders.map((o) => (
                          <div key={o.id} className="srd-planner-row">
                            <div className="srd-planner-row-main">
                              <strong>{o.orderNumber}</strong>
                              <small>{o.clinicName}</small>
                              <RequestedArrivalNote order={o} />
                            </div>
                            <StatusBadge statusKey={o.statusKey} />
                          </div>
                        ))}
                      </div>
                    )}

                    <button
                      type="button"
                      className="srd-btn srd-btn-primary srd-planner-cta"
                      onClick={scheduleForSelected}
                      disabled={!canSchedule}
                    >
                      <Plus size={15} />
                      Schedule order for this date
                    </button>
                    {!canSchedule && (
                      <p className="srd-planner-hint">
                        Pick today or a future date to schedule a new order.
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="srd-grid">
          <div className="srd-card">
            <div className="srd-card-head">
              <div>
                <h2>Active orders</h2>
                <p>Your most recent orders.</p>
              </div>
              <button
                type="button"
                className="srd-link"
                onClick={() => navigate("/sales-rep/order-tracking")}
              >
                View all
                <ArrowRight size={14} />
              </button>
            </div>

            {ordersError ? (
              <div className="srd-empty">
                <span className="srd-empty-icon">
                  <AlertTriangle size={18} />
                </span>
                <strong>Could not load orders</strong>
                <p>{ordersError}</p>
              </div>
            ) : recentOrders.length === 0 ? (
              <div className="srd-empty">
                <span className="srd-empty-icon">
                  <Package size={18} />
                </span>
                <strong>No orders yet</strong>
                <p>Place your first order to get started.</p>
                <button
                  type="button"
                  className="srd-btn srd-btn-secondary"
                  onClick={() => navigate("/sales-rep/request-order")}
                >
                  Place order
                </button>
              </div>
            ) : (
              <div className="srd-table-wrap">
                <table className="srd-table">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Clinic</th>
                      <th>Vaccine</th>
                      <th>Status</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentOrders.map((o) => (
                      <tr
                        key={o.id}
                        onClick={() => navigate("/sales-rep/order-tracking")}
                      >
                        <td>
                          <span className="srd-order-id">{o.orderNumber}</span>
                          <RequestedArrivalNote order={o} />
                        </td>
                        <td>{o.clinicName}</td>
                        <td>
                          <div className="srd-vaccine-cell">
                            <strong>{o.vaccineName}</strong>
                            <small className="tnum">
                              {o.quantity.toLocaleString()} {o.unit}
                            </small>
                          </div>
                        </td>
                        <td>
                          <StatusBadge statusKey={o.statusKey} />
                        </td>
                        <td className="srd-td-meta">{o.date}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <aside className="srd-side">
            <div className="srd-card">
              <div className="srd-card-head">
                <div>
                  <h2>Stock to watch</h2>
                  <p>Low or expiring batches.</p>
                </div>
                <button
                  type="button"
                  className="srd-link"
                  onClick={() => navigate("/sales-rep/inventory")}
                >
                  Inventory
                  <ArrowRight size={14} />
                </button>
              </div>

              {invError ? (
                <div className="srd-empty compact">
                  <strong>Could not load inventory</strong>
                  <p>{invError}</p>
                </div>
              ) : stockToWatch.length === 0 ? (
                <div className="srd-empty compact">
                  <strong>All stock levels are healthy</strong>
                  <p>No low or near-expiry batches right now.</p>
                </div>
              ) : (
                <div className="srd-stock-list">
                  {stockToWatch.map((s) => (
                    <div key={s.id} className="srd-stock-row">
                      <div className="srd-stock-info">
                        <strong>{s.vaccine}</strong>
                        <small>
                          {s.batchId} · Exp {s.expiry}
                        </small>
                      </div>
                      <div className="srd-stock-meta">
                        <span className="srd-stock-qty tnum">
                          {s.quantity.toLocaleString()}
                        </span>
                        <span className={`srd-chip srd-chip-${s.statusClass}`}>
                          {s.status}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>
        </section>
      </div>
    </>
  );
}

export default SalesRepDashboard;
