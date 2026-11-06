// Proof and invoice photos are shown only when the recorded link is this
// order's own stored object (audit finding 6): the rules accept any non-empty
// link, so the link alone proves nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  canonicalInvoicePath,
  canonicalProofPath,
  invoicePhotoView,
  proofPhotoView,
  storageObjectUrl,
} from "../src/services/deliveryEvidenceView.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const BUCKET = "vaxtrack-staging.firebasestorage.app";
const ID = "IwBLnhfY6qUqwQ28Z2co";
const download = (path, { bucket = BUCKET, host = "https://firebasestorage.googleapis.com" } = {}) =>
  `${host}/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=abc-123`;
const order = (over = {}) => ({
  id: ID,
  proofOfDeliveryUrl: download(canonicalProofPath(ID)),
  proofOfDeliveryPath: canonicalProofPath(ID),
  invoiceUrl: download(canonicalInvoicePath(ID)),
  invoicePath: canonicalInvoicePath(ID),
  ...over,
});

test("the order's own stored photos are shown", () => {
  assert.deepEqual(proofPhotoView(order(), BUCKET), { state: "verified", url: download(canonicalProofPath(ID)) });
  assert.deepEqual(invoicePhotoView(order(), BUCKET), { state: "verified", url: download(canonicalInvoicePath(ID)) });
  // The local Storage emulator, for development.
  const local = download(canonicalProofPath(ID), { host: "http://127.0.0.1:9199" });
  assert.equal(proofPhotoView(order({ proofOfDeliveryUrl: local }), BUCKET).state, "verified");
});

test("any other link is unverified and never shown", () => {
  const other = "OTHERORDERID000000000";
  for (const [why, over] of [
    ["another host", { proofOfDeliveryUrl: "https://example.org/proof.jpg" }],
    ["another bucket", { proofOfDeliveryUrl: download(canonicalProofPath(ID), { bucket: "someone-else.appspot.com" }) }],
    ["another order's photo", { proofOfDeliveryUrl: download(canonicalProofPath(other)) }],
    ["a path that isn't this order's", { proofOfDeliveryPath: canonicalProofPath(other) }],
    ["no recorded path (the old manual-link fallback)", { proofOfDeliveryPath: undefined }],
    ["plain http off this machine", { proofOfDeliveryUrl: download(canonicalProofPath(ID), { host: "http://firebasestorage.googleapis.com" }) }],
    ["a script link", { proofOfDeliveryUrl: "javascript:alert(1)" }],
    ["not a URL", { proofOfDeliveryUrl: "proof.jpg" }],
  ]) {
    assert.deepEqual(proofPhotoView(order(over), BUCKET), { state: "unverified", url: "" }, why);
  }
  assert.equal(proofPhotoView(order(), "").state, "unverified", "no configured bucket verifies nothing");
  assert.equal(storageObjectUrl(download(canonicalProofPath(ID)).replace("alt=media", "alt=json"), { bucket: BUCKET, objectPath: canonicalProofPath(ID) }), "",
    "metadata responses are not the photo");
  assert.equal(invoicePhotoView(order({ invoiceUrl: "https://example.org/i.jpg" }), BUCKET).state, "unverified");
});

test("nothing recorded reads as no proof", () => {
  assert.deepEqual(proofPhotoView(order({ proofOfDeliveryUrl: "" }), BUCKET), { state: "none", url: "" });
  assert.deepEqual(invoicePhotoView(order({ invoiceUrl: undefined }), BUCKET), { state: "none", url: "" });
  assert.equal(proofPhotoView(null, BUCKET).state, "none");
});

test("the paths match the rules and the server", () => {
  const rules = read("firestore.rules");
  assert.match(rules, /function canonicalProofPath\(orderId\)\s*\{ return 'proof_of_delivery\/' \+ orderId \+ '\/proof\.jpg'; \}/);
  assert.match(rules, /function canonicalInvoicePath\(orderId\) \{ return 'invoices\/' \+ orderId \+ '\/invoice\.jpg'; \}/);
  assert.match(read("functions/src/deliveryEvidence.js"), /`proof_of_delivery\/\$\{orderId\}\/\$\{PROOF_FILE\}`/);
});

test("Admin Deliveries and Dispatcher Shipments render only verified links", () => {
  const admin = read("src/pages/admin/Deliveries.jsx");
  assert.match(admin, /proofPhoto: proofPhotoView\(raw, storageBucket\),/);
  assert.match(admin, /invoicePhoto: invoicePhotoView\(raw, storageBucket\),/);
  assert.doesNotMatch(admin, /(href|src)=\{delivery\.(proofOfDeliveryUrl|invoiceUrl)\}/);
  const shipments = read("src/pages/dispatcher/DispatcherShipments.jsx");
  assert.match(shipments, /const proof = proofPhotoView\(order, storageBucket\);/);
  assert.doesNotMatch(shipments, /viewableProofUrl|(href|src)=\{order\.proofOfDeliveryUrl\}/);
  assert.match(read("src/firebase.js"), /export const storageBucket = firebaseConfig\.storageBucket;/);
});

test("every CSP lets the stored photos load, and the Maps test page is gone", () => {
  const vite = read("vite.config.js");
  const netlify = read("../netlify.toml");
  for (const [name, src, count] of [["vite.config.js", vite, 2], ["netlify.toml", netlify, 1]]) {
    const imgSrc = [...src.matchAll(/img-src [^;"]*/g)].map((m) => m[0]);
    assert.equal(imgSrc.length, count, `${name} img-src count`);
    for (const d of imgSrc) {
      assert.ok(d.split(" ").includes("https://firebasestorage.googleapis.com"), `${name} img-src allows Storage`);
      assert.doesNotMatch(d, /\*\.googleapis\.com|\*\.gstatic\.com/, `${name} img-src has no wildcard hosts`);
    }
    // The Google Maps feasibility spike's temporary allowances are removed.
    assert.doesNotMatch(src, /maps\.googleapis\.com|maps\.gstatic\.com/, name);
  }
  const app = read("src/App.jsx");
  assert.doesNotMatch(app, /gmaps-feasibility|GoogleMapsFeasibility|VITE_GOOGLE_MAPS/);
});
