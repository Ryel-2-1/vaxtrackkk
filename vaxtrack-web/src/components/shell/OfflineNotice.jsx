import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { WifiOff } from "lucide-react";
import { OFFLINE_MESSAGE, readOnlineStatus, subscribeOnlineStatus } from "./onlineStatus";
import "./OfflineNotice.css";

const subscribe = (onChange) => subscribeOnlineStatus(typeof window === "undefined" ? null : window, onChange);
const getSnapshot = () => readOnlineStatus(typeof window === "undefined" ? null : window);
const getServerSnapshot = () => true;

/**
 * Shown by each role shell while the browser is offline. Rendered into <body>
 * so it never becomes a child of the shells' layout containers (whose CSS
 * expects specific direct children).
 */
export default function OfflineNotice() {
  const online = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (online || typeof document === "undefined") return null;
  return createPortal(
    <div className="vt-offline-notice" role="status" aria-live="polite">
      <WifiOff size={16} aria-hidden="true" />
      <span>{OFFLINE_MESSAGE}</span>
    </div>,
    document.body
  );
}
