// Which proof and invoice photo links a web page may show.
//
// The rules accept any non-empty proofOfDeliveryUrl, so the link alone proves
// nothing: an assigned Rider could upload the real photo and file a different
// address. A link is shown only when it is the Firebase Storage download URL
// for THIS project's bucket and THIS order's canonical object — the same
// object the server requires before it completes a delivery
// (functions/src/deliveryEvidence.js). Anything else is reported as
// "unverified" and never rendered as an image or a link.
//
// Pure — the bucket is passed in — so it is unit-tested directly.

/** Must match canonicalProofPath()/canonicalInvoicePath() in firestore.rules. */
export const canonicalProofPath = (orderId) => `proof_of_delivery/${orderId}/proof.jpg`;
export const canonicalInvoicePath = (orderId) => `invoices/${orderId}/invoice.jpg`;

const STORAGE_HOST = "firebasestorage.googleapis.com";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * The URL when it addresses exactly `objectPath` in `bucket`, else "".
 * Local Storage emulator links (http, localhost) are accepted for development.
 */
export function storageObjectUrl(value, { bucket, objectPath }) {
  const raw = text(value);
  if (!raw || !text(bucket) || !text(objectPath)) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  const hosted = url.protocol === "https:" && url.hostname === STORAGE_HOST && url.port === "";
  const local = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  if (!hosted && !local) return "";
  if (url.username || url.password) return "";
  const expected = `/v0/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectPath)}`;
  if (url.pathname !== expected) return "";
  if (url.searchParams.get("alt") !== "media") return "";
  return url.href;
}

/**
 * What to show for one piece of evidence:
 *   { state: "verified", url }  the stored photo for this order
 *   { state: "unverified" }     something was recorded but it is not that photo
 *   { state: "none" }           nothing recorded
 */
function evidenceView(url, path, expectedPath, bucket) {
  if (!text(url)) return { state: "none", url: "" };
  if (path !== expectedPath) return { state: "unverified", url: "" };
  const verified = storageObjectUrl(url, { bucket, objectPath: expectedPath });
  return verified ? { state: "verified", url: verified } : { state: "unverified", url: "" };
}

export function proofPhotoView(order, bucket) {
  const id = text(order?.id);
  if (!id) return { state: text(order?.proofOfDeliveryUrl) ? "unverified" : "none", url: "" };
  return evidenceView(order?.proofOfDeliveryUrl, order?.proofOfDeliveryPath, canonicalProofPath(id), bucket);
}

export function invoicePhotoView(order, bucket) {
  const id = text(order?.id);
  if (!id) return { state: text(order?.invoiceUrl) ? "unverified" : "none", url: "" };
  return evidenceView(order?.invoiceUrl, order?.invoicePath, canonicalInvoicePath(id), bucket);
}
