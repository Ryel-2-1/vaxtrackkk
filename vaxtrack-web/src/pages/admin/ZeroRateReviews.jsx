import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, RefreshCw } from "lucide-react";
import { reviewZeroRateApproval, subscribePendingZeroRateRequests } from "../../services/zeroRateRequests";
import { friendlyErrorMessage, liveErrorMessage, logSafeError } from "../../services/liveDataErrors";

export default function ZeroRateReviews() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState("");
  const [decisionMessage, setDecisionMessage] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => subscribePendingZeroRateRequests(
    (rows) => { setRequests(rows); setLoading(false); setLoadError(null); },
    (error) => { logSafeError("ZeroRateReviews load", error); setLoading(false); setLoadError(error); }
  ), [retryKey]);

  const decide = async (requestId, decision) => {
    setBusyId(requestId);
    setActionError("");
    setDecisionMessage("");
    try {
      await reviewZeroRateApproval({ requestId, decision });
      setRequests((current) => current.filter((row) => row.id !== requestId));
      setDecisionMessage(decision === "approved" ? "Request accepted. The Med Rep can use this approval for the matching order." : "Request denied. The Med Rep can submit a new request if needed.");
    } catch (error) {
      logSafeError("ZeroRateReviews decision", error);
      setActionError(error?.code === "functions/not-found"
        ? "Zero-rating review is not available in this environment yet. Ask an administrator to enable it."
        : friendlyErrorMessage(error, "The decision could not be saved. Please try again."));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section id="zero-rating-requests" className="alerts-list-card zero-rate-reviews" aria-label="Zero-rating requests" aria-busy={loading}>
      <div className="zero-rate-reviews-head">
        <div>
          <span className="zero-rate-reviews-eyebrow">ADMIN REVIEW</span>
          <h2>Zero-rating requests</h2>
          <p>Check the Med Rep’s reason and order details before deciding.</p>
        </div>
        <span className={`zero-rate-reviews-count${loadError ? " is-error" : ""}`}>
          {loadError ? "Unavailable" : loading ? "Loading" : `${requests.length} pending`}
        </span>
      </div>

      {decisionMessage && <p className="zero-rate-reviews-feedback is-success" role="status"><CheckCircle2 size={18} aria-hidden="true" />{decisionMessage}</p>}
      {actionError && <p className="zero-rate-reviews-feedback is-error" role="alert"><AlertCircle size={18} aria-hidden="true" />{actionError}</p>}
      {loadError && <div className="zero-rate-reviews-load-error" role="alert">
        <AlertCircle size={19} aria-hidden="true" />
        <div><strong>Review queue unavailable</strong><p>{liveErrorMessage(loadError, "pending zero-rating requests")} No pending count can be shown until this loads.</p></div>
        <button type="button" onClick={() => { setLoading(true); setLoadError(null); setRetryKey((current) => current + 1); }}>
          <RefreshCw size={15} aria-hidden="true" /> Retry
        </button>
      </div>}
      {loading && !loadError && <p className="zero-rate-reviews-empty" role="status">Loading requests…</p>}
      {!loading && !loadError && requests.length === 0 && <p className="zero-rate-reviews-empty">No requests waiting for review.</p>}

      {!loading && !loadError && requests.map((request) => (
        <article className="zero-rate-review-item" key={request.id}>
          <div className="zero-rate-review-item-head">
            <div><strong>{request.doctorName || "Doctor"} · {request.destinationName || "Destination"}</strong><span>{request.deliveryAddress || "Address not recorded"}</span></div>
            <span className="zero-rate-review-item-date">{request.requestedDeliveryDate}</span>
          </div>
          <div className="zero-rate-review-meta"><span>Requested by <strong>{request.requesterName || "Med Rep"}</strong></span><span>{request.items?.length ?? 0} vaccine {request.items?.length === 1 ? "batch" : "batches"}</span></div>
          <div className="zero-rate-review-reason"><span>Med Rep’s reason</span><p>{request.reason || "No reason recorded"}</p></div>
          <div className="zero-rate-review-items"><strong>Requested vaccines</strong><ul>{(request.items || []).map((item) => (
            <li key={item.inventoryId}><span>{item.vaccineName || "Vaccine"} · Batch {item.batchId || item.inventoryId}</span><strong>{item.quantity} {item.quantity === 1 ? "vial" : "vials"}</strong></li>
          ))}</ul></div>
          <div className="zero-rate-review-actions">
            <button type="button" className="zero-rate-accept" disabled={busyId !== null} onClick={() => decide(request.id, "approved")}>{busyId === request.id ? "Saving…" : "Accept request"}</button>
            <button type="button" className="zero-rate-deny" disabled={busyId !== null} onClick={() => decide(request.id, "rejected")}>Deny</button>
          </div>
        </article>
      ))}
    </section>
  );
}
