import {
  floatingEnabled,
  movedPosition,
  pointerZone,
  resizedSize,
} from "./floatingWindowModel.js";

/**
 * Movable, resizable dialog windows (2026-11-14), for EVERY modal window in
 * the app without per-dialog code:
 *   - drag the title band (top 64px, not its buttons or fields) to move it;
 *   - drag the bottom-right corner to resize it;
 *   - double-click the title band to put it back in the centre at its size;
 *   - its last row of buttons stays pinned at the bottom while it scrolls.
 * installFloatingWindows() (main.jsx) watches the page and applies this to
 * each `role="dialog"` + `aria-modal="true"` window (and alert dialogs) as it
 * opens. Side drawers are full height by design and are left alone, as in
 * dialog-fit.css. Off below 640px wide, where windows fill the screen.
 */

const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"], [role="alertdialog"]';
const SKIP_SELECTOR = ".mdl-drawer, .geo3-drawer, .rq-cart-drawer";

// Things that keep their own pointer behaviour inside the title band.
const INTERACTIVE =
  "button, a, input, select, textarea, label, summary, [role='button'], [contenteditable='true'], .leaflet-container";

// Content that belongs above the action row, never inside a pinned footer.
const FIELDS = "input:not([type='hidden']), select, textarea, .leaflet-container, table";

/** The last child that takes up room (not an overlaid close button). */
function lastRealChild(node) {
  for (const child of [...node.children].reverse()) {
    const style = window.getComputedStyle(child);
    if (style.position === "absolute" || style.position === "fixed" || style.display === "none") continue;
    return child;
  }
  return null;
}

/**
 * The window's action row: the last row of buttons with no fields in it. When
 * the window's last child is a wrapper (often the whole <form>), look inside
 * it, a few levels deep, for its own last row instead of pinning the form.
 */
function findFooter(dialog) {
  let node = dialog;
  for (let depth = 0; depth < 4; depth += 1) {
    const child = lastRealChild(node);
    if (!child) return null;
    if (!child.matches(FIELDS) && !child.querySelector(FIELDS)) {
      return child.matches("button") || child.querySelector("button") ? child : null;
    }
    node = child;
  }
  return null;
}

/** Mark (or re-mark, as content changes) the action row to pin. */
function markFooter(dialog) {
  const footer = findFooter(dialog);
  for (const el of dialog.querySelectorAll("[data-vt-footer]")) {
    if (el !== footer) el.removeAttribute("data-vt-footer");
  }
  if (footer && !footer.hasAttribute("data-vt-footer")) footer.setAttribute("data-vt-footer", "");
}

/** Make one open window movable and resizable. Returns a cleanup. */
export function makeFloating(dialog) {
  if (!dialog || typeof window === "undefined") return () => {};

  // Every screen size: the window fits the screen and its buttons stay pinned
  // at the bottom (dialog-fit.css). Moving and resizing are checked per event,
  // so they switch on and off as the screen changes (a tablet rotating).
  dialog.classList.add("vt-float");
  markFooter(dialog);

  let drag = null;
  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
  const interactiveAt = (target) => {
    const hit = target?.closest?.(INTERACTIVE);
    return Boolean(hit && dialog.contains(hit));
  };
  const zoneAt = (event) => pointerZone({
    x: event.clientX,
    y: event.clientY,
    rect: dialog.getBoundingClientRect(),
    interactive: interactiveAt(event.target),
  });

  // Take the window out of the centred layout at its current place and size.
  const detach = (rect) => {
    Object.assign(dialog.style, {
      position: "fixed",
      left: `${Math.round(rect.left)}px`,
      top: `${Math.round(rect.top)}px`,
      width: `${Math.round(rect.width)}px`,
      margin: "0",
      transform: "none",
      maxWidth: "none",
    });
    dialog.classList.add("vt-float-placed");
  };

  const onPointerDown = (event) => {
    if (event.button !== 0 || !floatingEnabled(window.innerWidth)) return;
    const zone = zoneAt(event);
    if (!zone) return;
    event.preventDefault();
    const rect = dialog.getBoundingClientRect();
    detach(rect);
    if (zone === "resize") {
      dialog.style.height = `${Math.round(rect.height)}px`;
      dialog.classList.add("vt-float-sized");
    }
    drag = { zone, x: event.clientX, y: event.clientY, start: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } };
    dialog.classList.add(zone === "move" ? "vt-float-moving" : "vt-float-resizing");
    try { dialog.setPointerCapture?.(event.pointerId); } catch { /* the drag still follows the pointer over the window */ }
  };

  const onPointerMove = (event) => {
    if (!drag) {
      // Cursor hint only: which zone is under the pointer.
      const zone = floatingEnabled(window.innerWidth) ? zoneAt(event) : null;
      if (zone) dialog.setAttribute("data-vt-zone", zone);
      else dialog.removeAttribute("data-vt-zone");
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (drag.zone === "move") {
      const { left, top } = movedPosition({ start: drag.start, dx, dy, viewport: viewport() });
      dialog.style.left = `${left}px`;
      dialog.style.top = `${top}px`;
    } else {
      const { width, height } = resizedSize({ start: drag.start, dx, dy, viewport: viewport() });
      dialog.style.width = `${width}px`;
      dialog.style.height = `${height}px`;
    }
  };

  const endDrag = (event) => {
    if (!drag) return;
    drag = null;
    dialog.classList.remove("vt-float-moving", "vt-float-resizing");
    if (dialog.hasPointerCapture?.(event.pointerId)) dialog.releasePointerCapture(event.pointerId);
  };

  // A drag that ends over the backdrop must not count as a click that closes
  // the window: swallow the click that follows a move or resize.
  let suppressClick = false;
  const markDragged = () => { if (drag) suppressClick = true; };
  const onClickCapture = (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.stopPropagation();
    event.preventDefault();
  };

  // Back to the centre, at the window's own size.
  const resetPlacement = () => {
    for (const prop of ["position", "left", "top", "width", "height", "margin", "transform", "maxWidth"]) {
      dialog.style[prop] = "";
    }
    dialog.classList.remove("vt-float-placed", "vt-float-sized");
  };
  // Double-click the title band to reset.
  const onDoubleClick = (event) => {
    if (!floatingEnabled(window.innerWidth) || zoneAt(event) !== "move") return;
    resetPlacement();
  };

  // A smaller browser window must not leave the title band out of reach, and a
  // screen narrowed to phone size puts a moved or resized window back in the
  // phone layout (full width, buttons pinned).
  const onWindowResize = () => {
    if (!dialog.classList.contains("vt-float-placed")) return;
    if (!floatingEnabled(window.innerWidth)) {
      resetPlacement();
      return;
    }
    const rect = dialog.getBoundingClientRect();
    const { left, top } = movedPosition({ start: rect, dx: 0, dy: 0, viewport: viewport() });
    dialog.style.left = `${left}px`;
    dialog.style.top = `${top}px`;
  };

  dialog.addEventListener("pointerdown", onPointerDown);
  dialog.addEventListener("pointermove", onPointerMove);
  dialog.addEventListener("pointermove", markDragged);
  dialog.addEventListener("pointerup", endDrag);
  dialog.addEventListener("pointercancel", endDrag);
  dialog.addEventListener("click", onClickCapture, true);
  dialog.addEventListener("dblclick", onDoubleClick);
  window.addEventListener("resize", onWindowResize);

  const stop = () => {
    dialog.removeEventListener("pointerdown", onPointerDown);
    dialog.removeEventListener("pointermove", onPointerMove);
    dialog.removeEventListener("pointermove", markDragged);
    dialog.removeEventListener("pointerup", endDrag);
    dialog.removeEventListener("pointercancel", endDrag);
    dialog.removeEventListener("click", onClickCapture, true);
    dialog.removeEventListener("dblclick", onDoubleClick);
    window.removeEventListener("resize", onWindowResize);
  };
  stop.refresh = () => markFooter(dialog);
  return stop;
}

/**
 * Watch the page and make every modal window floating as it opens, and clean
 * up as it closes. Checks once per burst of page changes. Call once.
 */
export function installFloatingWindows() {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
  const active = new Map();
  let scheduled = false;

  const scan = () => {
    scheduled = false;
    for (const [el, stop] of active) {
      if (!el.isConnected) {
        stop();
        active.delete(el);
      } else {
        stop.refresh?.(); // content may have changed (loading → form)
      }
    }
    for (const el of document.querySelectorAll(MODAL_SELECTOR)) {
      if (active.has(el) || el.matches(SKIP_SELECTOR)) continue;
      active.set(el, makeFloating(el));
    }
  };
  // A short timer rather than requestAnimationFrame, which some embedded or
  // background views never run: one scan per burst of page changes.
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(scan, 16);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  schedule();
  return () => {
    observer.disconnect();
    for (const stop of active.values()) stop();
    active.clear();
  };
}
