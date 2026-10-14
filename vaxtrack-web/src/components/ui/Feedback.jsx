import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { TONE_LABELS, liveRoleFor, normalizeTone } from "./feedbackModel";
import "./feedback.css";

const ICONS = { success: CheckCircle2, warning: AlertTriangle, error: XCircle, info: Info };

/**
 * An inline message or banner. Errors are announced immediately
 * (role="alert"); success, warning and information politely (role="status").
 * The tone is carried by a text label and an icon as well as colour.
 */
export function Notice({ tone = "info", title, children, onDismiss, id, className = "", live = true }) {
  const t = normalizeTone(tone);
  const Icon = ICONS[t];
  return (
    <div id={id} className={`m-notice m-notice-${t} ${className}`.trim()} role={live ? liveRoleFor(t) : undefined}>
      <Icon size={18} className="m-notice-icon" aria-hidden="true" />
      <div className="m-notice-text">
        <span className="m-visually-hidden">{TONE_LABELS[t]}: </span>
        {title && <strong className="m-notice-title">{title}</strong>}
        {children && <div className="m-notice-body">{children}</div>}
      </div>
      {onDismiss && (
        <button type="button" className="m-notice-dismiss" onClick={onDismiss} aria-label="Dismiss message">
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * The page's toast slot (pair with useToast). The live region is always
 * mounted, so a message that appears inside it is announced. Errors stay until
 * dismissed — and a blocking failure is also shown inline where it happened.
 */
export function ToastRegion({ toast, onDismiss }) {
  return (
    <div className="m-toast-region" aria-live="polite" aria-atomic="true">
      {toast && (
        <div key={toast.key} className={`m-toast m-toast-${toast.tone}`}>
          <Notice tone={toast.tone} onDismiss={onDismiss}>
            {toast.text}
          </Notice>
        </div>
      )}
    </div>
  );
}
