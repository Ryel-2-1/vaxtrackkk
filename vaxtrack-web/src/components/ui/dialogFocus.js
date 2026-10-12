// Keyboard behaviour for modal dialogs — the pure part, so it can be tested
// without a DOM. useDialogFocus (in ConfirmDialog.jsx) wires it to the page.

export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * What a key press inside an open dialog should do:
 *   "dismiss" — Escape, and the dialog may close now (not while it is saving)
 *   "trap"    — Tab / Shift+Tab, keep focus inside
 *   null      — leave it to the browser
 */
export function dialogKeyAction({ key, busy = false, dismissible = true }) {
  if (key === "Escape") return dismissible && !busy ? "dismiss" : null;
  if (key === "Tab") return "trap";
  return null;
}

/**
 * Where Tab should move focus, given `count` focusable elements and the index
 * of the one that has focus now (-1 when focus is outside the dialog).
 * Returns an index to focus, or null to let the browser move normally.
 * With nothing focusable it returns -1: keep focus where it is.
 */
export function nextFocusIndex({ count, current, shift }) {
  if (count <= 0) return -1;
  if (current < 0) return shift ? count - 1 : 0;
  if (shift && current === 0) return count - 1;
  if (!shift && current === count - 1) return 0;
  return null;
}
