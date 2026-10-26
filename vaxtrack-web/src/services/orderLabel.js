/**
 * How an order is NAMED in user-facing sentences — notifications, toasts,
 * confirmations and alert text. Pure; no Firebase.
 *
 * The order number (VT-ORD-…) is the reference people use. A Firestore
 * document id is never a reference: it means nothing to a reader, and an
 * order without a number (rare legacy data) is named by what else is known
 * about it instead — its destination — or simply "this order".
 */

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The order number, else `fallback` — never the document id. */
export function orderReference(order, fallback = "this order") {
  return text(order?.orderNumber) ?? fallback;
}

/** "Order VT-ORD-…" when the order has a number, else `fallback` (used where the destination is said separately). */
export function orderNumberPhrase(order, fallback = "This order") {
  const number = text(order?.orderNumber);
  return number ? `Order ${number}` : fallback;
}

/** Where the order goes: the clinic, else the destination's name, else null. */
export function orderDestination(order) {
  return text(order?.clinicName) ?? text(order?.destinationName) ?? null;
}

/**
 * "Order VT-ORD-… " when the order has a number; otherwise a description that
 * still identifies it for the reader ("the order for Clinic X"), else
 * "this order". Meant to start or sit inside a sentence.
 */
export function orderPhrase(order) {
  const number = text(order?.orderNumber);
  if (number) return `Order ${number}`;
  const destination = orderDestination(order);
  return destination ? `the order for ${destination}` : "this order";
}

/** orderPhrase with a capital first letter, for the start of a sentence. */
export function capitalizedOrderPhrase(order) {
  const phrase = orderPhrase(order);
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}
