import { useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { useDialogFocus } from "../../components/ui/useDialogFocus";
import { friendlyErrorMessage } from "../../services/liveDataErrors";
import { orderNumberPhrase } from "../../services/orderLabel";
import { invoicePhotoView, proofPhotoView } from "../../services/deliveryEvidenceView";
import { pendingOfflineReview } from "../../services/offlineCompletionView";
import { storageBucket } from "../../firebase";

const MAX_NOTE = 500;

/**
 * A delivery the rider recorded without signal that the server could not
 * verify (functions/src/offlineCompletion.js). The Dispatcher sees why, where
 * and when it was recorded, and both photos, then approves it (the order is
 * completed and its stock consumed, attributed to the Dispatcher) or rejects
 * it with a reason (the order stays in transit for the rider).
 */
export default function OfflineReviewDialog({ order, onDismiss, onDecide }) {
  const review = pendingOfflineReview(order);
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  useDialogFocus({ dialogRef, initialRef: closeRef, onDismiss });

  const proof = proofPhotoView(order, storageBucket);
  const invoice = invoicePhotoView(order, storageBucket);
  const mapUrl = review?.latitude != null
    ? `https://www.openstreetmap.org/?mlat=${review.latitude}&mlon=${review.longitude}#map=18/${review.latitude}/${review.longitude}`
    : null;

  const decide = async (decision) => {
    if (busy) return;
    if (decision === "reject" && note.trim() === "") {
      setError("Add a reason for rejecting it. The rider will see it.");
      return;
    }
    setBusy(decision);
    setError("");
    try {
      await onDecide(order, decision, note.trim());
    } catch (failure) {
      setError(friendlyErrorMessage(failure, "The review could not be saved. Nothing was changed — please try again."));
      setBusy("");
    }
  };

  return (
    <div className="shp-dialog-backdrop" onMouseDown={onDismiss}>
      <div className="shp-dialog shp-offline-review" role="dialog" aria-modal="true"
        aria-labelledby="offline-review-title" aria-describedby="offline-review-desc" ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="shp-dialog-head">
          <h2 id="offline-review-title">Review offline delivery</h2>
          <button type="button" className="shp-dialog-close" aria-label="Close without deciding" onClick={onDismiss} ref={closeRef}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <p id="offline-review-desc" className="shp-dialog-desc">
          {orderNumberPhrase(order)} · {order.clinicName || "Clinic"} · {order.assignedRiderName || "Rider"}
        </p>

        {!review ? (
          <p className="shp-proof-empty" role="status">This delivery has no offline record waiting for review.</p>
        ) : (
          <>
            <p className="shp-offline-reason"><strong>Why it needs review:</strong> {review.reasonText}</p>
            <dl className="shp-offline-facts">
              {review.recordedAt && (<><dt>Recorded on the phone</dt><dd>{review.recordedAt}</dd></>)}
              {review.receivedAt && (<><dt>Received by VaxTrack</dt><dd>{review.receivedAt}</dd></>)}
              {review.distanceMeters != null && (
                <><dt>Recorded position</dt><dd>{review.distanceMeters} m from the clinic (area {review.radiusMeters} m)</dd></>
              )}
              {review.accuracyMeters != null && (<><dt>GPS accuracy</dt><dd>±{review.accuracyMeters} m</dd></>)}
            </dl>
            {mapUrl && (
              <a className="shp-proof-open" href={mapUrl} target="_blank" rel="noopener noreferrer">Open the recorded position on a map</a>
            )}
            <div className="shp-offline-photos">
              {[["Proof photo", proof], ["Invoice photo", invoice]].map(([label, view]) => (
                view.url ? (
                  <a key={label} href={view.url} target="_blank" rel="noopener noreferrer" className="shp-offline-photo">
                    <img src={view.url} alt={`${label} for ${orderNumberPhrase(order)}`} />
                    <span>{label}</span>
                  </a>
                ) : (
                  <p key={label} className="shp-muted">{label}: not available</p>
                )
              ))}
            </div>

            {rejecting && (
              <>
                <label htmlFor="offline-review-note">Reason for rejecting (shown to the rider)</label>
                <textarea id="offline-review-note" rows={3} value={note} maxLength={MAX_NOTE}
                  onChange={(e) => { setNote(e.target.value); if (error) setError(""); }}
                  placeholder="e.g. Photo does not show the clinic" />
              </>
            )}
            <div aria-live="assertive">
              {error && <p role="alert" className="shp-dialog-error">{error}</p>}
            </div>
            <div className="shp-dialog-actions">
              {rejecting ? (
                <>
                  <button type="button" className="shp-act-btn" onClick={() => { setRejecting(false); setError(""); }} disabled={!!busy}>Back</button>
                  <button type="button" className="shp-act-btn danger" onClick={() => decide("reject")} disabled={!!busy}>
                    {busy === "reject" && <Loader2 size={12} className="spin" aria-hidden="true" />}
                    {busy === "reject" ? "Rejecting..." : "Reject"}
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="shp-act-btn" onClick={() => setRejecting(true)} disabled={!!busy}>Reject…</button>
                  <button type="button" className="shp-act-btn primary" onClick={() => decide("approve")} disabled={!!busy}>
                    {busy === "approve" && <Loader2 size={12} className="spin" aria-hidden="true" />}
                    {busy === "approve" ? "Approving..." : "Approve and complete"}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
