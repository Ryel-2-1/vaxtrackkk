"use strict";

/**
 * Pure inventory-allocation policy.
 *
 * No Firestore, no Functions SDK, no clock injection beyond an explicit `now`,
 * so every rule below is unit-testable without an emulator. The callables in
 * index.js are thin wrappers; operations.js supplies the transaction. Anything
 * that decides YES or NO lives here.
 */

const crypto = require("node:crypto");

/** Schema version stamped on every server-allocated order. */
const ALLOCATION_VERSION = 1;

/** Reservation lifecycle. Both settled states are terminal. */
const RESERVATION_STATUSES = Object.freeze(["reserved", "consumed", "released"]);

/** Order statuses a delivery may be completed from. */
const DELIVERABLE_FROM = Object.freeze(["in_transit", "delayed"]);

/** Order statuses a dispatcher may cancel from. Mirrors firestore.rules. */
const CANCELLABLE_FROM = Object.freeze([
  "pending_dispatch", "assigned", "loading", "in_transit", "delayed", "delivery_failed",
]);

/** Bounds. maxLines caps the transaction's document reads; see operations.js. */
const MAX_ORDER_LINES = 20;
const MAX_LINE_QUANTITY = 1000000;
const MAX_REASON_LENGTH = 500; // identical to orderWorkflow.js / firestore.rules

/** Pricing schema version stamped on every server-priced order. */
const PRICING_VERSION = 1;

/**
 * Money is PHP CENTAVOS as an integer. Never a float, never a decimal string.
 *
 * A peso float cannot represent ₱0.10 exactly, so a subtotal built from floats
 * drifts — which is precisely what the invoice layer's 0.01 tolerance was
 * absorbing. Centavos make every figure exact, and the only rounding in the
 * system becomes the VAT calculation the invoice already documents.
 *
 * The price stored on a batch is the VAT-EXCLUSIVE clinic selling price;
 * invoices add 12% on top. Both facts are recorded on the order itself rather
 * than inferred, so a reader never has to guess which convention applied.
 */
const PRICE_CURRENCY = "PHP";
const PRICE_IS_VAT_INCLUSIVE = false;

/**
 * There is NO business maximum on a unit price.
 *
 * An earlier draft invented a ₱100,000.00 ceiling. Nobody approved that figure,
 * and a made-up limit is a business rule smuggled in as a validation: the first
 * legitimately expensive product would be refused for a reason no one decided.
 *
 * What remains is arithmetic safety, which is not a business rule: a price must
 * be a whole number of centavos that JavaScript can represent EXACTLY. Beyond
 * Number.MAX_SAFE_INTEGER integers silently collide (2^53 and 2^53+1 are the
 * same value), so a figure past that point cannot be stored or summed honestly.
 * Every multiplication and sum below is checked against the same limit rather
 * than being assumed safe by a ceiling that no longer exists.
 */

/**
 * Batch expiry cutoff — DATE-ONLY, Asia/Manila (UTC+8, no DST).
 *
 * Inventory stores `expiryDate` as a plain "YYYY-MM-DD" calendar date with no
 * time or zone. Comparing that against a UTC instant would expire a batch up to
 * eight hours early for a warehouse in Manila. So both sides are reduced to a
 * Manila calendar date and compared as strings, which is exact for ISO dates.
 *
 * A batch is expired when its expiry date is STRICTLY BEFORE today in Manila —
 * stock is usable through the whole of its expiry date.
 */
const MANILA_OFFSET_MINUTES = 8 * 60;

function manilaDateString(now) {
  const shifted = new Date(now.getTime() + MANILA_OFFSET_MINUTES * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** True when `expiryDate` is a usable ISO date strictly before today in Manila. */
function isExpired(expiryDate, now) {
  const iso = isoDateOnly(expiryDate);
  if (iso === null) return false; // unparseable is handled by isUsableBatch
  return iso < manilaDateString(now);
}

/** "YYYY-MM-DD" if the value is exactly that, else null. Never guesses a date. */
function isoDateOnly(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Round-trip guard: rejects "2026-02-31", which Date would roll over.
  return parsed.toISOString().slice(0, 10) === text ? text : null;
}

/** A domain failure with a stable code. Mapped to a client message by index.js. */
class PolicyError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * A stock figure written by the app: a non-negative Firestore INTEGER.
 *
 * Numeric strings are deliberately NOT coerced. Three staging batches hold
 * `quantity` as "120" / "35" / "80", and silently reading those as numbers is
 * how a migration gets skipped forever — arithmetic would appear to work while
 * the stored type stayed wrong. They are rejected with a distinct code so the
 * UI can say "needs migration" rather than "out of stock".
 */
function readStockInteger(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return { ok: true, value };
  }
  if (typeof value === "string") return { ok: false, reason: "legacy-string" };
  return { ok: false, reason: "invalid" };
}

/**
 * `reservedQuantity` for a batch that may predate reservations.
 *
 * Absent means zero — that is a genuine "never reserved" batch. Present but not
 * a non-negative integer is corruption and must not be defaulted away, or the
 * bad value would be silently replaced by a reservation that overwrites it.
 */
function readReservedQuantity(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: 0 };
  return readStockInteger(raw);
}

/**
 * The selling price stored on an inventory batch.
 *
 * Strictly positive: a batch priced at zero would ship a vaccine for free, and
 * no clinic price is legitimately ₱0.00. Absent is its own reason rather than a
 * default, because "this batch has never been priced" is an admin task, not an
 * error in the rep's cart — the catalog disables such a batch and says so.
 *
 * Numeric strings are refused for the same reason `quantity` refuses them: a
 * coerced "500" would make a stored-type problem invisible while arithmetic
 * appeared to work.
 */
function readSellingPriceCentavos(value) {
  if (value === undefined || value === null) return { ok: false, reason: "missing" };
  if (typeof value === "string") return { ok: false, reason: "legacy-string" };
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, reason: "invalid" };
  }
  // Not a price cap — an exactness cap. Past MAX_SAFE_INTEGER the stored figure
  // is no longer the figure that was meant.
  if (!Number.isSafeInteger(value)) return { ok: false, reason: "not-safe-integer" };
  if (value <= 0) return { ok: false, reason: "not-positive" };
  return { ok: true, value };
}

/**
 * The price the CALLER believed applied when the cart was built.
 *
 * This is never used as a price. It is compared against the batch's live price
 * and, on any difference, the checkout is refused so a human can review it —
 * which is what makes a silently re-priced cart impossible in either direction.
 * A caller that omits it is refused too: an unconfirmed price is not a
 * confirmed one, and defaulting would turn the check off for stale clients.
 */
function validateExpectedPriceCentavos(value) {
  if (value === undefined || value === null) {
    return { ok: false, code: "price-not-confirmed" };
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return { ok: false, code: "invalid-expected-price" };
  }
  return { ok: true, value };
}

/** A requested line quantity: a positive integer within bounds. */
function validateLineQuantity(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, code: "invalid-quantity" };
  }
  if (!Number.isInteger(value)) return { ok: false, code: "invalid-quantity" };
  if (value <= 0) return { ok: false, code: "invalid-quantity" };
  if (value > MAX_LINE_QUANTITY) return { ok: false, code: "quantity-too-large" };
  return { ok: true, value };
}

/**
 * `unitPrice` is deliberately GONE.
 *
 * It used to be accepted from the caller and stored verbatim. Now the price is
 * read from the batch, so a caller that still sends one is refused with
 * `unknown-field` rather than having it quietly ignored — a stale client that
 * believes it is setting prices must fail loudly, not appear to succeed.
 */
const ALLOWED_LINE_KEYS = Object.freeze([
  "inventoryId",
  "quantity",
  "expectedUnitPriceCentavos",
]);

/**
 * The create payload, validated by shape before anything is read.
 *
 * Unknown keys are REJECTED rather than ignored: silently dropping a field the
 * caller believed was meaningful is how a client and a server drift apart.
 * Display text (name, batch, chain, type) is deliberately not accepted at all —
 * every one of those is snapshotted server-side from the inventory document,
 * and so is every figure of money.
 */
function validateCreatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PolicyError("invalid-payload", "The order request was malformed.");
  }
  const lines = payload.items;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new PolicyError("invalid-payload", "An order needs at least one item.");
  }
  if (lines.length > MAX_ORDER_LINES) {
    throw new PolicyError(
      "too-many-lines",
      `An order can hold at most ${MAX_ORDER_LINES} batches.`
    );
  }

  const seen = new Set();
  const items = lines.map((line) => {
    if (!line || typeof line !== "object" || Array.isArray(line)) {
      throw new PolicyError("invalid-payload", "An order item was malformed.");
    }
    for (const key of Object.keys(line)) {
      if (!ALLOWED_LINE_KEYS.includes(key)) {
        throw new PolicyError(
          "unknown-field",
          `Order items cannot carry "${key}".`
        );
      }
    }
    const inventoryId = line.inventoryId;
    if (typeof inventoryId !== "string" || inventoryId.trim() === "") {
      throw new PolicyError("invalid-payload", "Each item needs a batch.");
    }
    if (inventoryId.includes("/")) {
      throw new PolicyError("invalid-payload", "Each item needs a batch.");
    }
    // One line is one batch. Combining duplicates would silently change what
    // the rep asked for, and splitting is explicitly out of scope.
    if (seen.has(inventoryId)) {
      throw new PolicyError(
        "duplicate-inventory-line",
        "The same batch appears twice. Combine it into a single line."
      );
    }
    seen.add(inventoryId);

    const qty = validateLineQuantity(line.quantity);
    if (!qty.ok) {
      throw new PolicyError(
        qty.code,
        qty.code === "quantity-too-large"
          ? `Quantity must be ${MAX_LINE_QUANTITY} or fewer.`
          : "Quantity must be a whole number greater than zero."
      );
    }

    const expected = validateExpectedPriceCentavos(line.expectedUnitPriceCentavos);
    if (!expected.ok) {
      throw new PolicyError(
        expected.code,
        expected.code === "price-not-confirmed"
          ? "This cart was built before prices were recorded. Please rebuild it from the catalog."
          : "A price on this order was not a valid amount. Please rebuild the cart from the catalog."
      );
    }

    return {
      inventoryId,
      quantity: qty.value,
      expectedUnitPriceCentavos: expected.value,
    };
  });

  return { items };
}

/**
 * Decide one batch against one requested line, inside the transaction.
 *
 * `data` is the inventory document's stored data; `inventoryId` is its Firestore
 * DOCUMENT id, passed separately and used verbatim. A stored field named `id`
 * is never consulted, so it cannot redirect the allocation.
 */
function evaluateBatch({ inventoryId, data, requested, expectedUnitPriceCentavos, now }) {
  if (!data) {
    throw new PolicyError("inventory-not-found", "That batch no longer exists.", {
      inventoryId,
    });
  }

  const onHand = readStockInteger(data.quantity);
  if (!onHand.ok) {
    throw new PolicyError(
      onHand.reason === "legacy-string"
        ? "inventory-migration-required"
        : "inventory-invalid-quantity",
      onHand.reason === "legacy-string"
        ? "This batch's stock figure is stored as text and needs an admin migration before it can be ordered."
        : "This batch's stock figure is not a valid number.",
      { inventoryId, batchId: data.batchId ?? null }
    );
  }

  const reserved = readReservedQuantity(data.reservedQuantity);
  if (!reserved.ok) {
    throw new PolicyError(
      "inventory-invalid-reserved",
      "This batch's reserved figure is not a valid number.",
      { inventoryId, batchId: data.batchId ?? null }
    );
  }

  if (!isUsableStatus(data.status)) {
    throw new PolicyError("batch-unavailable", "That batch is not available to order.", {
      inventoryId,
      batchId: data.batchId ?? null,
      status: typeof data.status === "string" ? data.status : null,
    });
  }

  const expiry = isoDateOnly(data.expiryDate);
  if (expiry === null || isExpired(expiry, now)) {
    throw new PolicyError("batch-expired", "That batch is expired and cannot be ordered.", {
      inventoryId,
      batchId: data.batchId ?? null,
      expiryDate: expiry,
    });
  }

  // ---- price: a property of the batch, then a contract with the cart ----
  //
  // Read BEFORE the stock arithmetic because an unpriced batch is unorderable
  // for the same kind of reason an expired one is, regardless of how much of it
  // is on the shelf.
  const price = readSellingPriceCentavos(data.sellingPriceCentavos);
  if (!price.ok) {
    throw new PolicyError(
      "batch-unpriced",
      price.reason === "missing"
        ? "This batch has no selling price yet. An admin must price it before it can be ordered."
        : "This batch's selling price is not a valid amount and needs admin review.",
      { inventoryId, batchId: data.batchId ?? null, reason: price.reason }
    );
  }

  // The one check that makes pricing tamper-evident in BOTH directions. A cart
  // that expected less than the batch now costs is refused just as firmly as
  // one that expected more: the rep is buying at a price they were not shown,
  // and only a human can decide whether that is still the order they want.
  if (expectedUnitPriceCentavos !== price.value) {
    throw new PolicyError(
      "price-changed",
      "The price of one of these batches changed while you were ordering. Please review the cart.",
      {
        inventoryId,
        batchId: data.batchId ?? null,
        expectedUnitPriceCentavos: expectedUnitPriceCentavos ?? null,
        currentUnitPriceCentavos: price.value,
      }
    );
  }

  // With no price ceiling, this multiplication is the first place a figure can
  // leave the exactly-representable range, so it is checked here rather than
  // being inferred safe from bounds that no longer exist.
  const lineTotalCentavos = requested * price.value;
  if (!Number.isSafeInteger(lineTotalCentavos)) {
    throw new PolicyError(
      "line-total-out-of-range",
      "This line's total is too large to record accurately.",
      { inventoryId, batchId: data.batchId ?? null }
    );
  }

  const available = onHand.value - reserved.value;
  if (available < 0) {
    // reservedQuantity > quantity is a broken invariant, not "no stock".
    throw new PolicyError(
      "inventory-invariant-broken",
      "This batch's reserved figure exceeds its stock and needs admin review.",
      { inventoryId, batchId: data.batchId ?? null }
    );
  }
  if (requested > available) {
    throw new PolicyError("insufficient-stock", "There is not enough stock in that batch.", {
      inventoryId,
      batchId: data.batchId ?? null,
      requested,
      available,
    });
  }

  return {
    inventoryId,
    // Snapshotted from the inventory document, never from caller text.
    batchId: stringOrNull(data.batchId),
    name: stringOrNull(data.vaccineName),
    chain: stringOrNull(data.vaccineType),
    manufacturer: stringOrNull(data.manufacturer),
    quantity: requested,
    // Money, snapshotted from the batch document at the instant of reservation
    // and never again derived. The line total is computed here, in integers, so
    // no consumer has to multiply two fields and hope it matches.
    unitPriceCentavos: price.value,
    lineTotalCentavos,
    nextReservedQuantity: reserved.value + requested,
    onHand: onHand.value,
    available,
  };
}

/**
 * Sum line totals into an order subtotal, in centavos.
 *
 * With no price ceiling this check is LOAD-BEARING, not defensive: nothing
 * upstream bounds the total any more, so an order genuinely large enough to
 * leave the exact-integer range is refused here rather than silently recorded
 * as a figure that is off by some amount nobody can see.
 */
function sumLineTotalsCentavos(lines) {
  const subtotal = lines.reduce((sum, line) => sum + line.lineTotalCentavos, 0);
  if (!Number.isSafeInteger(subtotal)) {
    throw new PolicyError(
      "order-total-out-of-range",
      "This order's total is too large to record accurately."
    );
  }
  return subtotal;
}

/**
 * Centavos as a peso number, for the invoice layer only.
 *
 * The invoice module and every existing invoice document speak decimal pesos.
 * Centavos remain the authoritative figure on the order; this is a derived
 * convenience carried alongside it so legacy readers keep working unchanged.
 */
function centavosToPesos(centavos) {
  return Math.round(centavos) / 100;
}

/**
 * Batch availability for ordering.
 *
 * Only the statuses Add Stock actually writes are accepted, and the check is
 * case-insensitive because staging holds hand-seeded "OK"/"Low". An unknown or
 * missing status is refused rather than assumed usable.
 */
const USABLE_STATUSES = Object.freeze(["ok", "low", "stable", "warning", "available"]);

function isUsableStatus(status) {
  if (typeof status !== "string") return false;
  return USABLE_STATUSES.includes(status.trim().toLowerCase());
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Settlement arithmetic, shared by release and consume.
 *
 * Both directions are floored at zero and checked, so a corrupt counter cannot
 * be driven negative by a settlement — the operation fails instead.
 */
function settleBatch({ inventoryId, data, quantity, mode }) {
  if (!data) {
    throw new PolicyError("inventory-not-found", "A batch on this order no longer exists.", {
      inventoryId,
    });
  }
  const reserved = readReservedQuantity(data.reservedQuantity);
  if (!reserved.ok || reserved.value < quantity) {
    throw new PolicyError(
      "inventory-invariant-broken",
      "This batch's reserved figure does not cover the order and needs admin review.",
      { inventoryId, reserved: reserved.ok ? reserved.value : null, quantity }
    );
  }
  const update = { reservedQuantity: reserved.value - quantity };

  if (mode === "consume") {
    const onHand = readStockInteger(data.quantity);
    if (!onHand.ok || onHand.value < quantity) {
      throw new PolicyError(
        "inventory-invariant-broken",
        "This batch's stock does not cover the delivery and needs admin review.",
        { inventoryId }
      );
    }
    update.quantity = onHand.value - quantity;
  }
  return update;
}

/**
 * Canonical fingerprint of a create request, for idempotency.
 *
 * Built from the SERVER-normalized allocation, not the raw payload, so cosmetic
 * differences (key order, an extra display field) cannot look like a different
 * order — and a genuinely different order (other batch, other quantity, other
 * clinic) cannot reuse a request id.
 */
function canonicalRequestFingerprint({ uid, clinicDocId, items }) {
  const canonical = JSON.stringify({
    uid,
    clinicDocId: clinicDocId ?? null,
    items: [...items]
      .map((i) => ({
        inventoryId: i.inventoryId,
        quantity: i.quantity,
        // The agreed price is part of what makes this request that request.
        // Two submissions of the same batches at different prices are two
        // different orders and must not share an idempotency key.
        expectedUnitPriceCentavos: i.expectedUnitPriceCentavos ?? null,
      }))
      .sort((a, b) => (a.inventoryId < b.inventoryId ? -1 : 1)),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/** A client-generated request id: 16-64 chars of url-safe randomness. */
function validateRequestId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(value)) {
    throw new PolicyError(
      "invalid-request-id",
      "The request could not be identified. Please try again."
    );
  }
  return value;
}

/** Shared reason validation — identical bounds to orderWorkflow.js. */
function validateReason(value, label = "reason") {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "") {
    throw new PolicyError("reason-required", `Please give a ${label}.`);
  }
  if (trimmed.length > MAX_REASON_LENGTH) {
    throw new PolicyError(
      "reason-too-long",
      `Please keep the ${label} under ${MAX_REASON_LENGTH} characters.`
    );
  }
  return trimmed;
}

/**
 * An order that predates server allocation.
 *
 * Detected ONLY by the absence of the version stamp — never by inspecting item
 * names, SKUs or batch strings. Such an order keeps its full delivery
 * lifecycle and causes no inventory movement in either direction.
 */
function isLegacyOrder(orderData) {
  return orderData?.allocationVersion !== ALLOCATION_VERSION;
}

/**
 * An order carrying a server-generated price snapshot.
 *
 * Detected ONLY by the version stamp, exactly as allocation is. An order
 * without it keeps the manual invoice-time pricing it has always had; nothing
 * back-fills a price onto it, because a made-up figure would misstate what a
 * clinic was actually charged.
 */
function hasServerPricing(orderData) {
  return orderData?.pricingVersion === PRICING_VERSION;
}

module.exports = {
  ALLOCATION_VERSION,
  PRICING_VERSION,
  PRICE_CURRENCY,
  PRICE_IS_VAT_INCLUSIVE,
  readSellingPriceCentavos,
  validateExpectedPriceCentavos,
  sumLineTotalsCentavos,
  centavosToPesos,
  hasServerPricing,
  RESERVATION_STATUSES,
  DELIVERABLE_FROM,
  CANCELLABLE_FROM,
  MAX_ORDER_LINES,
  MAX_LINE_QUANTITY,
  MAX_REASON_LENGTH,
  PolicyError,
  manilaDateString,
  isoDateOnly,
  isExpired,
  isUsableStatus,
  readStockInteger,
  readReservedQuantity,
  validateLineQuantity,
  validateCreatePayload,
  evaluateBatch,
  settleBatch,
  canonicalRequestFingerprint,
  validateRequestId,
  validateReason,
  isLegacyOrder,
};
