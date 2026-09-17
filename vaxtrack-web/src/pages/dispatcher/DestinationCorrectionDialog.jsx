import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { subscribeDoctorAddresses } from "../../services/doctorAddressService";
import { subscribeClinics } from "../../services/clinicService";
import { buildDoctorDestinationOptions } from "../../services/doctorAddressModel";
import {
  MAX_DESTINATION_REASON_LENGTH,
  subscribeDestinationCorrections,
} from "../../services/destinationCorrectionService";

export default function DestinationCorrectionDialog({ order, onDismiss, onConfirm }) {
  const [addresses, setAddresses] = useState([]);
  const [clinics, setClinics] = useState([]);
  const [history, setHistory] = useState([]);
  const [loadingAddresses, setLoadingAddresses] = useState(true);
  const [loadingClinics, setLoadingClinics] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [selected, setSelected] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const dialogRef = useRef(null);
  const selectRef = useRef(null);
  const closeButtonRef = useRef(null);

  useEffect(() => {
    if (!order.doctorId) {
      setLoadingAddresses(false);
      setLoadError("This order has no doctor destination. Ask Admin to review it.");
      return;
    }
    const fail = () => setLoadError("Could not load this doctor's linked addresses. Try again.");
    const stopAddresses = subscribeDoctorAddresses(order.doctorId, (items) => {
      setAddresses(items);
      setLoadingAddresses(false);
    }, fail);
    const stopClinics = subscribeClinics((items) => {
      setClinics(items);
      setLoadingClinics(false);
    }, fail);
    return () => { stopAddresses(); stopClinics(); };
  }, [order.doctorId]);

  useEffect(() => subscribeDestinationCorrections(
    order.id,
    setHistory,
    () => setHistoryError("Could not load correction history.")
  ), [order.id]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (!submittingRef.current) onDismiss();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll(
        'button:not([disabled]), select:not([disabled]), textarea:not([disabled])'
      );
      if (!focusable?.length) return;
      if (event.shiftKey && document.activeElement === focusable[0]) {
        event.preventDefault();
        focusable[focusable.length - 1].focus();
      } else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) {
        event.preventDefault();
        focusable[0].focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = oldOverflow;
    };
  }, [onDismiss]);

  useEffect(() => {
    if (!loadingAddresses && !loadingClinics && !loadError) selectRef.current?.focus();
  }, [loadingAddresses, loadingClinics, loadError]);

  const options = useMemo(
    () => buildDoctorDestinationOptions(addresses, clinics)
      .filter((item) => item.id !== order.doctorAddressId),
    [addresses, clinics, order.doctorAddressId]
  );

  const submit = async (event) => {
    event.preventDefault();
    if (submittingRef.current) return;
    if (!selected || !options.some((item) => item.id === selected)) {
      setError("Select another active, verified address linked to this doctor.");
      return;
    }
    const cleanReason = reason.trim();
    if (!cleanReason || cleanReason.length > MAX_DESTINATION_REASON_LENGTH) {
      setError(`Give a reason of up to ${MAX_DESTINATION_REASON_LENGTH} characters.`);
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    try {
      await onConfirm(order, selected, cleanReason);
    } catch (failure) {
      setError(failure.message || "Could not correct the destination.");
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="shp-dialog-backdrop" onMouseDown={() => !submittingRef.current && onDismiss()}>
      <div className="shp-dialog" role="dialog" aria-modal="true"
        aria-labelledby="correct-destination-title" aria-describedby="correct-destination-desc"
        ref={dialogRef} onMouseDown={(event) => event.stopPropagation()}>
        <div className="shp-dialog-head">
          <h2 id="correct-destination-title">Request destination change</h2>
          <button type="button" className="shp-dialog-close" ref={closeButtonRef} aria-label="Close destination correction"
            disabled={submitting} onClick={onDismiss}><X size={16} aria-hidden="true" /></button>
        </div>
        <p id="correct-destination-desc" className="shp-dialog-desc">
          Order {order.orderNumber || order.id} · {order.clinicName || order.destinationName}
          {order.clinicAddress ? ` — ${order.clinicAddress}` : ""}. Only this doctor's linked addresses are available.
          The current destination and route stay in place until the Med Rep who placed this order approves.
        </p>
        <form onSubmit={submit}>
          <label htmlFor="correct-destination-address">Proposed address</label>
          <select id="correct-destination-address" ref={selectRef} value={selected}
            disabled={submitting || loadingAddresses || loadingClinics || !!loadError}
            onChange={(event) => { setSelected(event.target.value); setError(""); }}>
            <option value="">{loadingAddresses || loadingClinics ? "Loading addresses..." : "Select another address..."}</option>
            {options.map((item) => <option key={item.id} value={item.id}>
              {item.name} — {item.address}
            </option>)}
          </select>
          {!loadingAddresses && !loadingClinics && !loadError && options.length === 0 &&
            <p className="shp-muted">No other verified address is linked to this doctor.</p>}
          <label htmlFor="correct-destination-reason">Reason for request</label>
          <textarea id="correct-destination-reason" value={reason} rows={3}
            maxLength={MAX_DESTINATION_REASON_LENGTH} disabled={submitting}
            placeholder="Explain why the delivery address must change"
            onChange={(event) => { setReason(event.target.value); setError(""); }} />
          {(loadError || error) && <p role="alert" className="shp-dialog-error">{loadError || error}</p>}
          <div className="shp-dialog-actions">
            <button type="button" className="shp-act-btn" disabled={submitting} onClick={onDismiss}>Keep destination</button>
            <button type="submit" className="shp-act-btn primary"
              disabled={submitting || !!loadError || loadingAddresses || loadingClinics || options.length === 0}>
              {submitting && <Loader2 size={12} className="spin" aria-hidden="true" />}
              {submitting ? "Sending..." : "Send to Med Rep"}
            </button>
          </div>
        </form>
        {historyError && <p role="alert" className="shp-dialog-error">{historyError}</p>}
        {history.length > 0 && <section className="shp-destination-history" aria-label="Previous corrections">
          <h3>Correction history</h3>
          <ul>{history.map((entry) => <li key={entry.id}>
            <strong>{entry.previous?.clinicName || entry.previous?.destinationName || "Unknown"}</strong>
            {" → "}<strong>{entry.current?.clinicName || entry.current?.destinationName || "Unknown"}</strong>
            <small>{entry.reason} · {entry.correctedAt?.toDate?.().toLocaleString() || "Pending timestamp"}</small>
          </li>)}</ul>
        </section>}
      </div>
    </div>
  );
}
