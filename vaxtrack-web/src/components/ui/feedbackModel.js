// Message tones and their behaviour — pure, shared by Notice, the toast
// region and the pages, and testable without a DOM.
//
//   success — green: the change was saved
//   warning — amber: action required, or saved with a caveat
//   error   — red:   failed or blocked
//   info    — neutral/teal: a fact, an empty state, a hint
// Red is never used for an empty result or a neutral notice.

export const TONES = Object.freeze(["success", "warning", "error", "info"]);

export const TONE_LABELS = Object.freeze({ success: "Success", warning: "Warning", error: "Error", info: "Information" });

/** How long a toast stays, by tone. Errors stay until dismissed. */
export const TOAST_DURATION_MS = Object.freeze({ success: 6000, info: 6000, warning: 9000, error: null });

/** Only an error interrupts a screen reader; everything else waits its turn. */
export function liveRoleFor(tone) {
  return tone === "error" ? "alert" : "status";
}

export function normalizeTone(tone) {
  return TONES.includes(tone) ? tone : "info";
}
