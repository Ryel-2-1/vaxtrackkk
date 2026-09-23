import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  ClipboardList,
  Loader2,
  Package,
  Plus,
  Truck,
} from "lucide-react";
import { subscribeSalesRepOrders } from "../../services/orderService";
import { subscribeInventory } from "../../services/inventoryService";
import {
  normalizeStatusKey,
  getOrderStatusValue,
} from "../../services/deliveryService";
import {
  addMonths,
  countsByDate,
  manilaToday,
  monthOf,
  ordersOnDate,
} from "../../services/deliveryCalendar";
import { auth } from "../../firebase";
import SalesRepLayout from "./SalesRepLayout";
import KpiCard from "../../components/ui/KpiCard";
import MonthCalendar from "../../components/ui/MonthCalendar";
import StatusBadge from "../../components/ui/StatusBadge";

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
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [ordersError, setOrdersError] = useState("");

  const [inventory, setInventory] = useState([]);
  const [invLoading, setInvLoading] = useState(true);
  const [invError, setInvError] = useState("");

  // Planner calendar. `today` is the Manila date the order form validates
  // against, so the highlighted cell and the "no past dates" rule agree with it.
  const today = manilaToday();
  const [view, setView] = useState(() => monthOf(today) || { year: 2026, month: 0 });
  const [selectedDate, setSelectedDate] = useState("");

  useEffect(() => {
    const user = auth.currentUser;
    if (!user) {
      setOrdersError("Not logged in.");
      setOrdersLoading(false);
      return;
    }

    const unsubscribe = subscribeSalesRepOrders(
      user.uid,
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
            date: formatDate(o.createdAt),
            requestedDeliveryDate: o.requestedDeliveryDate || null,
          };
        });
        setOrders(normalized);
        setOrdersLoading(false);
        setOrdersError("");
      },
      (err) => {
        if (err?.code === "permission-denied") {
          setOrdersError("Permission denied.");
        } else {
          setOrdersError("Unable to load orders.");
        }
        setOrdersLoading(false);
      }
    );

    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeInventory(
      (raw) => {
        setInventory(raw.map(normalizeInventoryRow));
        setInvLoading(false);
        setInvError("");
      },
      (err) => {
        if (err?.code === "permission-denied") {
          setInvError("Permission denied.");
        } else {
          setInvError("Unable to load inventory.");
        }
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

  // Day markers come from this rep's own orders; the checkout date it validates
  // is the real authority, so this is just a planning overview.
  const planCounts = useMemo(() => countsByDate(orders), [orders]);
  const selectedDayOrders = useMemo(
    () => (selectedDate ? ordersOnDate(orders, selectedDate) : []),
    [orders, selectedDate]
  );

  const goPrevMonth = () => setView((v) => addMonths(v.year, v.month, -1));
  const goNextMonth = () => setView((v) => addMonths(v.year, v.month, 1));

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
    () => inventory.filter((r) => r.watch).slice(0, 5),
    [inventory]
  );

  const quickActions = [
    {
      label: "Request order",
      text: "Create a vaccine request",
      route: "/sales-rep/request-order",
      icon: <ClipboardList size={16} />,
    },
    {
      label: "Track shipment",
      text: "Check delivery status and ETA",
      route: "/sales-rep/order-tracking",
      icon: <Truck size={16} />,
    },
    {
      label: "View alerts",
      text: "Review order and delivery alerts",
      route: "/sales-rep/alerts",
      icon: <AlertTriangle size={16} />,
    },
  ];

  const isLoading = ordersLoading || invLoading;

  if (isLoading) {
    return (
      <SalesRepLayout active="dashboard" title="Dashboard">
        <div className="srd-loading">
          <Loader2 size={30} className="spin" />
          <p>Loading dashboard...</p>
        </div>
      </SalesRepLayout>
    );
  }

  return (
    <SalesRepLayout active="dashboard" title="Dashboard">
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
            value={metrics.total.toLocaleString()}
            context={`${metrics.delivered} delivered`}
            tone="neutral"
          />
          <KpiCard
            label="Pending dispatch"
            value={metrics.pending.toLocaleString()}
            context="Awaiting dispatch"
            tone="neutral"
          />
          <KpiCard
            label="Delivered"
            value={metrics.delivered.toLocaleString()}
            context="Completed orders"
            tone="success"
          />
          <KpiCard
            label="In transit"
            value={metrics.inTransit.toLocaleString()}
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
                Numbers show orders you've scheduled
              </span>
            </div>

            <div className="srd-planner-body">
              <MonthCalendar
                year={view.year}
                month={view.month}
                today={today}
                counts={planCounts}
                selectedDate={selectedDate}
                onSelectDate={setSelectedDate}
                onPrevMonth={goPrevMonth}
                onNextMonth={goNextMonth}
                ariaLabel="Delivery planner calendar"
              />

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
                      <p className="srd-planner-none">
                        No orders scheduled for this day yet.
                      </p>
                    ) : (
                      <div className="srd-planner-list">
                        {selectedDayOrders.map((o) => (
                          <div key={o.id} className="srd-planner-row">
                            <div className="srd-planner-row-main">
                              <strong>{o.orderNumber}</strong>
                              <small>{o.clinicName}</small>
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

            <div className="srd-card">
              <div className="srd-card-head">
                <div>
                  <h2>Quick actions</h2>
                </div>
              </div>

              <div className="srd-actions">
                {quickActions.map((a) => (
                  <button
                    key={a.label}
                    type="button"
                    className="srd-action"
                    onClick={() => navigate(a.route)}
                  >
                    <span className="srd-action-icon">{a.icon}</span>
                    <div>
                      <strong>{a.label}</strong>
                      <small>{a.text}</small>
                    </div>
                    <ArrowRight size={15} />
                  </button>
                ))}
              </div>
            </div>
          </aside>
        </section>
      </div>
    </SalesRepLayout>
  );
}

export default SalesRepDashboard;
