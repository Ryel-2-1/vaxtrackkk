import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { RefreshCw, WifiOff } from "lucide-react";
import { OFFLINE_MESSAGE, readOnlineStatus, subscribeOnlineStatus } from "./onlineStatus";
import { LIVE_FAILED_MESSAGE, RECONNECTING_MESSAGE, liveConnection } from "../../services/liveConnection";
import "./OfflineNotice.css";

const subscribe = (onChange) => subscribeOnlineStatus(typeof window === "undefined" ? null : window, onChange);
const getSnapshot = () => readOnlineStatus(typeof window === "undefined" ? null : window);
const getServerSnapshot = () => true;
const EMPTY_CONNECTION = { reconnecting: 0, failed: 0, retryable: 0 };

/**
 * Shown by each role shell when the page's live data may be out of date:
 *   - the browser is offline (Firestore resumes on its own when it returns);
 *   - a live listener failed and is reconnecting (the page keeps its last data);
 *   - a listener gave up — "Try again" re-opens exactly the listeners that
 *     failed (permission and missing-index failures are reported by the page
 *     itself, where re-trying would not help).
 * Rendered into <body> so it never becomes a child of the shells' layout
 * containers (whose CSS expects specific direct children). Non-blocking.
 */
export default function OfflineNotice() {
  const online = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const live = useSyncExternalStore(liveConnection.subscribe, liveConnection.getSnapshot, () => EMPTY_CONNECTION);
  if (typeof document === "undefined") return null;

  let body = null;
  if (!online) {
    body = (
      <div className="vt-offline-notice" role="status" aria-live="polite">
        <WifiOff size={16} aria-hidden="true" />
        <span>{OFFLINE_MESSAGE}</span>
      </div>
    );
  } else if (live.retryable > 0) {
    body = (
      <div className="vt-offline-notice" role="status" aria-live="polite">
        <RefreshCw size={16} aria-hidden="true" />
        <span>{LIVE_FAILED_MESSAGE}</span>
        <button type="button" className="vt-offline-retry" onClick={() => liveConnection.retryFailed()}>
          Try again
        </button>
      </div>
    );
  } else if (live.reconnecting > 0) {
    body = (
      <div className="vt-offline-notice" role="status" aria-live="polite">
        <RefreshCw size={16} aria-hidden="true" />
        <span>{RECONNECTING_MESSAGE}</span>
      </div>
    );
  }
  return body ? createPortal(body, document.body) : null;
}
