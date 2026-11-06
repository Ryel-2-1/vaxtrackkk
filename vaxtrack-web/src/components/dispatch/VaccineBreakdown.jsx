import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./VaccineBreakdown.css";

/** Order lines are the accepted order snapshot; quoted batch/category is not a storage instruction. */
export default function VaccineBreakdown({ order }) {
  const lines = Array.isArray(order?.items) ? order.items.filter((line) => line && typeof line === "object") : [];
  const firstName = lines[0]?.name || order?.vaccineName || "Vaccine not recorded";
  const extra = Math.max(0, lines.length - 1);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const closeTimer = useRef(null);
  const panelId = useId();

  const show = () => {
    if (!triggerRef.current) return;
    window.clearTimeout(closeTimer.current);
    const rect = triggerRef.current.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const below = window.innerHeight - rect.bottom >= 210 || rect.top < 210;
    setPosition({ left, top: below ? rect.bottom + 6 : undefined, bottom: below ? undefined : window.innerHeight - rect.top + 6, width });
    setOpen(true);
  };
  const scheduleClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 150);
  };

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!triggerRef.current?.contains(event.target) && !panelRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => { if (event.key === "Escape") setOpen(false); };
    const onScroll = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  if (!extra) return <span className="vaccine-summary-name">{firstName}</span>;
  return (
    <span className="vaccine-summary">
      <span className="vaccine-summary-name">{firstName}</span>{" "}
      <button type="button" className="vaccine-more" ref={triggerRef}
        aria-label={`Show all ${lines.length} vaccines for ${order?.orderNumber || "this order"}`}
        aria-expanded={open} aria-describedby={open ? panelId : undefined}
        onMouseEnter={show} onMouseLeave={scheduleClose}
        onFocus={show} onBlur={(event) => { if (!panelRef.current?.contains(event.relatedTarget)) scheduleClose(); }}
        onClick={show}>
        +{extra} more
      </button>
      {open && position && createPortal(
        <div id={panelId} className="vaccine-breakdown-popover" role="tooltip" ref={panelRef}
          style={position} onMouseEnter={() => window.clearTimeout(closeTimer.current)} onMouseLeave={scheduleClose}>
          <strong>{lines.length} vaccines in this order</strong>
          <ul>{lines.map((line, index) => (
            <li key={`${line.productKey || line.name || "vaccine"}-${index}`}>
              <span>{line.name || "Vaccine not recorded"}</span>
              <b>{Number.isFinite(Number(line.quantity)) ? Number(line.quantity).toLocaleString() : "—"} vials</b>
              <small>Dosage: {typeof line.dosage === "string" && line.dosage.trim() ? line.dosage.trim() : "Not recorded"}</small>
              <small>Storage: {typeof line.storageRequirements === "string" && line.storageRequirements.trim() ? line.storageRequirements.trim() : "Not recorded"}</small>
            </li>
          ))}</ul>
        </div>, document.body
      )}
    </span>
  );
}
