"use strict";

/**
 * Migration PLANNER for legacy string quantities — preview only.
 *
 * This module is pure and has no write path of any kind: it imports no
 * Firestore client, holds no reference to a database, and returns a plan
 * object. There is no "apply" export and no flag that turns one on. Applying a
 * plan is a separate, deliberate checkpoint.
 *
 * Three staging batches hold `quantity` as text ("120", "35", "80"). Those are
 * unreservable by design — policy.js refuses them with
 * `inventory-migration-required` rather than coercing, so a migration cannot be
 * quietly skipped.
 */

/**
 * Accept ONLY a string that is unambiguously a canonical non-negative integer.
 *
 * Deliberately strict. `parseInt` would happily turn "12abc" into 12 and
 * " 1.9 " into 1; `Number` would turn "" and " " into 0 and "1e3" into 1000.
 * Every one of those would silently invent a stock figure, which is the one
 * outcome a stock migration must never produce. Leading zeros, signs,
 * whitespace, separators, exponents and decimals are all refused.
 */
function parseCanonicalInteger(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "not-a-string" };
  if (raw !== raw.trim()) return { ok: false, reason: "whitespace" };
  if (raw === "") return { ok: false, reason: "empty" };
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    // Name the common shapes so the report says WHY, not just "invalid".
    if (/^[+-]/.test(raw)) return { ok: false, reason: "signed" };
    if (raw.includes(".")) return { ok: false, reason: "decimal" };
    if (/^0[0-9]+$/.test(raw)) return { ok: false, reason: "leading-zero" };
    if (/[eE]/.test(raw)) return { ok: false, reason: "exponent" };
    return { ok: false, reason: "non-numeric" };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return { ok: false, reason: "overflow" };
  return { ok: true, value };
}

/**
 * Build a per-document proposal.
 *
 * `hasReservations` must be supplied by the caller from a real query of
 * `inventoryReservations`. `reservedQuantity: 0` is proposed ONLY when no
 * reservation references the batch — otherwise zeroing it would erase a live
 * reservation, so the batch is escalated to review instead.
 *
 * `vaccineId` is never proposed. Staging inventory has no such field and the
 * `vaccines` collection is empty; inventing a link is exactly the guessing this
 * policy forbids.
 */
function planDocument({ id, data, hasReservations }) {
  const base = { id, batchId: typeof data?.batchId === "string" ? data.batchId : null };

  if (typeof data?.quantity === "number") {
    return Number.isInteger(data.quantity) && data.quantity >= 0
      ? { ...base, action: "skip", reason: "already-integer", quantity: data.quantity }
      : { ...base, action: "review", reason: "non-integer-number", quantity: data.quantity };
  }

  const parsed = parseCanonicalInteger(data?.quantity);
  if (!parsed.ok) {
    return { ...base, action: "review", reason: parsed.reason, quantity: data?.quantity ?? null };
  }

  const proposal = {
    ...base,
    action: "convert",
    from: { quantity: data.quantity, type: "string" },
    to: { quantity: parsed.value, type: "number" },
  };

  if (data?.reservedQuantity === undefined || data?.reservedQuantity === null) {
    if (hasReservations) {
      // A batch with live reservations but no counter cannot be initialized to
      // zero — the correct value is unknown, and zero would understate it.
      return {
        ...base,
        action: "review",
        reason: "reservations-exist-without-counter",
        quantity: data.quantity,
      };
    }
    proposal.to.reservedQuantity = 0;
    proposal.reservedQuantityInitialized = true;
  } else if (!Number.isInteger(data.reservedQuantity) || data.reservedQuantity < 0) {
    return { ...base, action: "review", reason: "invalid-reserved-quantity", quantity: data.quantity };
  }

  return proposal;
}

/** The whole plan. Read-only in, read-only out — nothing here can write. */
function buildMigrationPlan(documents = []) {
  const proposals = documents.map(planDocument);
  return {
    mode: "preview",
    generatedFor: proposals.length,
    convert: proposals.filter((p) => p.action === "convert"),
    review: proposals.filter((p) => p.action === "review"),
    skip: proposals.filter((p) => p.action === "skip"),
    proposals,
  };
}

/** Human-readable preview. Explicitly states that nothing was written. */
function formatMigrationPlan(plan) {
  const lines = [
    "INVENTORY QUANTITY MIGRATION — PREVIEW ONLY, NOTHING WAS WRITTEN",
    `documents inspected: ${plan.generatedFor}`,
    `convert: ${plan.convert.length}   review: ${plan.review.length}   skip: ${plan.skip.length}`,
    "",
  ];
  for (const p of plan.convert) {
    const reserved = p.reservedQuantityInitialized ? ", reservedQuantity -> 0" : "";
    lines.push(
      `  CONVERT  ${p.id}  batch=${p.batchId ?? "-"}  quantity "${p.from.quantity}" -> ${p.to.quantity}${reserved}`
    );
  }
  for (const p of plan.review) {
    lines.push(`  REVIEW   ${p.id}  batch=${p.batchId ?? "-"}  reason=${p.reason}`);
  }
  for (const p of plan.skip) {
    lines.push(`  SKIP     ${p.id}  batch=${p.batchId ?? "-"}  reason=${p.reason}`);
  }
  return lines.join("\n");
}

module.exports = { parseCanonicalInteger, planDocument, buildMigrationPlan, formatMigrationPlan };
