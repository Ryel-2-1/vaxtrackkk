import { Camera, CheckCircle2, Circle, CircleAlert, Navigation, XCircle } from "lucide-react";
import { requestedArrivalLabel, requestedArrivalOf } from "../../services/requestedArrival";

const ICONS = { delivered: CheckCircle2, proof: Camera, attention: CircleAlert, cancelled: XCircle };

export function StopProgressBadge({ progress }) {
  const Icon = ICONS[progress.state] ?? Circle;
  return (
    <span className={`stop-progress-badge is-${progress.state}`}>
      <Icon size={14} aria-hidden="true" />{progress.label}
    </span>
  );
}

export default function TripProgress({ progress, riderName, selectedId }) {
  if (!progress) return null;
  const { stops, delivered, proofRecorded, cancelled, navigationTarget, nextUnfinished } = progress;
  const target = navigationTarget ?? nextUnfinished;
  return (
    <section className="geo3-card stop-progress" aria-label="Trip stop progress">
      <div className="stop-progress-heading">
        <div><h3>Trip progress</h3><p>{riderName || "Assigned rider"} · {stops.length} stops in this saved plan</p></div>
        <p className="stop-progress-count" role="status" aria-live="polite" aria-atomic="true">
          {delivered} of {stops.length} delivered · {proofRecorded} proof recorded{cancelled > 0 ? ` · ${cancelled} cancelled` : ""}
        </p>
      </div>
      <div className="stop-progress-target" role="status" aria-live="polite" aria-atomic="true">
        <Navigation size={17} aria-hidden="true" />
        <span>{target
          ? `${navigationTarget ? "Navigation target" : "Next unfinished stop"}: Stop ${target.order.stopSequence} · ${target.order.clinicName || target.order.orderNumber || "Destination"}`
          : "No unfinished stops in this saved plan. Check any failed or cancelled deliveries."}</span>
      </div>
      <p className="stop-progress-note">The navigation target is reported by the Rider. When unavailable, the next unfinished stop follows the saved plan. Use GPS to check the reported position.</p>
      <ol className="stop-progress-list">
        {stops.map((stop) => (
          <li key={stop.order.id} className={`stop-progress-item is-${stop.state}${stop.navigating ? " is-navigating" : ""}`}>
            <span className="stop-progress-number" aria-label={`Stop ${stop.order.stopSequence}`}>{stop.delivered ? <CheckCircle2 size={20} aria-hidden="true" /> : stop.order.stopSequence}</span>
            <div className="stop-progress-details">
              <strong>Stop {stop.order.stopSequence} · {stop.order.clinicName || "Destination"}</strong>
              <small>{stop.order.orderNumber || "Order without a number"}{stop.order.id === selectedId ? " · Details selected" : ""}</small>
              <div className="stop-progress-badges">
                <StopProgressBadge progress={stop} />
                {stop.navigating && <span className="stop-progress-nav"><Navigation size={13} aria-hidden="true" />Navigation target</span>}
              </div>
              {stop.unfinished && <small>Planned arrival {stop.order.stopEtaText || "—"} · Requested: {requestedArrivalLabel(requestedArrivalOf(stop.order))}</small>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
