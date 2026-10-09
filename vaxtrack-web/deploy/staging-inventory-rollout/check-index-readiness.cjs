// READ-ONLY: report the build state of every composite index the staging
// release needs. GET requests only — no writes. Uses the Firebase CLI's
// existing login (firebase login), like firebase deploy.
//
//   # live check (repeat until it prints ALL READY and exits 0)
//   node deploy/staging-inventory-rollout/check-index-readiness.cjs vaxtrack-staging
//   # offline: only verify firestore.indexes.json still declares every required index
//   node deploy/staging-inventory-rollout/check-index-readiness.cjs --check-file
//
// REQUIRED below pins the indexes this release depends on — the RC2 inventory
// allocation indexes AND the RC3 order-history indexes — so an index silently
// dropped from firestore.indexes.json fails here instead of failing a query
// after deploy. Every index in the file is also checked live.
//
// Exit code 0 only when every required index is declared, and (live) every
// declared index exists and is READY.
const fs = require("fs");
const path = require("path");

const A = (fieldPath) => ({ fieldPath, order: "ASCENDING" });
const D = (fieldPath) => ({ fieldPath, order: "DESCENDING" });
const C = (fieldPath) => ({ fieldPath, arrayConfig: "CONTAINS" });

const REQUIRED = [
  // RC2 — inventory allocation (backorder queue, FEFO batches, provenance, returns)
  { release: "inventory", collectionGroup: "orders", fields: [C("backorderedProductKeys"), A("allocationOpen"), A("allocationPriorityKey")] },
  { release: "inventory", collectionGroup: "inventory", fields: [A("vaccineId"), A("expiryDate")] },
  { release: "inventory", collectionGroup: "orders", fields: [A("allocationOpen"), A("allocationState"), A("allocationPriorityKey")] },
  { release: "inventory", collectionGroup: "inventoryReservations", fields: [C("inventoryIds"), A("status")] },
  { release: "inventory", collectionGroup: "inventoryReturns", fields: [C("inventoryIds"), A("status")] },
  { release: "inventory", collectionGroup: "inventoryReturns", fields: [A("status"), A("reportedAt")] },
  // RC3 — order receipt + stock allocation history
  { release: "history", collectionGroup: "orders", fields: [A("createdByUid"), D("createdAt")] },
  { release: "history", collectionGroup: "inventoryAllocationEvents", fields: [A("orderId"), A("createdAt")] },
  { release: "history", collectionGroup: "inventoryAllocationEvents", fields: [A("medRepUid"), A("orderId"), A("createdAt")] },
  { release: "history", collectionGroup: "inventoryAllocationEvents", fields: [C("batchIds"), D("createdAt")] },
  { release: "history", collectionGroup: "orderReceipts", fields: [C("skus"), D("createdAt")] },
];

const sig = (collection, fields) =>
  `${collection}|${fields.map((f) => `${f.fieldPath}:${f.order || f.arrayConfig}`).join(",")}`;
const describe = (ix) => `${ix.collectionGroup} (${ix.fields.map((f) => `${f.fieldPath} ${f.order || f.arrayConfig}`).join(", ")})`;

/** Required indexes missing from firestore.indexes.json (empty when all declared). */
function missingFromFile(declared) {
  const have = new Set(declared.map((ix) => sig(ix.collectionGroup, ix.fields)));
  return REQUIRED.filter((ix) => !have.has(sig(ix.collectionGroup, ix.fields)));
}

module.exports = { REQUIRED, sig, missingFromFile };

if (require.main === module) {
  const declared = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "firestore.indexes.json"), "utf8")).indexes;
  const missing = missingFromFile(declared);
  if (missing.length) {
    console.error("firestore.indexes.json is missing required index(es):");
    for (const ix of missing) console.error(`  ${ix.release}: ${describe(ix)}`);
    process.exit(1);
  }
  const counts = REQUIRED.reduce((m, ix) => ({ ...m, [ix.release]: (m[ix.release] ?? 0) + 1 }), {});
  console.log(`firestore.indexes.json declares all ${REQUIRED.length} required indexes (inventory ${counts.inventory}, history ${counts.history}); ${declared.length} declared in total.`);

  const project = process.argv[2];
  if (project === "--check-file") process.exit(0);
  if (project !== "vaxtrack-staging") {
    console.error("usage: node check-index-readiness.cjs vaxtrack-staging | --check-file");
    process.exit(2);
  }
  const npmRoot = require("child_process").execSync("npm root -g", { encoding: "utf8" }).trim();
  const CLI = path.join(npmRoot, "firebase-tools", "lib");
  const releaseOf = new Map(REQUIRED.map((ix) => [sig(ix.collectionGroup, ix.fields), ix.release]));

  (async () => {
    const auth = require(path.join(CLI, "auth"));
    const acct = auth.getGlobalDefaultAccount();
    await require(path.join(CLI, "requireAuth")).requireAuth({ project, nonInteractive: true, user: acct.user, tokens: acct.tokens });
    const { Client } = require(path.join(CLI, "apiv2"));
    const c = new Client({ urlPrefix: "https://firestore.googleapis.com", apiVersion: "v1" });
    const live = new Map();
    let pageToken;
    do {
      const q = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : "";
      const body = (await c.get(`/projects/${project}/databases/(default)/collectionGroups/-/indexes${q}`)).body;
      for (const ix of body.indexes ?? []) {
        const collection = ix.name.split("/collectionGroups/")[1].split("/")[0];
        const fields = (ix.fields ?? [])
          .filter((f) => f.fieldPath !== "__name__")
          .map((f) => ({ fieldPath: f.fieldPath, order: f.order, arrayConfig: f.arrayConfig }));
        live.set(sig(collection, fields), ix.state);
      }
      pageToken = body.nextPageToken;
    } while (pageToken);

    let ready = true;
    for (const ix of declared) {
      const key = sig(ix.collectionGroup, ix.fields);
      const state = live.get(key) ?? "MISSING";
      if (state !== "READY") ready = false;
      console.log(`${state.padEnd(9)} ${(releaseOf.get(key) ?? "other").padEnd(9)} ${describe(ix)}`);
    }
    const declaredSigs = new Set(declared.map((ix) => sig(ix.collectionGroup, ix.fields)));
    const extra = [...live.keys()].filter((k) => !declaredSigs.has(k));
    if (extra.length) {
      console.log(`${extra.length} live index(es) NOT in firestore.indexes.json — answer "No" if firebase deploy offers to delete them:`);
      for (const k of extra) console.log(`  ${k}`);
    }
    console.log(ready ? "ALL READY" : "NOT READY — do not deploy Functions yet");
    process.exit(ready ? 0 : 1);
  })().catch((e) => {
    console.error("check failed:", e.message);
    process.exit(1);
  });
}
