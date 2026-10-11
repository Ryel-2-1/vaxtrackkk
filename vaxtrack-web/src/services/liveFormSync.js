// Keeping an editable form in step with live server data without ever throwing
// away what the user has typed.
//
// A form is seeded from a server record. When a newer snapshot arrives:
//   - nothing the form is built from changed  → leave it alone        ("same")
//   - a save/issue from THIS page is in flight → wait for it to finish ("defer")
//   - the user has no unsaved edits            → re-seed from the server ("seed")
//   - the user HAS unsaved edits               → keep them, and say that newer
//                                               data is available; the user
//                                               decides when to load it   ("stale")
//
// The comparison is on the SEEDED FORM, not on raw document fields, so a write
// to an unrelated field — a rider's location every few seconds on an order in
// transit — never disturbs a form, clean or dirty.

/** A stable signature of a form; generated row keys (`key`) are ignored. */
export function formSignature(form, extra = null) {
  return JSON.stringify({ form, extra }, (name, value) => (name === "key" ? undefined : value));
}

/** What to do with a newer server snapshot. See the table above. */
export function reconcileLiveForm({ dirty, busy, baselineKey, serverKey }) {
  if (serverKey === baselineKey) return "same";
  if (busy) return "defer";
  if (!dirty) return "seed";
  return "stale";
}
