/**
 * Add Stock suggestions (2026-11-11): reuse what an earlier batch already
 * says, so a repeat delivery is quick to enter. Pure; no Firebase import.
 *
 * The earlier batch is the newest (by creation) of, in order:
 *   1. the same registered vaccine, else
 *   2. the same vaccine type AND manufacturer (case and spacing ignored).
 * A voided batch was entered by mistake and is never used.
 *
 * What it offers, and how:
 *   - price (VAT included): filled into an EMPTY field (labelled as such) — a
 *     price is a business setting the Admin confirms by keeping or changing it;
 *   - batch ID, expiry and arrival: SUGGESTIONS only, one click each. They
 *     must match the physical label/delivery, so nothing is assumed.
 * The vial quantity is not suggested: a batch keeps only what is left, not
 * what it started with.
 */

import { legacyVatOnTopCentavos } from "./pricingConfig.js";

const norm = (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").toUpperCase() : "");
const createdMs = (b) => b?.createdAt?.toMillis?.() ?? (typeof b?.createdAt?.seconds === "number" ? b.createdAt.seconds * 1000 : 0);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** The earlier batch to learn from, and how it matches; null when there is none. */
export function suggestionSource(batches, vaccine, manufacturer = "") {
  if (!vaccine) return null;
  const usable = (Array.isArray(batches) ? batches : []).filter((b) => b && b.voided !== true);
  const newest = (list) => [...list].sort((a, b) => createdMs(b) - createdMs(a))[0] ?? null;
  const same = newest(usable.filter((b) => b.vaccineId === vaccine.id));
  if (same) return { batch: same, match: "same_vaccine" };
  const type = norm(vaccine.vaccineType);
  const maker = norm(manufacturer || vaccine.manufacturer);
  if (!type || !maker) return null;
  const similar = newest(usable.filter((b) => norm(b.vaccineType) === type && norm(b.manufacturer) === maker));
  return similar ? { batch: similar, match: "same_type_manufacturer" } : null;
}

/** The next ID in a numbered series ("26URAAB025" → "26URAAB026"), or null. */
export function nextBatchId(batchId) {
  const id = typeof batchId === "string" ? batchId.trim().toUpperCase() : "";
  const m = id.match(/^(.*?)(\d+)$/);
  if (!m) return null;
  const next = String(Number(m[2]) + 1);
  if (!Number.isSafeInteger(Number(m[2]))) return null;
  return `${m[1]}${next.padStart(m[2].length, "0")}`;
}

/** Shelf life between two 'YYYY-MM-DD' dates: whole months when the day matches, else days. */
export function shelfLife(manufacturingDate, expiryDate) {
  if (!ISO.test(manufacturingDate ?? "") || !ISO.test(expiryDate ?? "")) return null;
  const [y1, m1, d1] = manufacturingDate.split("-").map(Number);
  const [y2, m2, d2] = expiryDate.split("-").map(Number);
  if (d1 === d2) {
    const months = (y2 - y1) * 12 + (m2 - m1);
    return months > 0 ? { months } : null;
  }
  const days = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
  return days > 0 ? { days } : null;
}

/** manufacturingDate + shelf life, as 'YYYY-MM-DD' (month ends clamp: Jan 31 + 1 month → Feb 28/29). */
export function addShelfLife(manufacturingDate, life) {
  if (!ISO.test(manufacturingDate ?? "") || !life) return null;
  const [y, m, d] = manufacturingDate.split("-").map(Number);
  if (life.months) {
    const total = m - 1 + life.months;
    const ty = y + Math.floor(total / 12);
    const tm = total % 12;
    const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
    return new Date(Date.UTC(ty, tm, Math.min(d, last))).toISOString().slice(0, 10);
  }
  return new Date(Date.UTC(y, m - 1, d) + life.days * 86400000).toISOString().slice(0, 10);
}

export function shelfLifeLabel(life) {
  if (!life) return "";
  if (life.months) {
    if (life.months % 12 === 0) return `${life.months / 12} ${life.months === 12 ? "year" : "years"}`;
    return `${life.months} ${life.months === 1 ? "month" : "months"}`;
  }
  return `${life.days} ${life.days === 1 ? "day" : "days"}`;
}

/** The price as the form's text field holds it ("1000.00"), or "" when unusable. */
export function priceText(centavos) {
  return Number.isSafeInteger(centavos) && centavos > 0 ? (centavos / 100).toFixed(2) : "";
}

/**
 * The batch's price as a VAT-inclusive amount, which is how every price is
 * now entered (2026-11-11). An older batch saved "before VAT" is a VATable
 * price with 12% added on top when sold, so its suggestion is that charged
 * amount (₱1,000.00 before VAT → ₱1,120.00). A VAT-exempt or zero-rated
 * product has no VAT to add. A missing basis gives no suggestion.
 */
export function vatInclusivePriceCentavos(batch, productVatClassification) {
  const c = batch?.sellingPriceCentavos;
  if (!Number.isSafeInteger(c) || c <= 0) return null;
  if (batch.priceIsVatInclusive === true) return c;
  if (batch.priceIsVatInclusive !== false) return null;
  return productVatClassification === "vatable" ? c + legacyVatOnTopCentavos(c) : c;
}

/**
 * Everything Add Stock can offer for this vaccine, or null.
 * { sourceBatchId, sourceAddedMs, match, price, priceConverted, nextBatchId, shelfLife }
 */
export function stockSuggestions({ batches, vaccine, manufacturer }) {
  const source = suggestionSource(batches, vaccine, manufacturer);
  if (!source) return null;
  const b = source.batch;
  return {
    sourceBatchId: typeof b.batchId === "string" ? b.batchId : "",
    sourceAddedMs: createdMs(b) || null,
    match: source.match,
    price: priceText(vatInclusivePriceCentavos(b, vaccine.vatClassification)),
    /** The earlier batch was entered before VAT; the suggestion adds it. */
    priceConverted: b.priceIsVatInclusive === false && vaccine.vatClassification === "vatable",
    nextBatchId: nextBatchId(b.batchId),
    shelfLife: shelfLife(b.manufacturingDate, b.expiryDate),
  };
}
