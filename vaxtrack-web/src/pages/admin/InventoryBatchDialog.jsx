// Admin Inventory — the batch-details dialog shell.
//
// Viewport-bound: the dialog never grows past the screen (100dvh, with a
// 100vh fallback). The header (status, title, close) and the action footer
// stay put; only the body scrolls, so every reservation row is reachable with
// wheel, trackpad, touch or keyboard. useDialogFocus supplies Escape, the
// focus trap, focus return and the background scroll lock (restored on close
// and on unmount).
import { useId, useRef } from "react";
import { X } from "lucide-react";
import { useDialogFocus } from "../../components/ui/useDialogFocus";

export default function InventoryBatchDialog({ badge, badgeTone, title, description, onClose, footer, children }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const titleId = useId();
  useDialogFocus({ dialogRef, initialRef: closeRef, onDismiss: onClose });

  return (
    <div className="v2-inventory-modal-backdrop">
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
        <div className="inv-batch-body" tabIndex={0} aria-label="Batch details">
          {children}
        </div>

        {footer && <footer className="inv-batch-foot">{footer}</footer>}
      </div>
    </div>
  );
}
