import { useEffect, useId, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { useDialogFocus } from "./useDialogFocus";
import { friendlyErrorMessage } from "../../services/liveDataErrors";
import { createSingleFlight } from "../../services/singleFlight";
import "./feedback.css";

/**
 * A confirmation for an action that is destructive or hard to reverse.
 *
 * It names the target and states the consequence. Cancel has initial focus,
 * so Enter on open never confirms by accident. `onConfirm` may be async:
 * while it runs the buttons are disabled and repeated presses are ignored; if
 * it throws, the dialog STAYS OPEN with the error shown inside it (a toast is
 * never the only record of a blocking failure). The caller closes the dialog
 * on success.
 *
 * Extra fields (a reason, notes) go in `children`. Return `false` from
 * `validate()` to keep the dialog open without calling `onConfirm`.
 */
export default function ConfirmDialog({
  title,
  target,
  consequence,
  confirmLabel,
  busyLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  failureMessage = "This action could not be completed. Nothing was changed — please try again.",
  onConfirm,
  onCancel,
  validate,
  children,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const flight = useRef(createSingleFlight());
  const mounted = useRef(true);
  const titleId = useId();
  const descId = useId();
  const errorId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useDialogFocus({ dialogRef, initialRef: cancelRef, onDismiss: onCancel, busy });

  const confirm = (event) => {
    event?.preventDefault();
    if (flight.current.busy) return;
    if (validate && validate() === false) return;
    setError("");
    setBusy(true);
    flight.current
      .run(() => onConfirm())
      .catch((failure) => {
        if (mounted.current) setError(friendlyErrorMessage(failure, failureMessage));
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  return (
    <div className="m-dialog-backdrop" onMouseDown={() => !busy && onCancel()}>
      <div
        ref={dialogRef}
        className="m-dialog"
        role={tone === "danger" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        aria-busy={busy ? "true" : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="m-dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="m-dialog-close"
            onClick={onCancel}
            disabled={busy}
            aria-label={`Close without changes: ${title}`}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div id={descId} className="m-dialog-body">
          {target && (
            <p className="m-dialog-target">
              <strong>{target}</strong>
            </p>
          )}
          {consequence && <p className="m-dialog-consequence">{consequence}</p>}
        </div>

        <form onSubmit={confirm} noValidate>
          {children}
          {error && (
            <p id={errorId} className="m-dialog-error" role="alert">
              {error}
            </p>
          )}
          <div className="m-dialog-actions">
            <button ref={cancelRef} type="button" className="m-btn m-btn-secondary" onClick={onCancel} disabled={busy}>
              {cancelLabel}
            </button>
            <button
              type="submit"
              className={`m-btn ${tone === "danger" ? "m-btn-danger" : "m-btn-primary"}`}
              disabled={busy}
              aria-describedby={error ? errorId : undefined}
            >
              {busy && <Loader2 size={14} className="m-spin" aria-hidden="true" />}
              {busy ? busyLabel || "Working…" : confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
