import { MAX_LINE_QUANTITY } from "./backorder.js";

/** Classify a typed batch quantity without silently clamping or changing it. */
export function assessRequestQuantity(raw, available, alreadyInCart = 0) {
  const text = String(raw ?? "").trim();
  const quantity = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(quantity) || quantity < 1) {
    return { kind: "invalid", quantity: null, message: "Enter a whole number of at least 1 vial." };
  }
  if (quantity + alreadyInCart > MAX_LINE_QUANTITY) {
    return { kind: "invalid", quantity: null, message: `A batch line cannot exceed ${MAX_LINE_QUANTITY.toLocaleString()} vials.` };
  }
  const remaining = Math.max(0, (Number.isInteger(available) ? available : 0) - alreadyInCart);
  if (quantity > remaining) {
    return {
      kind: "future",
      quantity,
      message: remaining === 0
        ? "No vials available now. Choose Add future."
        : `Only ${remaining.toLocaleString()} more ${remaining === 1 ? "vial is" : "vials are"} available now. Choose Add future.`,
    };
  }
  return { kind: "immediate", quantity, message: "" };
}
