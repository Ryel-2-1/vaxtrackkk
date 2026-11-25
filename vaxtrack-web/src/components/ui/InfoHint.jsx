import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import "./InfoHint.css";

/** Explanatory copy shared by the web roles. Supports mouse, keyboard and touch. */
export default function InfoHint({ children, label = "More information", className = "", id }) {
  const generatedId = useId();
  const descriptionId = id || generatedId;
  const triggerRef = useRef(null);
  const popupRef = useRef(null);
  const closeTimer = useRef(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);

  const show = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hideAfterHover = () => {
    closeTimer.current = window.setTimeout(() => {
      if (document.activeElement !== triggerRef.current) setOpen(false);
    }, 150);
  };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      const popup = popupRef.current;
      if (!trigger || !popup) return;
      const rect = trigger.getBoundingClientRect();
      const width = popup.offsetWidth;
      const height = popup.offsetHeight;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const below = rect.bottom + 8;
      const top = below + height <= window.innerHeight - 8
        ? below : Math.max(8, rect.top - height - 8);
      setPosition({ left, top });
    };
    const dismissOutside = (event) => {
      if (!triggerRef.current?.contains(event.target) && !popupRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  return (
    <span className={`m-info-hint ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className="m-info-trigger"
        aria-label={label}
        aria-describedby={descriptionId}
        aria-expanded={open}
        onMouseEnter={show}
        onMouseLeave={hideAfterHover}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          show();
        }}
      >
        <Info size={17} aria-hidden="true" />
      </button>
      <span id={descriptionId} className="m-info-description">{children}</span>
      {open && createPortal(
        <div
          ref={popupRef}
          role="tooltip"
          className="m-info-popup"
          style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? "visible" : "hidden" }}
          onMouseEnter={show}
          onMouseLeave={hideAfterHover}
        >
          {children}
        </div>,
        document.body,
      )}
    </span>
  );
}
