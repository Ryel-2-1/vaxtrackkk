import { useEffect, useRef } from "react";
import { FOCUSABLE_SELECTOR, dialogKeyAction, nextFocusIndex } from "./dialogFocus";

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
    const first = initialRef?.current || dialog?.querySelector(FOCUSABLE_SELECTOR) || dialog;
    first?.focus?.();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const token = {};
    openDialogs.push(token);

    const onKeyDown = (event) => {
      if (openDialogs[openDialogs.length - 1] !== token) return;
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
      if (next >= 0) focusable[next].focus();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      const at = openDialogs.indexOf(token);
      if (at !== -1) openDialogs.splice(at, 1);
      document.body.style.overflow = prevOverflow;
      if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus();
    };
    // Runs once per open dialog; the refs above carry the latest callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
