// Safe, reusable Core Sample Data seeder for VaxTrack STAGING.
//
//   node scripts/seedStagingCoreData.mjs            # DRY RUN (no writes)
//   node scripts/seedStagingCoreData.mjs --apply    # writes, IF confirmed
//
// Safety model (see the task spec):
//  * refuses any Firebase project except exactly `vaxtrack-staging`;
//  * config is loaded from .env.staging (Vite loadEnv) — never hardcoded;
//  * authenticates as an existing approved staging ADMIN via env vars
//    VAXTRACK_SEED_EMAIL / VAXTRACK_SEED_PASSWORD (never printed/stored);
//  * dry-run is the default; --apply ALSO requires
//    VAXTRACK_SEED_CONFIRM === "vaxtrack-staging";
//  * deterministic ids (vtseed-core-20260924-…); never overwrites, updates,
//    merges, or deletes an existing document;
//  * aborts the apply if any business identifier already exists under a
//    different document id.
//
// It uses ONLY the Firebase client SDK already in the project (no Admin SDK, no
// service account) and touches ONLY the six core master-data collections.

import { loadEnv } from "vite";
import { initializeApp, deleteApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword, signOut } from "firebase/auth";
import {
  initializeFirestore,
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  query,
  where,
  serverTimestamp,
} from "firebase/firestore";
import {
  buildSeedPlan,
  validateSeedPlan,
  STAGE_ORDER,
} from "./stagingCoreSeedData.mjs";

const REQUIRED_PROJECT_ID = "vaxtrack-staging";
const APPLY = process.argv.includes("--apply");

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

// ------------------------------------------------------------------ config

function loadFirebaseConfig() {
  const env = loadEnv("staging", process.cwd(), "VITE_");
  const cfg = {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  };
  const missing = Object.entries(cfg)
    .filter(([, v]) => !v)
    .map(([k]) => `VITE_FIREBASE_${k.replace(/([A-Z])/g, "_$1").toUpperCase()}`);
  if (missing.length) {
    fail(
      "Missing Firebase config in .env.staging. Set these KEYS (values not shown): " +
        "VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_PROJECT_ID, " +
        "VITE_FIREBASE_STORAGE_BUCKET, VITE_FIREBASE_MESSAGING_SENDER_ID, VITE_FIREBASE_APP_ID."
    );
  }
  return cfg;
}

// ------------------------------------------------------------- collision scan

/**
 * Classify one top-level record: SKIP EXISTING, BLOCKED (business id used under
 * another doc id), or CREATE. Reads only.
 */
async function classifyTopLevel(db, record) {
  const ref = doc(db, record.collection, record.id);
  const existing = await getDoc(ref);

  const queries = record.collisionQueries || (record.collisionQuery ? [record.collisionQuery] : []);
  for (const q of queries) {
    const snap = await getDocs(query(collection(db, record.collection), where(q.field, "==", q.value)));
    const otherIds = snap.docs.map((d) => d.id).filter((id) => id !== record.id);
    if (otherIds.length > 0) {
      return {
        action: "BLOCKED",
        reason: `${q.field}="${q.value}" already exists under id(s): ${otherIds.join(", ")}`,
      };
    }
  }
  return { action: existing.exists() ? "SKIP EXISTING" : "CREATE" };
}

/** Classify a nested record (home / clinic link) by existence only. */
async function classifyNested(db, record) {
  const ref = doc(db, ...record.path);
  const existing = await getDoc(ref);
  return { action: existing.exists() ? "SKIP EXISTING" : "CREATE" };
}

// ------------------------------------------------------------------- writing

function withTimestamps(record) {
  const data = { ...record.data };
  for (const field of record.serverTimestampFields || []) {
    data[field] = serverTimestamp();
  }
  return data;
}

async function writeStage(db, records) {
  let created = 0;
  for (const r of records) {
    if (r._action !== "CREATE") continue;
    const ref = r.path ? doc(db, ...r.path) : doc(db, r.collection, r.id);
    await setDoc(ref, withTimestamps(r)); // setDoc without merge; never overwrites (CREATE only)
    created += 1;
  }
  return created;
}

// -------------------------------------------------------------------- report

function idOf(r) {
  return r.path ? r.path.join("/") : r.id;
}

function printRecordLine(r) {
  const biz = r.businessKey ? `${r.businessKey.label}=${r.businessKey.value}` : "";
  const reason = r._reason ? `  (${r._reason})` : "";
  console.log(`  [${r._action.padEnd(13)}] ${r.collection}/${idOf(r)}  ${biz}${reason}`);
}

// ---------------------------------------------------------------------- main

async function main() {
  const cfg = loadFirebaseConfig();

  // HARD project guard — before anything connects.
  if (cfg.projectId !== REQUIRED_PROJECT_ID) {
    fail(
      `Refusing to run: configured project is "${cfg.projectId}", ` +
        `but this seeder only runs against "${REQUIRED_PROJECT_ID}".`
    );
  }

  const email = process.env.VAXTRACK_SEED_EMAIL;
  const password = process.env.VAXTRACK_SEED_PASSWORD;
  if (!email || !password) {
    fail(
      "Set VAXTRACK_SEED_EMAIL and VAXTRACK_SEED_PASSWORD (an approved staging " +
        "admin) in your environment. They are never printed or stored."
    );
  }

  const app = initializeApp(cfg);
  const auth = getAuth(app);
  // Force HTTP long-polling: the Firebase JS SDK's default Firestore transport
  // (WebChannel/gRPC-web) frequently fails under Node with "client is offline"
  // even when Auth connects fine. Long-polling is the reliable Node transport.
  const db = initializeFirestore(app, { experimentalForceLongPolling: true });

  console.log(`\nVaxTrack staging Core Sample Data seeder`);
  console.log(`Project:    ${cfg.projectId}`);
  console.log(`Mode:       ${APPLY ? "APPLY (writes if confirmed)" : "DRY RUN (no writes)"}`);

  let cred;
  try {
    cred = await signInWithEmailAndPassword(auth, email, password);
  } catch {
    // Release Firebase's open handles before exiting, so Node doesn't abort with
    // a libuv assertion on Windows when process.exit races an in-flight handle.
    await deleteApp(app).catch(() => {});
    fail("Sign-in failed. Check VAXTRACK_SEED_EMAIL / VAXTRACK_SEED_PASSWORD.");
  }
  const uid = cred.user.uid;
  console.log(`Signed in:  ${cred.user.email}`); // email only, never the password

  // Admin authorization gate — read the caller's own user document.
  const userSnap = await getDoc(doc(db, "users", uid));
  const role = userSnap.exists() ? userSnap.data().role : null;
  const status = userSnap.exists() ? userSnap.data().status : null;
  if (role !== "admin" || status !== "approved") {
    await signOut(auth).catch(() => {});
    fail(`Account is not an approved admin (role=${role}, status=${status}). Aborting.`);
  }
  console.log(`Authorized: role=${role}, status=${status}\n`);

  // Build + internally validate the plan before any collision read.
  const plan = buildSeedPlan();
  const planCheck = validateSeedPlan(plan);
  if (!planCheck.ok) {
    await signOut(auth).catch(() => {});
    fail(`Seed plan is internally invalid:\n  - ${planCheck.errors.join("\n  - ")}`);
  }

  // Classify every record against live Firestore (reads only).
  const stages = STAGE_ORDER.map((key) => ({ key, records: plan[key] }));
  const totals = {};
  let blocked = 0;

  for (const { key, records } of stages) {
    console.log(`── ${key} (${records.length}) ──`);
    for (const r of records) {
      const result = r.path
        ? await classifyNested(db, r)
        : await classifyTopLevel(db, r);
      r._action = result.action;
      r._reason = result.reason || "";
      if (r._action === "BLOCKED") blocked += 1;
      totals[key] = totals[key] || { CREATE: 0, "SKIP EXISTING": 0, BLOCKED: 0 };
      totals[key][r._action] += 1;
      printRecordLine(r);
    }
    console.log("");
  }

  console.log("── summary ──");
  for (const { key } of stages) {
    const t = totals[key];
    console.log(
      `  ${key.padEnd(22)} CREATE ${t.CREATE}  SKIP ${t["SKIP EXISTING"]}  BLOCKED ${t.BLOCKED}`
    );
  }
  if (blocked > 0) {
    console.log(`\n⚠ ${blocked} record(s) BLOCKED — a business identifier already exists under a different id.`);
  }

  // -------- apply gate --------
  if (!APPLY) {
    await signOut(auth).catch(() => {});
    console.log("\nDRY RUN — no Firebase documents were written.\n");
    return;
  }

  if (process.env.VAXTRACK_SEED_CONFIRM !== REQUIRED_PROJECT_ID) {
    await signOut(auth).catch(() => {});
    fail(
      `--apply requires VAXTRACK_SEED_CONFIRM="${REQUIRED_PROJECT_ID}". Nothing was written.`
    );
  }
  if (blocked > 0) {
    await signOut(auth).catch(() => {});
    fail("Refusing to apply while collisions are BLOCKED. Resolve them first. Nothing was written.");
  }

  console.log("\nApplying (create-only, in dependency order)…");
  let totalCreated = 0;
  for (const { key, records } of stages) {
    try {
      const created = await writeStage(db, records);
      totalCreated += created;
      console.log(`  ${key}: created ${created}`);
    } catch (err) {
      await signOut(auth).catch(() => {});
      fail(`Stage "${key}" failed after ${totalCreated} total writes: ${err?.code || err?.message || err}. Stopped; no retry.`);
    }
  }
  await signOut(auth).catch(() => {});
  console.log(`\nDone. Created ${totalCreated} new document(s). Existing documents were left untouched.\n`);
}

main().catch((err) => {
  fail(err?.message || String(err));
});
