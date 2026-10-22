// Admin Inventory — the batch-details dialog shell, and the frame for the
// page's other dialogs (Edit price; Correct stock, stacked over the batch).
//
// Rendered through DialogLayer (a portal into document.body), so it is fixed
// to and centred in the VIEWPORT whatever the Inventory page's height or
// scroll position — never inside the Admin <main>, whose lingering entrance
// transform made it the containing block (see DialogLayer.jsx).
//
// Viewport-bound: the dialog never grows past the screen (100dvh, with a
// 100vh fallback). The header (status, title, close) and the action footer
// stay put; only the body scrolls, so every reservation row is reachable with
// wheel, trackpad, touch or keyboard, and the body starts at the top on every
// open and whenever the batch changes. useDialogFocus supplies Escape (top
// dialog only), the focus trap, focus return and the page scroll lock — held
// until the LAST open dialog closes, then the page's scroll position and
// overflow styles are restored exactly.
import { useId, useLayoutEffect, useRef } from "react";
import { X } from "lucide-react";
import { useDialogFocus } from "../../components/ui/useDialogFocus";
import DialogLayer from "../../components/ui/DialogLayer";

/** The Inventory route's scoping classes, re-applied on the portal layer. */
export const INVENTORY_DIALOG_SCOPE = "inventory-page adl-root";

export default function InventoryBatchDialog({ badge, badgeTone, title, description, onClose, footer, resetKey, children }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const bodyRef = useRef(null);
  const titleId = useId();
  useDialogFocus({ dialogRef, initialRef: closeRef, onDismiss: onClose });

  // A newly opened or newly selected batch starts at the top of its details.
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [resetKey]);

  return (
    <DialogLayer scope={INVENTORY_DIALOG_SCOPE}>
      <div className="v2-inventory-modal-backdrop inv-batch-backdrop">
        <div
          ref={dialogRef}
          className="v2-inventory-modal inv-batch-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <header className="inv-batch-head">
            <button
              ref={closeRef}
              type="button"
              className="v2-inventory-modal-close"
              onClick={onClose}
              aria-label="Close batch details"
            >
              <X size={18} />
            </button>
            <div className={`v2-modal-badge ${badgeTone}`}>{badge}</div>
            <h2 id={titleId}>{title}</h2>
            <p>{description}</p>
          </header>

          {/* Focusable so keyboard users can scroll it with the arrow keys. */}
          <div ref={bodyRef} className="inv-batch-body" tabIndex={0} aria-label="Batch details">
            {children}
          </div>

          {footer && <footer className="inv-batch-foot">{footer}</footer>}
        </div>
      </div>
    </DialogLayer>
  );
}

/**
 * An Inventory form dialog (Edit price, Correct stock), portaled to the
 * viewport like the batch details. Opened over the batch dialog (Correct
 * stock), it is portaled after it, so it paints above it; it joins the same
 * dialog stack, so Escape closes only this one, focus returns to the control
 * that opened it, and the page stays locked until the last dialog closes. A
 * backdrop click closes it, as before; clicks inside the dialog do not.
 */
export function InventoryDialog({ labelledBy, onClose, busy = false, className = "", children }) {
  const dialogRef = useRef(null);
  useDialogFocus({ dialogRef, onDismiss: onClose, busy });
  return (
    <DialogLayer scope={INVENTORY_DIALOG_SCOPE}>
      <div className="v2-inventory-modal-backdrop" onClick={onClose}>
        <div
          ref={dialogRef}
          className={`v2-inventory-modal ${className}`.trim()}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      </div>
    </DialogLayer>
  );
}
