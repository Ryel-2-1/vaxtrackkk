import { useId, useRef, useState } from "react";
import { Check, MoreHorizontal, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { notificationSwipeAction } from "../../services/notificationPanelState";

export default function NotificationPanelItem({ title, isRead, onRead, onDelete, children }) {
  const [open, setOpen] = useState(false);
  const actionsId = useId();
  const moreRef = useRef(null);
  const start = useRef(null);
  const suppressClick = useRef(false);
  const onPointerDown = (event) => {
    suppressClick.current = false;
    start.current = event.pointerType === "touch" || event.pointerType === "pen"
      ? { x: event.clientX, y: event.clientY } : null;
  };
  const onPointerUp = (event) => {
    if (!start.current) return;
    const action = notificationSwipeAction(event.clientX - start.current.x, event.clientY - start.current.y);
    start.current = null;
    if (action) {
      suppressClick.current = true;
      setOpen(action === "open");
    }
  };

  return <div className={`bell-notice-row${open ? " is-open" : ""}`} onKeyDown={(event) => {
    if (event.key === "Escape" && open) {
      event.stopPropagation(); setOpen(false); moreRef.current?.focus();
    }
  }}>
    <div className="bell-notice-actions" id={actionsId} aria-hidden={!open}>
      <button type="button" disabled={isRead} tabIndex={open ? 0 : -1}
        aria-label={`Mark as read: ${title}`} onClick={() => { onRead(); setOpen(false); }}>
        <Check size={16} aria-hidden="true" /><span>{isRead ? "Read" : "Mark read"}</span>
      </button>
      <button type="button" className="bell-notice-delete" tabIndex={open ? 0 : -1}
        aria-label={`Delete notification: ${title}`} onClick={onDelete}>
        <Trash2 size={16} aria-hidden="true" /><span>Delete</span>
      </button>
    </div>
    <div className="bell-notice-content" onPointerDown={onPointerDown} onPointerUp={onPointerUp}
      onPointerCancel={() => { start.current = null; }}
      onClickCapture={(event) => {
        if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; }
      }}>
      {children}
      <button ref={moreRef} type="button" className="bell-notice-more" aria-label={`Options for ${title}`}
        aria-expanded={open} aria-controls={actionsId} onClick={() => setOpen((value) => !value)}>
        <MoreHorizontal size={18} aria-hidden="true" />
      </button>
    </div>
  </div>;
}

export function NotificationPanelFooter({ canClear, onClear, canUndo, onUndo, historyPath, historyLabel = "View all alerts", onHistory }) {
  return <div className="bell-panel-footer">
    {canUndo && <div className="bell-panel-undo" role="status"><span>Removed from this panel.</span><button type="button" onClick={onUndo}>Undo</button></div>}
    <div className="bell-panel-footer-actions">
      <Link to={historyPath} onClick={onHistory}>{historyLabel}</Link>
      <button type="button" onClick={onClear} disabled={!canClear}>Clear panel</button>
    </div>
    <small>Alert records are kept. Saved in this browser.</small>
  </div>;
}
