// READ-ONLY: report the build state of every composite index in
// firestore.indexes.json on a project. GET requests only — no writes.
// Uses the Firebase CLI's existing login (firebase login), like firebase deploy.
//
//   node deploy/staging-inventory-rollout/check-index-readiness.cjs vaxtrack-staging
//
// Exit code 0 only when every index in the file exists and is READY.
const fs = require("fs");
const path = require("path");

const project = process.argv[2];
if (project !== "vaxtrack-staging") {
  console.error("usage: node check-index-readiness.cjs vaxtrack-staging");
  process.exit(2);
}
const npmRoot = require("child_process").execSync("npm root -g", { encoding: "utf8" }).trim();
const D = path.join(npmRoot, "firebase-tools", "lib");

const wanted = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "firestore.indexes.json"), "utf8")).indexes;
const sig = (collection, fields) =>
  `${collection}|${fields.map((f) => `${f.fieldPath}:${f.order || f.arrayConfig}`).join(",")}`;

(async () => {
  const auth = require(path.join(D, "auth"));
  const acct = auth.getGlobalDefaultAccount();
  await require(path.join(D, "requireAuth")).requireAuth({ project, nonInteractive: true, user: acct.user, tokens: acct.tokens });
  const { Client } = require(path.join(D, "apiv2"));
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
  for (const ix of wanted) {
    const state = live.get(sig(ix.collectionGroup, ix.fields)) ?? "MISSING";
    if (state !== "READY") ready = false;
    console.log(`${state.padEnd(9)} ${ix.collectionGroup} (${ix.fields.map((f) => `${f.fieldPath} ${f.order || f.arrayConfig}`).join(", ")})`);
  }
  const wantedSigs = new Set(wanted.map((ix) => sig(ix.collectionGroup, ix.fields)));
  const extra = [...live.keys()].filter((k) => !wantedSigs.has(k));
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
