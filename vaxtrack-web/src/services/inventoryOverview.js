import { MAX_STOCK_QUANTITY } from "./orderEligibility.js";

const DATED_LEVELS = new Set(["stable", "warning", "critical"]);

function validCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Count vaccine products by recorded stock state, without summing doses. */
export function buildVaccineAvailabilitySummary(batches) {
  const products = new Map();

  for (const batch of batches || []) {
    if (batch.voided) continue;
    const name = batch.name && batch.name !== "—" ? batch.name : "Unnamed vaccine";
    const type = batch.type && batch.type !== "—" ? batch.type : "Type not recorded";
    const key = batch.vaccineId || `${name}\u0000${type}`;
    if (!products.has(key)) products.set(key, { key, name, type, stocked: false, review: false, availableDoses: 0, reasons: new Set() });
    const product = products.get(key);

    const countersValid = validCounter(batch.onHandValue) &&
      batch.onHandValue <= MAX_STOCK_QUANTITY &&
      validCounter(batch.reservedValue) &&
      validCounter(batch.availableValue) &&
      batch.availableValue <= batch.onHandValue;
    if (!countersValid || !DATED_LEVELS.has(batch.level)) {
      product.review = true;
      if (batch.onHandValue > MAX_STOCK_QUANTITY) product.reasons.add("Quantity above allowed limit");
      else if (!countersValid) product.reasons.add("Invalid stock figures");
      if (batch.level === "expired") product.reasons.add("Expired batch");
      else if (!DATED_LEVELS.has(batch.level)) product.reasons.add("Expiry date needs review");
    } else if (batch.availableValue > 0) {
      const nextTotal = product.availableDoses + batch.availableValue;
      if (Number.isSafeInteger(nextTotal)) {
        product.stocked = true;
        product.availableDoses = nextTotal;
      } else {
        product.review = true;
      }
    }
  }

  const summary = {
    total: products.size, stocked: 0, empty: 0, review: 0,
    availableProducts: [], emptyProducts: [], reviewProducts: [],
  };
  for (const product of products.values()) {
    if (product.review) {
      summary.review += 1;
      summary.reviewProducts.push({
        key: product.key, name: product.name, type: product.type,
        reasons: [...product.reasons], availableDoses: product.availableDoses,
      });
    } else if (product.stocked) {
      summary.stocked += 1;
      summary.availableProducts.push({
        key: product.key,
        name: product.name,
        type: product.type,
        availableDoses: product.availableDoses,
      });
    } else {
      summary.empty += 1;
      summary.emptyProducts.push({ key: product.key, name: product.name, type: product.type });
    }
  }
  for (const list of [summary.availableProducts, summary.emptyProducts, summary.reviewProducts]) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return summary;
}
