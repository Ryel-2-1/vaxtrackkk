import { useEffect, useId, useRef, useState } from "react";
import useOwnProfile from "../profile/useOwnProfile";
import DialogLayer from "../ui/DialogLayer";
import ConfirmDialog from "../ui/ConfirmDialog";
import { cancelOrderWithInventoryRelease } from "../../services/inventoryCallables";
import { canCancelBeforeDeparture, createCancellationRequest, CANCELLATION_WARNING, REORDER_GUIDANCE } from "../../services/preDepartureCancellation";
import { MAX_REASON_LENGTH, validateReason } from "../../services/orderWorkflow";
import "./OrderCancellationAction.css";

export default function OrderCancellationAction({ order, scope = "" }) {
  const { uid, profile, error } = useOwnProfile();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState("");
  const [success, setSuccess] = useState("");
  const reasonId = useId();
  const successRef = useRef(null);
  useEffect(() => { if (success) successRef.current?.focus({ preventScroll: true }); }, [success]);
  const submit = useRef(createCancellationRequest(cancelOrderWithInventoryRelease));
  const allowed = !error && canCancelBeforeDeparture({ order, uid, profile });
  const reference = order.orderNumber || "Order number unavailable";

  return (
    <section className="order-cancellation-action" aria-label="Order cancellation">
      {allowed && <button type="button" className="m-btn m-btn-danger" onClick={() => {
        setReason(""); setReasonError(""); setOpen(true);
      }}>Cancel order</button>}
      {success && <p ref={successRef} tabIndex={-1} role="status">{success}</p>}
      {open && <DialogLayer scope={scope}>
        <ConfirmDialog
          className="order-cancellation-dialog"
          scrollFields
          title="Cancel this order?"
          target={reference}
          consequence={CANCELLATION_WARNING}
          confirmLabel="Cancel order"
          busyLabel="Cancelling…"
          cancelLabel="Keep order"
          failureMessage="Cancellation could not be confirmed. Check the order status before trying again."
          validate={() => {
            const checked = validateReason(reason, { label: "reason for cancelling" });
            setReasonError(checked.ok ? "" : checked.message);
            return checked.ok;
          }}
          onCancel={() => setOpen(false)}
          onConfirm={async () => {
            await submit.current(order.id, reason);
            setSuccess(`${reference} was cancelled. ${REORDER_GUIDANCE}`);
            setOpen(false);
          }}
        >
          <label htmlFor={reasonId}>Reason for cancellation</label>
          <textarea id={reasonId} value={reason} rows={3} maxLength={MAX_REASON_LENGTH}
            aria-invalid={!!reasonError} aria-describedby={reasonError ? `${reasonId}-error` : undefined}
            onChange={(event) => { setReason(event.target.value); setReasonError(""); }} />
          {reasonError && <p id={`${reasonId}-error`} className="m-field-error" role="alert">{reasonError}</p>}
          <p>{REORDER_GUIDANCE}</p>
          <p>This action creates no replacement orders and leaves any existing cart or checkout draft unchanged.</p>
        </ConfirmDialog>
      </DialogLayer>}
    </section>
  );
}
