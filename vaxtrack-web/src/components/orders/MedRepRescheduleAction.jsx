import { useId, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import ConfirmDialog from "../ui/ConfirmDialog";
import DialogLayer from "../ui/DialogLayer";
import { rescheduleOrderDelivery } from "../../services/scheduleCallables";
import { manilaToday } from "../../services/requestedDate";
import { medRepMayReschedule } from "../../services/medRepReschedule";

/**
 * "Change delivery date" for the Med Rep's own order (2026-11-13), e.g. when
 * the doctor asks for it a day earlier. Shown only until the rider leaves;
 * the server enforces the same limits (own order, those statuses, a reason,
 * not a past date, reserved stock still usable), so this only spares the Med
 * Rep a refusal. Keeps the order's scheduled time as it is.
 */
export default function MedRepRescheduleAction({ order, onDone }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [fieldError, setFieldError] = useState(null);
  const dateRef = useRef(null);
  const reasonRef = useRef(null);
  const id = useId();
  const today = manilaToday();
  const current = typeof order?.requestedDeliveryDate === "string" ? order.requestedDeliveryDate : "";

  if (!order || !medRepMayReschedule(order.statusKey)) return null;

  const start = () => {
    setDate(current && current >= today ? current : today);
    setReason("");
    setFieldError(null);
    setOpen(true);
  };

  const validate = () => {
    if (!date || date < today) {
      setFieldError({ field: "date", text: "Choose today or a later date." });
      dateRef.current?.focus();
      return false;
    }
    if (date === current) {
      setFieldError({ field: "date", text: "That is already this order's delivery date." });
      dateRef.current?.focus();
      return false;
    }
    if (!reason.trim()) {
      setFieldError({ field: "reason", text: "Give a reason, e.g. the doctor asked for it earlier." });
      reasonRef.current?.focus();
      return false;
    }
    return true;
  };

  const confirm = async () => {
    await rescheduleOrderDelivery({
      orderId: order.id,
      requestedDeliveryDate: date,
      // Keep any time already set; only the day moves.
      scheduledDeliveryTime: typeof order.scheduledDeliveryTime === "string" ? order.scheduledDeliveryTime : undefined,
      reason,
    });
    setOpen(false);
    onDone?.(date);
  };

  return (
    <>
      <button type="button" className="tracking-reschedule-btn" onClick={start}>
        <CalendarDays size={14} aria-hidden="true" /> Change delivery date
      </button>
      {/* Portaled: inside the Med Rep's animated content area the modal opened
          below the visible screen (DialogLayer.jsx). */}
      {open && (
        <DialogLayer scope="salesrep-page salesrep-main">
        <ConfirmDialog
          title="Change the delivery date?"
          target={`Order ${order.orderNumber}${current ? ` · now ${current}` : ""}`}
          consequence="The Dispatcher sees the new date right away. The change and your reason are kept in the order's history."
          confirmLabel="Change date"
          busyLabel="Saving…"
          tone="primary"
          failureMessage="The delivery date could not be changed. Nothing was changed — please try again."
          onCancel={() => setOpen(false)}
          onConfirm={confirm}
          validate={validate}
        >
          <label htmlFor={`${id}-date`}>New delivery date</label>
          <input
            id={`${id}-date`}
            ref={dateRef}
            type="date"
            min={today}
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setFieldError(null);
            }}
            aria-invalid={fieldError?.field === "date" ? "true" : undefined}
            aria-describedby={fieldError ? `${id}-error` : undefined}
          />
          <label htmlFor={`${id}-reason`}>Reason</label>
          <textarea
            id={`${id}-reason`}
            ref={reasonRef}
            rows={2}
            maxLength={500}
            placeholder="e.g. Doctor asked for delivery today instead"
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setFieldError(null);
            }}
            aria-invalid={fieldError?.field === "reason" ? "true" : undefined}
            aria-describedby={fieldError ? `${id}-error` : undefined}
          />
          {fieldError && <p id={`${id}-error`} className="m-field-error" role="alert">{fieldError.text}</p>}
        </ConfirmDialog>
        </DialogLayer>
      )}
    </>
  );
}
