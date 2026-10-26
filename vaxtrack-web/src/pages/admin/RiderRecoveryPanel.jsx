import { useCallback, useEffect, useId, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import app from "../../firebase";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import AdminDialogLayer from "../../components/admin/AdminDialogLayer";
import { recheckRiderTripStatesOnServer } from "../../services/riderDispatchService";
import { describeRecheck } from "../../services/riderTrip";
import { applyRiderRecovery, previewRiderRecovery } from "../../services/riderRecoveryService";
import {
  MAX_RECOVERY_REASON,
  custodyLabel,
  qaResetVisible,
  splitOrders,
  tripStateLabel,
  validRecoveryReason,
} from "../../services/riderRecovery";
import { friendlyErrorMessage, logSafeError } from "../../services/liveDataErrors";
import "./RiderRecoveryPanel.css";

/**
 * Admin → Riders → Rider details → "Rider recovery".
 *
 * Everything shown comes from the server's read-only preview
 * (previewRiderRecovery); every action is a server callable that re-checks the
 * same documents in one transaction. Nothing here writes a trip, a Rider state
 * or an order. "Reset QA trip" appears only when the server reports it enabled
 * for this project (staging/demo with its server switch on) — never in
 * production.
 */
export default function RiderRecoveryPanel({ riderUid, riderName }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [rechecking, setRechecking] = useState(false);
  const [notice, setNotice] = useState(null);
  const [dialog, setDialog] = useState(null); // "confirm_return" | "qa_reset" | null
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState("");
  const titleId = useId();
  const reasonId = useId();
  const reasonHintId = useId();

  // Each reload bumps the request; only the latest response is applied, so a
  // slow earlier preview can never overwrite a newer one.
  const [request, setRequest] = useState(0);
  const load = useCallback(() => {
    setLoading(true);
    setLoadError("");
    setRequest((n) => n + 1);
  }, []);

  useEffect(() => {
    let current = true;
    previewRiderRecovery(riderUid).then(
      (data) => {
        if (!current) return;
        setPreview(data);
        setLoading(false);
      },
      (error) => {
        if (!current) return;
        logSafeError("Preview rider recovery", error);
        setPreview(null);
        setLoadError(friendlyErrorMessage(error, "This rider's trip status could not be loaded. Please try again."));
        setLoading(false);
      }
    );
    return () => {
      current = false;
    };
  }, [riderUid, request]);

  const recheck = async () => {
    setRechecking(true);
    setNotice(null);
    try {
      const results = await recheckRiderTripStatesOnServer([riderUid]);
      const { text, tone } = describeRecheck(results);
      setNotice({ tone, text });
      await load();
    } catch (error) {
      logSafeError("Re-check rider trip", error);
      setNotice({ tone: "error", text: friendlyErrorMessage(error, "The trip status could not be re-checked. Nothing was changed.") });
    } finally {
      setRechecking(false);
    }
  };

  const openDialog = (action) => {
    setReason("");
    setReasonError("");
    setNotice(null);
    setDialog(action);
  };

  const confirmAction = async () => {
    try {
      const result = await applyRiderRecovery({ riderUid, action: dialog, version: preview.version, reason: reason.trim() });
      setDialog(null);
      const orders = result.affectedOrderNumbers?.length ? ` Orders: ${result.affectedOrderNumbers.join(", ")}.` : "";
      setNotice({
        tone: "success",
        text:
          dialog === "confirm_return"
            ? `${riderName}'s return to the hub is confirmed.${result.replayed ? " (Already recorded.)" : ""}`
            : result.changed === false
              ? `${riderName} was already at the hub. Nothing was changed.`
              : `${riderName} is back at the hub and their trip was dissolved.${orders} The orders are waiting for dispatch again.`,
      });
      await load();
    } catch (error) {
      // The preview is out of date: refresh it behind the dialog, and say so.
      if (error?.code === "recovery-stale" || error?.code === "recovery-blocked") load();
      throw error;
    }
  };

  const validate = () => {
    if (validRecoveryReason(reason)) return true;
    setReasonError(`Please give a short reason (5–${MAX_RECOVERY_REASON} characters).`);
    return false;
  };

  const projectId = app?.options?.projectId;
  const showQaReset = qaResetVisible(preview, projectId);
  const { active, finished } = splitOrders(preview);
  const confirmReturn = preview?.actions?.confirmReturn;
  const qaReset = preview?.actions?.qaReset;
  const tripId = preview?.derived?.tripId || preview?.stored?.tripId || null;

  return (
    <section className="rrp" aria-labelledby={titleId}>
      <div className="rrp-head">
        <h3 id={titleId}>Rider recovery</h3>
        <button type="button" className="riders-light-action rrp-recheck" onClick={recheck} disabled={rechecking || loading}>
          {rechecking ? <Loader2 size={14} className="m-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
          {rechecking ? "Re-checking…" : "Re-check trip status"}
        </button>
      </div>

      {notice && (
        <p className={`rrp-notice rrp-notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
          {notice.text}
        </p>
      )}

      {loading && !preview && <p className="rrp-muted">Loading trip status…</p>}
      {loadError && (
        <p className="rrp-notice rrp-notice-error" role="alert">
          {loadError}{" "}
          <button type="button" className="rrp-link" onClick={load}>Try again</button>
        </p>
      )}

      {preview && (
        <>
          <dl className="rrp-facts">
            <div>
              <dt>Trip status</dt>
              <dd>{tripStateLabel(preview)}</dd>
            </div>
            <div>
              <dt>Trip ID</dt>
              <dd className="rrp-mono">{tripId || "No current trip"}</dd>
            </div>
          </dl>

          {preview.derived?.differsFromStored && (
            <p className="rrp-note">
              The saved trip status doesn't match this rider's orders. Re-check trip status to correct it from the orders.
            </p>
          )}
          {preview.navigation?.active && (
            <p className="rrp-note">The rider app is navigating a delivery right now.</p>
          )}

          <OrderList title="Active trip orders" orders={active} empty="No active orders." />
          {finished.length > 0 && <OrderList title="Finished orders on this trip" orders={finished} />}

          <div className="rrp-actions">
            <div className="rrp-action">
              <button
                type="button"
                className="riders-primary-action"
                onClick={() => openDialog("confirm_return")}
                disabled={!confirmReturn?.available}
                aria-describedby={`${titleId}-return`}
              >
                Confirm returned to hub
              </button>
              <p id={`${titleId}-return`} className="rrp-muted">{confirmReturn?.message}</p>
            </div>

            {showQaReset && (
              <div className="rrp-action rrp-qa">
                <button
                  type="button"
                  className="riders-danger-action"
                  onClick={() => openDialog("qa_reset")}
                  disabled={!qaReset?.available}
                  aria-describedby={`${titleId}-qa`}
                >
                  Reset QA trip
                </button>
                <div id={`${titleId}-qa`} className="rrp-muted">
                  {qaReset?.available && (
                    <p>Staging only. Puts {qaReset.requeueOrderNumbers.join(", ")} back in the dispatch queue and frees the rider.</p>
                  )}
                  {qaReset?.noop && <p>Nothing to reset — the rider is at the hub with no orders.</p>}
                  {!qaReset?.available && !qaReset?.noop && qaReset?.blockers?.length > 0 && (
                    <>
                      <p>This rider can't be reset:</p>
                      <ul className="rrp-blockers">
                        {qaReset.blockers.map((b, i) => (
                          <li key={`${b.code}-${i}`}>{b.message}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {dialog && preview && (
        <AdminDialogLayer>
          <ConfirmDialog
            title={dialog === "confirm_return" ? "Confirm return to hub" : "Reset QA trip"}
            target={riderName}
            consequence={
              dialog === "confirm_return"
                ? "The rider becomes available for new orders. Only confirm once they are physically back at the hub with any returned vials."
                : `${qaReset.requeueOrderNumbers.join(", ")} go back to the dispatch queue with their stock still reserved, the unused trip is dissolved, and the rider becomes available. Staging only — this is recorded with your name and reason.`
            }
            confirmLabel={dialog === "confirm_return" ? "Confirm return" : "Reset QA trip"}
            busyLabel={dialog === "confirm_return" ? "Confirming…" : "Resetting…"}
            tone={dialog === "confirm_return" ? "primary" : "danger"}
            failureMessage="Nothing was changed. Please try again."
            onConfirm={confirmAction}
            onCancel={() => setDialog(null)}
            validate={validate}
          >
            <div className="rrp-reason">
              <label htmlFor={reasonId}>Reason</label>
              <textarea
                id={reasonId}
                rows={3}
                maxLength={MAX_RECOVERY_REASON}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  if (reasonError) setReasonError("");
                }}
                aria-invalid={reasonError ? "true" : undefined}
                aria-describedby={reasonHintId}
                required
              />
              <p id={reasonHintId} className={reasonError ? "m-field-error" : "rrp-muted"}>
                {reasonError || "Recorded in the recovery audit with your name."}
              </p>
            </div>
          </ConfirmDialog>
        </AdminDialogLayer>
      )}
    </section>
  );
}

function OrderList({ title, orders, empty }) {
  return (
    <div className="rrp-orders">
      <h4>{title}</h4>
      {orders.length === 0 ? (
        <p className="rrp-muted">{empty}</p>
      ) : (
        <ul>
          {orders.map((o) => (
            <li key={o.orderId}>
              <span className="rrp-order-number">{o.orderNumber}</span>
              <span>{o.statusLabel}</span>
              <span className="rrp-muted">{custodyLabel(o.custody)}</span>
              {o.blocker && <span className="rrp-order-blocker">{o.blocker.message}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
