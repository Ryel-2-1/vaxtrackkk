import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarDays, Loader2, Package } from "lucide-react";
import { subscribeDeliveries } from "../../services/deliveryService";
import {
  addMonths,
  countsByDate,
  groupOrdersByRequestedDate,
  manilaToday,
  monthOf,
  ordersOnDate,
} from "../../services/deliveryCalendar";
import DispatcherLayout from "./DispatcherLayout";
import MonthCalendar from "../../components/ui/MonthCalendar";
import StatusBadge from "../../components/ui/StatusBadge";

// Terminal orders need no scheduling action; the "unscheduled" bucket is a
// worklist, so historical delivered/cancelled orders without a date are left out
// of it. They still appear on their day if they ever carried one.
const ACTIVE_STATUSES = new Set([
  "pending",
  "pending_dispatch",
  "assigned",
  "loading",
  "in_transit",
  "delayed",
]);

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

function OrderRow({ order }) {
  return (
    <div className="dsch-row">
      <div className="dsch-row-main">
        <strong>{order.orderNumber || order.id}</strong>
        <small>{order.clinicName || "Unknown clinic"}</small>
      </div>
      <div className="dsch-row-meta">
        <span className="dsch-row-vaccine">
          {order.vaccineName || "—"}
          {order.quantity != null && (
            <em className="tnum">
              {" "}
              · {Number(order.quantity).toLocaleString()} {order.unit || "vials"}
            </em>
          )}
        </span>
        <StatusBadge statusKey={order.statusKey} />
      </div>
    </div>
  );
}

function DispatcherSchedule() {
  const [deliveries, setDeliveries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const today = manilaToday();
  const [view, setView] = useState(() => monthOf(today) || { year: 2026, month: 0 });
  const [selectedDate, setSelectedDate] = useState(today);

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
            ? "You do not have permission to view the schedule."
            : "Unable to load the delivery schedule."
        );
        setLoading(false);
      }
    );
    return unsubscribe;
  }, []);

  const counts = useMemo(() => countsByDate(deliveries), [deliveries]);

  const selectedDayOrders = useMemo(
    () => (selectedDate ? ordersOnDate(deliveries, selectedDate) : []),
    [deliveries, selectedDate]
  );

  const unscheduled = useMemo(() => {
    const { unscheduled: undated } = groupOrdersByRequestedDate(deliveries);
    return undated.filter((o) => ACTIVE_STATUSES.has(o.statusKey));
  }, [deliveries]);

  const goPrevMonth = () => setView((v) => addMonths(v.year, v.month, -1));
  const goNextMonth = () => setView((v) => addMonths(v.year, v.month, 1));

  return (
    <DispatcherLayout active="schedule" title="Delivery Schedule">
      <div className="dsch">
        <header className="dsch-head">
          <div>
            <h2>Delivery schedule</h2>
            <p>
              Orders appear on the date the Sales Rep requested. Pick a day to see
              only that day's deliveries.
            </p>
          </div>
        </header>

        {loading ? (
          <div className="dsch-state">
            <Loader2 size={28} className="spin" />
            <p>Loading schedule…</p>
          </div>
        ) : error ? (
          <div className="dsch-state">
            <AlertTriangle size={22} />
            <strong>Could not load schedule</strong>
            <p>{error}</p>
          </div>
        ) : (
          <div className="dsch-body">
            <div className="dsch-card dsch-calendar-card">
              <MonthCalendar
                year={view.year}
                month={view.month}
                today={today}
                counts={counts}
                selectedDate={selectedDate}
                onSelectDate={setSelectedDate}
                onPrevMonth={goPrevMonth}
                onNextMonth={goNextMonth}
                caption="Numbers show orders requested that day"
                ariaLabel="Delivery schedule calendar"
              />
            </div>

            <div className="dsch-side">
              <div className="dsch-card">
                <div className="dsch-card-head">
                  <div>
                    <h3>{selectedDate ? longDate(selectedDate) : "Select a day"}</h3>
                    <p>
                      {selectedDayOrders.length} order
                      {selectedDayOrders.length === 1 ? "" : "s"} requested
                    </p>
                  </div>
                </div>

                {selectedDayOrders.length === 0 ? (
                  <div className="dsch-empty">
                    <Package size={18} />
                    <strong>Nothing scheduled</strong>
                    <p>No orders were requested for this day.</p>
                  </div>
                ) : (
                  <div className="dsch-list">
                    {selectedDayOrders.map((o) => (
                      <OrderRow key={o.id} order={o} />
                    ))}
                  </div>
                )}
              </div>

              <div className="dsch-card">
                <div className="dsch-card-head">
                  <div>
                    <h3>Unscheduled</h3>
                    <p>
                      {unscheduled.length} active order
                      {unscheduled.length === 1 ? "" : "s"} with no requested date
                    </p>
                  </div>
                </div>

                {unscheduled.length === 0 ? (
                  <div className="dsch-empty">
                    <CalendarDays size={18} />
                    <strong>All active orders are dated</strong>
                    <p>Every open order has a requested delivery date.</p>
                  </div>
                ) : (
                  <div className="dsch-list dsch-list-scroll">
                    {unscheduled.map((o) => (
                      <OrderRow key={o.id} order={o} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </DispatcherLayout>
  );
}

export default DispatcherSchedule;
