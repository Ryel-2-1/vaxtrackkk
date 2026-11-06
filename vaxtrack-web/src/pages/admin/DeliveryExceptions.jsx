import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight } from "lucide-react";
import StatusBadge from "../../components/ui/StatusBadge";
import { orderReference } from "../../services/orderLabel";

/**
 * Admin › Alerts — deliveries that stopped and need a person (delayed or
 * failed). This is where the banner that used to sit on Deliveries lives now;
 * the top bar's bell counts the same list. Derived live from the orders
 * themselves (subscribeDeliveryExceptions), so it clears on its own once an
 * order moves on — there is nothing to resolve here.
 */
export default function DeliveryExceptions({ exceptions, error }) {
  if (error) {
    return (
      <section className="alerts-exceptions" aria-labelledby="alerts-exceptions-title">
        <h2 id="alerts-exceptions-title">Delivery exceptions</h2>
        <p className="alerts-exceptions-error" role="alert">{error}</p>
      </section>
    );
  }
  if (exceptions.length === 0) return null;

  const delayed = exceptions.filter((o) => o.statusKey === "delayed").length;
  const failed = exceptions.length - delayed;
  return (
    <section className="alerts-exceptions" aria-labelledby="alerts-exceptions-title">
      <div className="alerts-exceptions-head">
        <AlertTriangle size={16} aria-hidden="true" />
        <div>
          <h2 id="alerts-exceptions-title">
            {exceptions.length} deliver{exceptions.length === 1 ? "y" : "ies"} stopped and need
            {exceptions.length === 1 ? "s" : ""} review
          </h2>
          <p>{delayed} delayed, {failed} failed — oldest first.</p>
        </div>
      </div>
      <ul className="alerts-exceptions-list">
        {exceptions.map((order) => (
          <li key={order.id}>
            <strong className="tnum">{orderReference(order, order.id)}</strong>
            <StatusBadge statusKey={order.statusKey} />
            <span className="alerts-exceptions-where">
              {order.clinicName || order.destinationName || "Destination not recorded"}
              {order.assignedRiderName ? ` · ${order.assignedRiderName}` : ""}
            </span>
            <Link className="alerts-exceptions-review" to={`/admin/deliveries?order=${encodeURIComponent(order.id)}`}>
              Review <ArrowRight size={13} aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
