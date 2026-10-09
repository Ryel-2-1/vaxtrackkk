/**
 * OPTIONAL backfill: RECONSTRUCTED Order Confirmation Receipts for orders
 * placed before receipts existed. PREPARED, NOT RUN. Dry run by default.
 *
 * Orders without a receipt (e.g. staging Orders A and B) stay LEGACY unless
 * someone deliberately runs this with --apply. Nothing reconstructs them
 * automatically.
 *
 * What it writes — only with --apply and a matching --confirm — is clearly NOT
 * an original receipt: every document carries receiptKind "reconstructed",
 * isReconstructed true and the notes in orderHistory.buildReconstructedReceipt,
 * and the UI shows it under a "Reconstructed receipt" banner. It is built only
 * from the order's own server-written fields; fields that may have been edited
 * since placement are named as such. No allocation history is created.
 *
 *   # dry run (reads only): every order's plan, then the exact counts
 *   node scripts/backfillOrderReceipts.mjs --project vaxtrack-staging
 *   node scripts/backfillOrderReceipts.mjs --project vaxtrack-staging --order <orderDocId>[,<orderDocId>]
 *   # apply (create-only; an existing receipt — original or reconstructed — is never touched)
 *   node scripts/backfillOrderReceipts.mjs --project vaxtrack-staging --apply --confirm <N>
 *     where N is the exact "to create" count the dry run printed.
 *
 * Credentials: Application Default Credentials with Firestore access.
 *
 * Guards (parseOptions): a project is required; only vaxtrack-staging is
 * accepted outside the emulator, production (vaxtrack-bef1b) never, emulator
 * included; --apply requires --confirm. runBackfill prints the counts BEFORE
 * any write and refuses unless --confirm equals the to-create count. Each
 * receipt is created in its own transaction that re-reads it and uses
 * tx.create, so it can never replace a receipt. Deletes nothing.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const admin = require("firebase-admin");
const { RECEIPTS, buildReconstructedReceipt } = require("../src/orderHistory.js");

export const PRODUCTION_PROJECT = "vaxtrack-bef1b";
export const ALLOWED_PROJECT = "vaxtrack-staging";
const PAGE = 200;

/**
 * Command-line options, validated. Throws (refusing) on anything unsafe.
 * [emulator] is true only when FIRESTORE_EMULATOR_HOST is set.
 */
export function parseOptions(argv, { emulator = false } = {}) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const project = arg("--project");
  if (!project) throw new Error("Refusing: --project is required.");
  if (project === PRODUCTION_PROJECT) throw new Error("Refusing: production backfill is not approved.");
  if (!emulator && project !== ALLOWED_PROJECT) throw new Error(`Refusing: only --project ${ALLOWED_PROJECT} is allowed.`);
  const apply = argv.includes("--apply");
  const confirmRaw = arg("--confirm");
  if (apply && (confirmRaw === undefined || !/^\d+$/.test(confirmRaw))) {
    throw new Error("Refusing: --apply requires --confirm <N>, the dry run's to-create count.");
  }
  const orderIds = (arg("--order") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { project, apply, confirm: apply ? Number(confirmRaw) : null, orderIds };
}

/** What one order needs: { action: "create" | "skip", why? }. Pure. */
export function planFor(orderId, order, hasReceipt) {
  if (hasReceipt) return { orderId, action: "skip", why: "already has a receipt" };
  const receipt = buildReconstructedReceipt(orderId, order);
  if (!receipt) return { orderId, action: "skip", why: "no server price snapshot or owner to rebuild from" };
  return { orderId, orderNumber: receipt.orderNumber, action: "create", receipt };
}

async function* ordersToCheck(db, onlyIds) {
  if (onlyIds.length > 0) {
    for (const id of onlyIds) {
      const snap = await db.collection("orders").doc(id).get();
      yield { id, data: snap.exists ? snap.data() : null };
    }
    return;
  }
  let last = null;
  for (;;) {
    let q = db.collection("orders").orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    for (const d of snap.docs) yield { id: d.id, data: d.data() };
    if (snap.size < PAGE) return;
    last = snap.docs[snap.size - 1];
  }
}

/**
 * Plan, print the counts, then — only when [options.apply] and the confirmed
 * count matches — create the reconstructed receipts. Returns a summary.
 */
export async function runBackfill({ db, FieldValue, options, log = console.log }) {
  const plans = [];
  for await (const { id, data } of ordersToCheck(db, options.orderIds)) {
    if (!data) {
      plans.push({ orderId: id, action: "skip", why: "order not found" });
      continue;
    }
    const has = (await db.collection(RECEIPTS).doc(id).get()).exists;
    plans.push(planFor(id, data, has));
  }
  const creates = plans.filter((p) => p.action === "create");
  for (const p of plans) {
    log(JSON.stringify({ orderId: p.orderId, orderNumber: p.orderNumber ?? null, action: p.action, why: p.why ?? null }));
  }
  log(`PROPOSED: ${creates.length} reconstructed receipt(s) to create; ${plans.length - creates.length} skipped.`);

  if (!options.apply) {
    log("Dry run only — nothing was written.");
    return { applied: false, toCreate: creates.length, created: 0, skipped: plans.length - creates.length };
  }
  if (options.confirm !== creates.length) {
    throw new Error(`Refusing: --confirm ${options.confirm} does not match the ${creates.length} receipt(s) proposed. Nothing was written.`);
  }
  let created = 0;
  for (const p of creates) {
    const made = await db.runTransaction(async (tx) => {
      const ref = db.collection(RECEIPTS).doc(p.orderId);
      // Re-checked in the transaction: never over any receipt, real or rebuilt.
      if ((await tx.get(ref)).exists) return false;
      const orderSnap = await tx.get(db.collection("orders").doc(p.orderId));
      const rebuilt = orderSnap.exists ? buildReconstructedReceipt(p.orderId, orderSnap.data()) : null;
      if (!rebuilt) return false;
      tx.create(ref, { ...rebuilt, reconstructedAt: FieldValue.serverTimestamp(), createdAt: FieldValue.serverTimestamp() });
      return true;
    });
    if (made) created += 1;
    log(JSON.stringify({ orderId: p.orderId, created: made }));
  }
  log(`Applied: ${created} reconstructed receipt(s) created.`);
  return { applied: true, toCreate: creates.length, created, skipped: plans.length - creates.length };
}

async function main(argv) {
  const options = parseOptions(argv, { emulator: Boolean(process.env.FIRESTORE_EMULATOR_HOST) });
  const app = admin.initializeApp({ projectId: options.project }, "receipt-backfill");
  try {
    await runBackfill({ db: app.firestore(), FieldValue: admin.firestore.FieldValue, options });
  } finally {
    await app.delete();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
