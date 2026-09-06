// VaxTrack Cloud Storage security rules — local emulator tests.
//
// Run via:  npm run test:storage-rules
// which is: firebase emulators:exec --only firestore,storage "node tests/storage.rules.test.js"
//
// BOTH emulators are required: the Storage rules cross-check the caller's
// users/{uid} document and the referenced orders/{orderId} document through
// `firestore.get`, so the Firestore emulator has to be running and seeded or
// every rule would fail for the wrong reason.
//
// Same shape as tests/firestore.rules.test.js — a self-contained node script
// with assertSucceeds/assertFails, no test framework. Exits non-zero on any
// failure. NOT a deploy, and it never touches a real bucket.
//
// This file runs under Node, not the browser, so `process` and `Buffer` are
// legitimate globals here; the shared ESLint config targets browser source.
/* global process, Buffer */

import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";

const PROJECT_ID = "demo-vaxtrack-storage";
const FIRESTORE_PORT = Number(process.env.FIRESTORE_EMULATOR_PORT || 8181);
const STORAGE_PORT = Number(process.env.STORAGE_EMULATOR_PORT || 9199);

const adminUid = "admin1";
const dispatcherUid = "disp1";
const salesRepUid = "sr1";
const otherSalesRepUid = "sr2";
const riderUid = "rider1";
const otherRiderUid = "rider2";
const pendingRiderUid = "pendingRider1";
const disabledRiderUid = "disabledRider1";
const rejectedRiderUid = "rejectedRider1";
const disabledSalesRepUid = "disabledSr1";

// The orders under test. ORDER_A belongs to rider1 and was raised by sr1.
const ORDER_A = "orderA";
const ORDER_B = "orderB"; // assigned to rider2, raised by sr2
const ORDER_C = "orderC"; // assigned to rider1, raised by a NOW-DISABLED sales rep
// Orders whose assignedRiderId IS an unapproved rider, so the only thing that
// can refuse those riders is their standing.
const ORDER_PENDING_RIDER = "orderPendingRider";
const ORDER_DISABLED_RIDER = "orderDisabledRider";
const ORDER_REJECTED_RIDER = "orderRejectedRider";
// Reassigned mid-test to prove access follows the CURRENT assignment.
const ORDER_REASSIGN = "orderReassign";
const MISSING_ORDER = "orderDoesNotExist";

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed += 1;
    failures.push(`${name} -> ${e.message}`);
    console.log(`  FAIL  ${name}`);
  }
}

/** A small valid-looking JPEG payload. Content type is what the rules gate on. */
const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const imageMeta = { contentType: "image/jpeg" };

/** Exactly at the 10 MB boundary — the rule is `< 10MB`, so this must fail. */
const TEN_MB = 10 * 1024 * 1024;
const atLimitBytes = new Uint8Array(TEN_MB);
const overLimitBytes = new Uint8Array(TEN_MB + 1);

const proofPath = (orderId, file = "proof.jpg") => `proof_of_delivery/${orderId}/${file}`;
const invoicePath = (orderId, file = "invoice.jpg") => `invoices/${orderId}/${file}`;

async function main() {
  const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync("firestore.rules", "utf8"),
      host: "127.0.0.1",
      port: FIRESTORE_PORT,
    },
    storage: {
      rules: readFileSync("storage.rules", "utf8"),
      host: "127.0.0.1",
      port: STORAGE_PORT,
    },
  });

  await testEnv.clearStorage();
  await testEnv.clearFirestore();

  // ---- seed Firestore with rules disabled ----
  // These are the documents the Storage rules read back through firestore.get.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const set = (path, data) => db.doc(path).set(data);

    await set(`users/${adminUid}`, { role: "admin", status: "approved" });
    await set(`users/${dispatcherUid}`, { role: "dispatcher", status: "approved" });
    await set(`users/${salesRepUid}`, { role: "salesrep", status: "approved" });
    await set(`users/${otherSalesRepUid}`, { role: "salesrep", status: "approved" });
    await set(`users/${riderUid}`, {
      role: "rider", status: "approved", employeeId: "EMP-4432", fullName: "QA Rider",
    });
    await set(`users/${otherRiderUid}`, { role: "rider", status: "approved" });
    await set(`users/${pendingRiderUid}`, { role: "rider", status: "pending" });
    await set(`users/${disabledRiderUid}`, { role: "rider", status: "disabled" });
    await set(`users/${rejectedRiderUid}`, { role: "rider", status: "rejected" });
    await set(`users/${disabledSalesRepUid}`, { role: "salesrep", status: "disabled" });

    await set(`orders/${ORDER_A}`, {
      status: "in_transit", assignedRiderId: riderUid, createdByUid: salesRepUid,
    });
    await set(`orders/${ORDER_B}`, {
      status: "in_transit", assignedRiderId: otherRiderUid, createdByUid: otherSalesRepUid,
    });
    // Raised by a sales rep who has SINCE been disabled. This is the only way
    // to probe whether read access follows current standing or merely
    // authorship — a different-uid disabled account would be refused by the
    // createdByUid check regardless of status, and would prove nothing.
    await set(`orders/${ORDER_C}`, {
      status: "in_transit", assignedRiderId: riderUid, createdByUid: disabledSalesRepUid,
    });
    // Each is assigned to an unapproved rider, so the assignment half of the
    // read clause matches and only their standing can refuse them.
    await set(`orders/${ORDER_PENDING_RIDER}`, {
      status: "in_transit", assignedRiderId: pendingRiderUid, createdByUid: salesRepUid,
    });
    await set(`orders/${ORDER_DISABLED_RIDER}`, {
      status: "in_transit", assignedRiderId: disabledRiderUid, createdByUid: salesRepUid,
    });
    await set(`orders/${ORDER_REJECTED_RIDER}`, {
      status: "in_transit", assignedRiderId: rejectedRiderUid, createdByUid: salesRepUid,
    });
    // Starts with rider1; reassigned to rider2 inside NS20.
    await set(`orders/${ORDER_REASSIGN}`, {
      status: "in_transit", assignedRiderId: riderUid, createdByUid: salesRepUid,
    });
  });

  const ctxFor = (uid) =>
    uid === null ? testEnv.unauthenticatedContext() : testEnv.authenticatedContext(uid);
  const fileFor = (uid, path) => ctxFor(uid).storage().ref(path);

  /** Seed an object with rules disabled, so read/delete can be tested. */
  async function seedObject(path) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.storage().ref(path).put(Buffer.from(imageBytes), imageMeta);
    });
  }

  console.log("\n--- Storage rules: unauthenticated ---");

  await check("NS1 unauthenticated cannot upload proof or invoice", async () => {
    await assertFails(fileFor(null, proofPath(ORDER_A)).put(Buffer.from(imageBytes), imageMeta));
    await assertFails(fileFor(null, invoicePath(ORDER_A)).put(Buffer.from(imageBytes), imageMeta));
  });

  await check("NS2 unauthenticated cannot read an existing object", async () => {
    await seedObject(proofPath(ORDER_A));
    await assertFails(fileFor(null, proofPath(ORDER_A)).getDownloadURL());
  });

  await check("NS3 unauthenticated cannot delete or overwrite", async () => {
    await assertFails(fileFor(null, proofPath(ORDER_A)).delete());
    await assertFails(fileFor(null, proofPath(ORDER_A)).put(Buffer.from(imageBytes), imageMeta));
  });

  console.log("\n--- Storage rules: upload authorization ---");

  await check("PS1 the assigned approved rider uploads proof and invoice", async () => {
    await assertSucceeds(
      fileFor(riderUid, proofPath(ORDER_A, "ok1.jpg")).put(Buffer.from(imageBytes), imageMeta)
    );
    await assertSucceeds(
      fileFor(riderUid, invoicePath(ORDER_A, "ok1.jpg")).put(Buffer.from(imageBytes), imageMeta)
    );
  });

  // The exact ImageUploadService sequence, end to end.
  //
  // It does `putFile(...)` then `getDownloadURL()` on the SAME ref and returns
  // the URL for proof_screen to write to Firestore. Under the pre-fix rules the
  // first call succeeded and the second was denied — the object was stored with
  // no URL recorded anywhere and the rider could not finish the proof step.
  // This case is the regression guard for that: asserting only the upload would
  // have kept passing throughout the defect.
  await check("PS6 assigned rider completes upload -> getDownloadURL for proof", async () => {
    const ref = fileFor(riderUid, proofPath(ORDER_A, "seq.jpg"));
    await assertSucceeds(ref.put(Buffer.from(imageBytes), imageMeta));
    await assertSucceeds(ref.getDownloadURL());
  });

  await check("PS7 assigned rider completes upload -> getDownloadURL for invoice", async () => {
    const ref = fileFor(riderUid, invoicePath(ORDER_A, "seq.jpg"));
    await assertSucceeds(ref.put(Buffer.from(imageBytes), imageMeta));
    await assertSucceeds(ref.getDownloadURL());
  });

  await check("NS4 a rider assigned to a DIFFERENT order is rejected", async () => {
    // rider1 is assigned to ORDER_A, not ORDER_B.
    await assertFails(
      fileFor(riderUid, proofPath(ORDER_B)).put(Buffer.from(imageBytes), imageMeta)
    );
    await assertFails(
      fileFor(otherRiderUid, proofPath(ORDER_A)).put(Buffer.from(imageBytes), imageMeta)
    );
  });

  await check("NS5 pending, disabled and rejected riders are rejected", async () => {
    for (const uid of [pendingRiderUid, disabledRiderUid, rejectedRiderUid]) {
      await assertFails(fileFor(uid, proofPath(ORDER_A)).put(Buffer.from(imageBytes), imageMeta));
    }
  });

  await check("NS6 non-rider roles cannot upload, even approved ones", async () => {
    for (const uid of [adminUid, dispatcherUid, salesRepUid]) {
      await assertFails(fileFor(uid, proofPath(ORDER_A)).put(Buffer.from(imageBytes), imageMeta));
      await assertFails(fileFor(uid, invoicePath(ORDER_A)).put(Buffer.from(imageBytes), imageMeta));
    }
  });

  await check("NS7 an employee id or display name is not an identity", async () => {
    // rider1's employeeId is EMP-4432 and their name is "QA Rider"; neither is a
    // uid, so neither resolves to a users document and both are refused.
    for (const fake of ["EMP-4432", "QA Rider", riderUid.slice(0, 4)]) {
      await assertFails(fileFor(fake, proofPath(ORDER_A)).put(Buffer.from(imageBytes), imageMeta));
    }
  });

  await check("NS8 the referenced order must exist", async () => {
    await assertFails(
      fileFor(riderUid, proofPath(MISSING_ORDER)).put(Buffer.from(imageBytes), imageMeta)
    );
    await assertFails(
      fileFor(riderUid, invoicePath(MISSING_ORDER)).put(Buffer.from(imageBytes), imageMeta)
    );
  });

  console.log("\n--- Storage rules: path and content constraints ---");

  await check("NS9 uploads outside the proof/invoice paths are rejected", async () => {
    for (const path of [
      "random/file.jpg",
      `proof_of_delivery/${ORDER_A}`,               // missing {fileName} segment
      `proof_of_delivery/${ORDER_A}/nested/deep.jpg`, // deeper than the rule
      `invoices/${ORDER_A}/nested/deep.jpg`,
      "proof_of_delivery_extra/x/y.jpg",
      `users/${riderUid}/avatar.jpg`,
    ]) {
      await assertFails(fileFor(riderUid, path).put(Buffer.from(imageBytes), imageMeta));
    }
  });

  await check("NS10 non-image content is rejected", async () => {
    for (const contentType of ["application/pdf", "text/plain", "application/octet-stream"]) {
      await assertFails(
        fileFor(riderUid, proofPath(ORDER_A, "bad.bin")).put(Buffer.from(imageBytes), { contentType })
      );
    }
  });

  await check("NS11 a file AT the 10MB limit is rejected", async () => {
    // The rule is `size < 10 * 1024 * 1024`, so exactly 10MB must fail.
    await assertFails(
      fileFor(riderUid, proofPath(ORDER_A, "atlimit.jpg")).put(Buffer.from(atLimitBytes), imageMeta)
    );
  });

  await check("NS12 a file ABOVE the 10MB limit is rejected", async () => {
    await assertFails(
      fileFor(riderUid, proofPath(ORDER_A, "over.jpg")).put(Buffer.from(overLimitBytes), imageMeta)
    );
  });

  await check("PS2 a file safely below the limit is accepted", async () => {
    const underLimit = new Uint8Array(1024 * 1024); // 1 MB
    await assertSucceeds(
      fileFor(riderUid, proofPath(ORDER_A, "under.jpg")).put(Buffer.from(underLimit), imageMeta)
    );
  });

  console.log("\n--- Storage rules: read access ---");

  await check("PS3 admin and dispatcher can read proof and invoice", async () => {
    await seedObject(proofPath(ORDER_A, "read.jpg"));
    await seedObject(invoicePath(ORDER_A, "read.jpg"));
    for (const uid of [adminUid, dispatcherUid]) {
      await assertSucceeds(fileFor(uid, proofPath(ORDER_A, "read.jpg")).getDownloadURL());
      await assertSucceeds(fileFor(uid, invoicePath(ORDER_A, "read.jpg")).getDownloadURL());
    }
  });

  await check("PS4 the sales rep who raised the order can read it", async () => {
    await assertSucceeds(fileFor(salesRepUid, proofPath(ORDER_A, "read.jpg")).getDownloadURL());
    await assertSucceeds(fileFor(salesRepUid, invoicePath(ORDER_A, "read.jpg")).getDownloadURL());
  });

  await check("NS13 an unrelated sales rep cannot read another rep's order", async () => {
    await assertFails(fileFor(otherSalesRepUid, proofPath(ORDER_A, "read.jpg")).getDownloadURL());
  });

  await check("NS14 a DISABLED sales rep cannot read the order THEY raised", async () => {
    // ORDER_C's createdByUid IS this disabled account, so the authorship half
    // of the read clause matches. The only thing that can refuse this is the
    // account's current standing — which is exactly what is under test.
    await seedObject(proofPath(ORDER_C, "read.jpg"));
    await assertFails(
      fileFor(disabledSalesRepUid, proofPath(ORDER_C, "read.jpg")).getDownloadURL()
    );
  });

  await check("PS8 the ASSIGNED rider can read their own order's evidence", async () => {
    await assertSucceeds(fileFor(riderUid, proofPath(ORDER_A, "read.jpg")).getDownloadURL());
    await assertSucceeds(fileFor(riderUid, invoicePath(ORDER_A, "read.jpg")).getDownloadURL());
  });

  await check("NS15 an UNRELATED rider still cannot read another order's evidence", async () => {
    // The grant is scoped to the order the rider is assigned to, nothing wider.
    await assertFails(fileFor(otherRiderUid, proofPath(ORDER_A, "read.jpg")).getDownloadURL());
    await assertFails(fileFor(otherRiderUid, invoicePath(ORDER_A, "read.jpg")).getDownloadURL());
  });

  await check("NS19 an unapproved assigned rider cannot read", async () => {
    // Seeded so the ONLY thing refusing them is their standing: each of these
    // accounts IS the assignedRiderId on its own order.
    for (const [orderId, uid] of [
      [ORDER_PENDING_RIDER, pendingRiderUid],
      [ORDER_DISABLED_RIDER, disabledRiderUid],
      [ORDER_REJECTED_RIDER, rejectedRiderUid],
    ]) {
      await seedObject(proofPath(orderId, "read.jpg"));
      await assertFails(fileFor(uid, proofPath(orderId, "read.jpg")).getDownloadURL());
    }
  });

  await check("NS20 a PREVIOUS rider loses read access once the order is reassigned", async () => {
    await seedObject(proofPath(ORDER_REASSIGN, "read.jpg"));
    // rider1 holds it first and can read.
    await assertSucceeds(fileFor(riderUid, proofPath(ORDER_REASSIGN, "read.jpg")).getDownloadURL());

    // The dispatcher reassigns it to rider2 (seeded directly, as the Firestore
    // lifecycle is not under test here).
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`orders/${ORDER_REASSIGN}`).set(
        { assignedRiderId: otherRiderUid }, { merge: true }
      );
    });

    // The rule reads assignedRiderId live, so access flips on the next request.
    await assertFails(fileFor(riderUid, proofPath(ORDER_REASSIGN, "read.jpg")).getDownloadURL());
    await assertSucceeds(
      fileFor(otherRiderUid, proofPath(ORDER_REASSIGN, "read.jpg")).getDownloadURL()
    );
  });

  await check("NS21 an employee id, name, email or uid fragment cannot read", async () => {
    await seedObject(proofPath(ORDER_A, "read.jpg"));
    for (const fake of ["EMP-4432", "QA Rider", "rider@vaxtrack.com", riderUid.slice(0, 4)]) {
      await assertFails(fileFor(fake, proofPath(ORDER_A, "read.jpg")).getDownloadURL());
    }
  });

  console.log("\n--- Storage rules: delete and overwrite ---");

  await check("NS16 nobody may delete a stored file", async () => {
    await seedObject(proofPath(ORDER_A, "del.jpg"));
    for (const uid of [riderUid, adminUid, dispatcherUid, salesRepUid, null]) {
      await assertFails(fileFor(uid, proofPath(ORDER_A, "del.jpg")).delete());
    }
  });

  await check("PS5 the assigned rider MAY overwrite their own valid upload", async () => {
    // `allow write` covers create AND update, so a re-upload to the same path
    // succeeds when every other condition holds. Recorded as the real contract.
    await assertSucceeds(
      fileFor(riderUid, proofPath(ORDER_A, "del.jpg")).put(Buffer.from(imageBytes), imageMeta)
    );
  });

  await check("NS17 an unauthorized overwrite of an existing file is rejected", async () => {
    await assertFails(
      fileFor(otherRiderUid, proofPath(ORDER_A, "del.jpg")).put(Buffer.from(imageBytes), imageMeta)
    );
    await assertFails(
      fileFor(adminUid, proofPath(ORDER_A, "del.jpg")).put(Buffer.from(imageBytes), imageMeta)
    );
  });

  console.log("\n--- Storage rules: catch-all ---");

  await check("NS18 everything not explicitly allowed stays denied", async () => {
    await seedObject("misc/secret.jpg");
    for (const uid of [adminUid, dispatcherUid, riderUid, salesRepUid, null]) {
      await assertFails(fileFor(uid, "misc/secret.jpg").getDownloadURL());
      await assertFails(fileFor(uid, "misc/secret.jpg").put(Buffer.from(imageBytes), imageMeta));
      await assertFails(fileFor(uid, "misc/secret.jpg").delete());
    }
  });

  await testEnv.cleanup();

  console.log(`\n==== STORAGE RULES RESULT: ${passed} passed, ${failed} failed ====`);
  if (failed > 0) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("Storage rules test harness error:", e);
  process.exit(1);
});
