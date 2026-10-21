/**
 * Admin inventory removal controls — the web's pure model.
 *
 * Mirrors functions/src/inventoryRemoval.js so the Admin dialogs can say up
 * front why an action is unavailable, and so a form is checked before it is
 * sent. The SERVER stays the authority: it repeats every check inside its
 * transaction against the live documents, and Firestore rules refuse every
 * direct client write to the fields involved.
 *
 * PURE. No Firebase, no React, no clock — "today" is passed in.
 */

/** Matches REMOVAL_REASONS on the server. */
export const REMOVAL_REASONS = Object.freeze(["damaged", "expired", "recalled"]);
export const REMOVAL_REASON_LABELS = Object.freeze({
  damaged: "Damaged",
  expired: "Expired",
  recalled: "Recalled",
});

/** quarantine: free doses → quarantined. dispose: quarantined doses → written off. */
export const REMOVAL_ACTIONS = Object.freeze(["quarantine", "dispose"]);

/** Same bound as the server and the rules. */
export const MAX_REMOVAL_TEXT = 500;
export const MIN_REASON_TEXT = 3;

/** Shown wherever available stock is zero. The batch and vaccine stay. */
export const OUT_OF_STOCK_LABEL = "Out of stock";

/**
 * The stored batch fields the removal checks read — copied by value, never
 * authored. Pages hold this instead of naming stock counters themselves.
 */
export function removalSource(raw) {
  const keys = [
    "voided",
    "usageTracked",
    "firstUsedAt",
    "quantity",
    "reservedQuantity",
    "returnPendingQuantity",
    "quarantinedQuantity",
    "writtenOffQuantity",
  ];
  return Object.fromEntries(keys.map((k) => [k, raw?.[k] ?? null]));
}

export function isBatchVoided(batch) {
  return batch?.voided === true;
}

export function isVaccineArchived(vaccine) {
  return vaccine?.archived === true;
}

function counter(raw) {
  if (raw === undefined || raw === null) return 0;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

/**
 * The batch's counters as whole numbers, or null when any is unusable (the
 * server refuses removal on such a batch until it is reviewed).
 */
export function readRemovalCounters(batch) {
  const onHand = counter(batch?.quantity);
  const reserved = counter(batch?.reservedQuantity);
  const returnPending = counter(batch?.returnPendingQuantity);
  const quarantined = counter(batch?.quarantinedQuantity);
  const writtenOff = counter(batch?.writtenOffQuantity);
  if ([onHand, reserved, returnPending, quarantined, writtenOff].includes(null)) return null;
  const held = reserved + returnPending + quarantined;
  if (held > onHand) return null;
  return { onHand, reserved, returnPending, quarantined, writtenOff, free: onHand - held };
}

/**
 * Can this batch be voided, judged from the document — mirrors the server's
 * `voidRefusal`. The server additionally checks reservations, returns and
 * allocation history inside its transaction.
 *
 * @returns {{ok: true} | {ok: false, code: string, message: string}}
 */
export function voidEligibility(batch) {
  if (isBatchVoided(batch)) {
    return { ok: false, code: "batch-voided", message: "This batch is already voided." };
  }
  if (batch?.usageTracked !== true) {
    return {
      ok: false,
      code: "batch-usage-unproven",
      message:
        "This batch was added before VaxTrack recorded batch usage, so it cannot be proven unused and cannot be voided. To take its doses out of stock, use Remove unusable stock instead.",
    };
  }
  if (batch.firstUsedAt) {
    return {
      ok: false,
      code: "batch-in-use",
      message:
        "This batch has already been used by an order, so it cannot be voided. To take its doses out of stock, use Remove unusable stock instead.",
    };
  }
  for (const f of ["reservedQuantity", "returnPendingQuantity", "quarantinedQuantity", "writtenOffQuantity"]) {
    const c = counter(batch[f]);
    if (c === null) {
      return { ok: false, code: "inventory-invariant-broken", message: "This batch's stock figures are not valid and need review." };
    }
    if (c > 0) {
      return {
        ok: false,
        code: "batch-in-use",
        message: "This batch has reserved, returned, quarantined or written-off doses, so it cannot be voided.",
      };
    }
  }
  return { ok: true };
}

/** A required explanation: 3–500 characters after trimming. */
export function validateReasonText(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < MIN_REASON_TEXT) {
    return { ok: false, message: `Please give a ${label} (at least ${MIN_REASON_TEXT} characters).` };
  }
  if (text.length > MAX_REMOVAL_TEXT) {
    return { ok: false, message: `Please keep the ${label} under ${MAX_REMOVAL_TEXT} characters.` };
  }
  return { ok: true, value: text };
}

/**
 * Check a quarantine/dispose request against the batch as currently shown.
 * `expired` is whether the batch's expiry date has passed (Manila), computed
 * by the caller from the shared expiry helper.
 *
 * @returns {{ok: true, value: object} | {ok: false, field: string, message: string}}
 */
export function validateStockRemoval({ action, quantity, reason, notes, batch, expired }) {
  if (!REMOVAL_ACTIONS.includes(action)) {
    return { ok: false, field: "action", message: "Choose quarantine or dispose." };
  }
  if (isBatchVoided(batch)) {
    return { ok: false, field: "action", message: "This batch was voided; it has no stock to remove." };
  }
  const counters = readRemovalCounters(batch);
  if (!counters) {
    return { ok: false, field: "action", message: "This batch's stock figures are not valid and need review before stock can be removed." };
  }
  if (!REMOVAL_REASONS.includes(reason)) {
    return { ok: false, field: "reason", message: "Choose damaged, expired or recalled." };
  }
  if (reason === "expired" && !expired) {
    return { ok: false, field: "reason", message: "This batch has not expired. Choose damaged or recalled, or check its expiry date." };
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { ok: false, field: "quantity", message: "Enter a whole number of doses of at least 1." };
  }
  const limit = action === "quarantine" ? counters.free : counters.quarantined;
  if (quantity > limit) {
    return {
      ok: false,
      field: "quantity",
      message:
        action === "quarantine"
          ? limit === 0
            ? "No doses on this batch are free to quarantine. Reserved doses and returned doses awaiting a decision cannot be removed here."
            : `Only ${limit} dose${limit === 1 ? " is" : "s are"} free to quarantine. Reserved doses and returned doses awaiting a decision cannot be removed here.`
          : limit === 0
            ? "This batch has no quarantined doses. Quarantine doses before disposing of them."
            : `Only ${limit} dose${limit === 1 ? " is" : "s are"} in quarantine. Quarantine doses before disposing of them.`,
    };
  }
  const note = typeof notes === "string" ? notes.trim() : "";
  if (note.length > MAX_REMOVAL_TEXT) {
    return { ok: false, field: "notes", message: `Please keep the note under ${MAX_REMOVAL_TEXT} characters.` };
  }
  return { ok: true, value: { action, quantity, reason, notes: note || null } };
}

/** One audit entry as the Admin batch history shows it. */
export function describeAuditEvent(event) {
  const qty = Number.isInteger(event?.quantity) ? event.quantity : null;
  const doses = qty === null ? "" : `${qty} dose${qty === 1 ? "" : "s"}`;
  const reason = REMOVAL_REASON_LABELS[event?.reason] ?? null;
  switch (event?.action) {
    case "stock_quarantined":
      return `Quarantined ${doses}${reason ? ` — ${reason.toLowerCase()}` : ""}`;
    case "stock_disposed":
      return `Disposed of ${doses}${reason ? ` — ${reason.toLowerCase()}` : ""}`;
    case "stock_corrected": {
      const from = Number.isInteger(event?.before?.onHand) ? event.before.onHand : null;
      const to = Number.isInteger(event?.after?.onHand) ? event.after.onHand : null;
      const kind = event?.reasonCode === "entry_error" ? "data-entry error" : event?.reasonCode === "count_discrepancy" ? "recount" : null;
      return `On hand corrected${from !== null && to !== null ? ` from ${from} to ${to}` : to !== null ? ` to ${to}` : ""}${kind ? ` — ${kind}` : ""}`;
    }
    case "batch_voided":
      return "Batch voided";
    case "vaccine_archived":
      return "Vaccine archived";
    case "vaccine_restored":
      return "Vaccine restored";
    default:
      return "Inventory change";
  }
}
