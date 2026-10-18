import { useEffect, useRef } from "react";
import { FOCUSABLE_SELECTOR, dialogKeyAction, nextFocusIndex } from "./dialogFocus.js";

/**
 * Modal focus handling: focus moves into the dialog on open (to `initialRef`
 * or the first focusable element), Tab stays inside it, Escape dismisses it
 * unless it is busy, background scrolling is locked, and focus returns to the
 * element that opened it when it closes.
 *
 * Keys are handled on `window` in the capture phase, which runs before any
 * document-level handler: a confirmation opened over another modal owns
 * Escape and Tab, and the modal underneath never sees them. Open dialogs
 * form a stack: only the top-most one reacts to keys.
 */
const openDialogs = [];

/**
 * The page scroll lock, shared by the whole dialog stack: taken when the FIRST
 * dialog opens and released only when the LAST one closes, so closing a
 * stacked dialog never unlocks the page under the one still open.
 *
 * The page scroller in this app is <html>, not <body>: the global styles give
 * <html> overflow-x: hidden, so its overflow-y computes to auto and it scrolls
 * the page. Both are locked, each restored to its own previous inline value,
 * and the page is put back at the exact scroll position it had on open.
 */
let pageLock = null;

function lockPage() {
  if (pageLock) return;
  const root = document.documentElement;
  pageLock = {
    x: window.scrollX,
    y: window.scrollY,
    bodyOverflow: document.body.style.overflow,
    rootOverflow: root.style.overflow,
  };
  document.body.style.overflow = "hidden";
  root.style.overflow = "hidden";
}

function unlockPage() {
  if (!pageLock) return;
  const { x, y, bodyOverflow, rootOverflow } = pageLock;
  pageLock = null;
  document.body.style.overflow = bodyOverflow;
  document.documentElement.style.overflow = rootOverflow;
  window.scrollTo({ left: x, top: y, behavior: "instant" });
}

/** A dialog joins the stack; the first one takes the page lock. */
export function enterDialog(token) {
  if (openDialogs.length === 0) lockPage();
  openDialogs.push(token);
}

/** A dialog leaves the stack; the last one out releases the page lock. */
export function leaveDialog(token) {
  const at = openDialogs.indexOf(token);
  if (at !== -1) openDialogs.splice(at, 1);
  if (openDialogs.length === 0) unlockPage();
}

/** Only the top-most open dialog reacts to keys. */
export const isTopDialog = (token) => openDialogs[openDialogs.length - 1] === token;

// Focus without letting the browser scroll the page to the element.
const focusQuietly = (el) => el?.focus?.({ preventScroll: true });

export function useDialogFocus({ dialogRef, initialRef, onDismiss, busy = false, dismissible = true }) {
  const busyRef = useRef(busy);
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    busyRef.current = busy;
    dismissRef.current = onDismiss;
  });

  useEffect(() => {
    const opener = document.activeElement;
    const dialog = dialogRef.current;
    // Join the stack (and lock the page) first, so focusing cannot move the page.
    const token = {};
    enterDialog(token);
    const first = initialRef?.current || dialog?.querySelector(FOCUSABLE_SELECTOR) || dialog;
    focusQuietly(first);

    const onKeyDown = (event) => {
      if (!isTopDialog(token)) return;
      const action = dialogKeyAction({ key: event.key, busy: busyRef.current, dismissible });
      if (action === "dismiss" || action === "trap" || event.key === "Escape") event.stopPropagation();
      if (action === "dismiss") {
        dismissRef.current?.();
        return;
      }
      if (action !== "trap") return;
      const focusable = [...(dialogRef.current?.querySelectorAll(FOCUSABLE_SELECTOR) ?? [])];
      const next = nextFocusIndex({
        count: focusable.length,
        current: focusable.indexOf(document.activeElement),
        shift: event.shiftKey,
      });
      if (next === null) return;
      event.preventDefault();
      if (next >= 0) focusQuietly(focusable[next]);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      // Restores overflow and the exact scroll position — last dialog only.
      leaveDialog(token);
      if (opener && typeof opener.focus === "function" && document.contains(opener)) focusQuietly(opener);
    };
    // Runs once per open dialog; the refs above carry the latest callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
