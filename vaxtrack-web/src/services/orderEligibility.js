/**
 * The web's single source of truth for "can this batch be ordered right now?"
 *
 * It mirrors `evaluateBatch` in functions/src/policy.js — the same conditions in
 * the same order — so the Med Rep catalog can never offer a batch the trusted
 * callable will refuse. That mismatch is the defect this fixes: a batch stored
 * with status "Critical" (or any value the server does not treat as usable) has
 * a valid future date, a price and stock, so the catalog marked it orderable and
 * let it into the cart, and only the server refused it at submission with
 * `batch-unavailable` — "That batch is not available to order."
 *
 * PURE. No Firebase, no network, no React, no clock. The reference date is passed
 * in (`todayIso`, from `manilaToday(Date.now())`). The trusted server stays the
 * authoritative gate for races and stale clients; this only stops a rep from ever
 * building a cart the server will reject.
 *
 * The server file itself is deliberately NOT imported: pulling a functions/
 * module into the browser bundle is forbidden, and the small constants below are
 * copied with a comment tying them to their server twin so a policy change is
 * made in both places on purpose.
 */
import { deriveExpiryCondition } from "./expiry.js";
import { readPriceCentavos } from "./money.js";

/**
 * The batch statuses the server treats as orderable — the exact set in
 * `USABLE_STATUSES` in functions/src/policy.js. "critical" is intentionally NOT
 * here: a near-expiry batch is refused, which is why the catalog must refuse it
 * too rather than discovering it at checkout.
 */
export const ORDERABLE_STATUSES = Object.freeze([
  "ok",
  "low",
  "stable",
  "warning",
  "available",
]);

/** Stable reason codes the UI branches on — never parsed from prose. */
export const ELIGIBILITY_REASONS = Object.freeze({
  MISSING_INVENTORY_ID: "missing-inventory-id",
  INVALID_QUANTITY: "invalid-quantity",
  CRITICAL: "critical",
  UNAVAILABLE: "unavailable",
  EXPIRED: "expired",
  MISSING_EXPIRY: "missing-expiry",
  MISSING_PRICE: "missing-price",
  NO_AVAILABLE_STOCK: "no-available-stock",
  // Cart-line only: the batch is orderable, but the requested quantity is more
  // than is available. Mirrors the server's `insufficient-stock`.
  INSUFFICIENT_STOCK: "insufficient-stock",
});

/** Short, specific, human-readable reasons. Not asserted verbatim by tests. */
const REASON_MESSAGES = Object.freeze({
  "missing-inventory-id": "Batch record is missing an ID",
  "invalid-quantity": "Stock figure needs admin review",
  critical: "Critical batch is not orderable",
  unavailable: "Batch is not available to order",
  expired: "Expired batch",
  "missing-expiry": "Expiry date missing",
  "missing-price": "Price not available",
  "no-available-stock": "No available stock",
  "insufficient-stock": "Not enough stock available",
});

function normalizeStatus(status) {
  return typeof status === "string" ? status.trim().toLowerCase() : "";
}

/** True only for a status the server would accept. Mirrors `isUsableStatus`. */
export function isOrderableStatus(status) {
  const value = normalizeStatus(status);
  return value.length > 0 && ORDERABLE_STATUSES.includes(value);
}

/**
 * Available stock, derived: `quantity - reservedQuantity`.
 *
 * Missing `reservedQuantity` is the legitimate legacy default of 0 — the same
 * contract `readReservedQuantity` (functions/src/policy.js) and `availableStock`
 * (services/inventoryCallables.js) already define. Returns null when the batch's
 * own figures are unusable — a legacy string quantity, a corrupt reserved value,
 * or reserved exceeding stock (a broken invariant the server refuses) — because
 * that is a data problem for an admin, not "0 in stock".
 */
export function computeAvailableQuantity(batch) {
  const onHand = batch?.quantity;
  if (typeof onHand !== "number" || !Number.isInteger(onHand) || onHand < 0) {
    return null;
  }
  const reserved = batch?.reservedQuantity;
  if (reserved === undefined || reserved === null) return onHand;
  if (typeof reserved !== "number" || !Number.isInteger(reserved) || reserved < 0) {
    return null;
  }
  // reserved > onHand is a broken invariant on the server, not "some stock".
  if (reserved > onHand) return null;
  return onHand - reserved;
}

function reasonText(reasonCode, override) {
  return override ?? REASON_MESSAGES[reasonCode] ?? "Not available to order";
}

function ineligible(reasonCode, availableQuantity, normalizedStatus, override) {
  return {
    eligible: false,
    availableQuantity,
    normalizedStatus,
    reasonCode,
    reason: reasonText(reasonCode, override),
  };
}

/**
 * Decide one raw inventory document against the current policy.
 *
 * `batch` is the stored inventory document, its Firestore document id on
 * `batch.id`. `todayIso` is today in Manila ("YYYY-MM-DD"). The check order
 * mirrors the server (id → quantity/reserved → status → expiry → price →
 * available stock), so the reason a rep is shown is the reason the server would
 * report first.
 *
 * @returns {{eligible:boolean, availableQuantity:(number|null),
 *   normalizedStatus:(string|null), reasonCode:(string|null), reason:string}}
 */
export function evaluateBatchEligibility(batch, todayIso) {
  const normalizedStatus = normalizeStatus(batch?.status) || null;

  // 1. No Firestore document id → the server reads it verbatim and throws
  //    inventory-not-found. Guessing one from a name or SKU is forbidden.
  const inventoryId = typeof batch?.id === "string" ? batch.id.trim() : "";
  if (!inventoryId) {
    return ineligible(ELIGIBILITY_REASONS.MISSING_INVENTORY_ID, null, normalizedStatus);
  }

  // 2. Stock / reserved figures must be usable integers.
  const availableQuantity = computeAvailableQuantity(batch);
  if (availableQuantity === null) {
    const legacyString = typeof batch?.quantity === "string";
    return ineligible(
      ELIGIBILITY_REASONS.INVALID_QUANTITY,
      null,
      normalizedStatus,
      legacyString ? "Needs inventory migration" : undefined
    );
  }

  // 3. Stored status must be one the server treats as orderable. This is the
  //    check the catalog was missing — a "Critical" (or otherwise non-usable)
  //    status passed every other gate and then failed the callable.
  if (!isOrderableStatus(batch?.status)) {
    const code =
      normalizedStatus === "critical"
        ? ELIGIBILITY_REASONS.CRITICAL
        : ELIGIBILITY_REASONS.UNAVAILABLE;
    return ineligible(code, availableQuantity, normalizedStatus);
  }

  // 4. Expiry — from the DATE, mirroring the server: expired or undated is out.
  const expiry = deriveExpiryCondition(batch, todayIso);
  if (expiry.level === "expired") {
    return ineligible(ELIGIBILITY_REASONS.EXPIRED, availableQuantity, normalizedStatus);
  }
  if (expiry.level === "unknown") {
    return ineligible(ELIGIBILITY_REASONS.MISSING_EXPIRY, availableQuantity, normalizedStatus);
  }

  // 5. Price — a positive, safe-integer centavo amount, or the batch is unpriced.
  if (readPriceCentavos(batch?.sellingPriceCentavos) === null) {
    return ineligible(ELIGIBILITY_REASONS.MISSING_PRICE, availableQuantity, normalizedStatus);
  }

  // 6. There must be stock left to allocate.
  if (availableQuantity <= 0) {
    return ineligible(
      ELIGIBILITY_REASONS.NO_AVAILABLE_STOCK,
      availableQuantity,
      normalizedStatus
    );
  }

  return {
    eligible: true,
    availableQuantity,
    normalizedStatus,
    reasonCode: null,
    reason: "",
  };
}

/**
 * Re-check a cart line against the CURRENT inventory document for its batch.
 *
 * Used when live inventory changes under a cart, and again before the cart may
 * continue to checkout. A line whose batch has vanished, become ineligible, or
 * no longer has enough stock is reported — never silently dropped — so the page
 * can mark it and tell the rep exactly which batch to remove or correct.
 *
 * @param {{inventoryId:string, quantity:number}} cartLine
 * @param {object|null|undefined} batch the live inventory document, or null/undefined if gone
 * @param {string} todayIso today in Manila
 */
export function reconcileCartLine(cartLine, batch, todayIso) {
  if (!batch) {
    return {
      ok: false,
      reasonCode: ELIGIBILITY_REASONS.UNAVAILABLE,
      reason: "This batch is no longer in inventory",
      availableQuantity: null,
    };
  }

  const eligibility = evaluateBatchEligibility(batch, todayIso);
  if (!eligibility.eligible) {
    return {
      ok: false,
      reasonCode: eligibility.reasonCode,
      reason: eligibility.reason,
      availableQuantity: eligibility.availableQuantity,
    };
  }

  const quantity = cartLine?.quantity;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) {
    return {
      ok: false,
      reasonCode: ELIGIBILITY_REASONS.INVALID_QUANTITY,
      reason: "Enter a whole quantity of at least 1",
      availableQuantity: eligibility.availableQuantity,
    };
  }

  if (quantity > eligibility.availableQuantity) {
    return {
      ok: false,
      reasonCode: ELIGIBILITY_REASONS.INSUFFICIENT_STOCK,
      reason: `Only ${eligibility.availableQuantity} available`,
      availableQuantity: eligibility.availableQuantity,
    };
  }

  return {
    ok: true,
    reasonCode: null,
    reason: "",
    availableQuantity: eligibility.availableQuantity,
  };
}
