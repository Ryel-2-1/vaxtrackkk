/**
 * Internal inventory SKU format (2026-11-11).
 *
 * 3MGS's own catalog codes are uppercase letters and digits with no fixed
 * shape: RAB0000IP01, HEP0P00SA01, SHING00001, ATS00000JI01 (mostly 10–11
 * characters). The earlier rule demanded an invented VXT-123-ABCDE pattern and
 * refused every real code. Now: 4–20 uppercase letters or digits; a hyphen is
 * allowed between them, so SKUs already saved in that older style (staging
 * test data) stay valid. Entry is upper-cased before it is checked and saved.
 */
export const INTERNAL_SKU_PATTERN = /^[A-Z0-9](?:[A-Z0-9-]{2,18})[A-Z0-9]$/;
export const INTERNAL_SKU_EXAMPLE = "RAB0000IP01";
export const INTERNAL_SKU_FORMAT_MESSAGE =
  "Use 4 to 20 capital letters and numbers, like RAB0000IP01. A hyphen may separate them.";

/** The SKU as it is stored: trimmed and upper-cased. */
export function normalizeInternalSku(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export function isValidInternalSku(value) {
  const sku = normalizeInternalSku(value);
  return INTERNAL_SKU_PATTERN.test(sku) && !sku.includes("--");
}
