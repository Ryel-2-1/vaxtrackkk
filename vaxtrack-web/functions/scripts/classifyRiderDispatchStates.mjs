/**
 * Rider trips — one-time classification of existing Riders.
 * PREPARED, NOT RUN against any real project. Dry run by default.
 *
 * Optional: the server classifies a Rider lazily — at their first assignment,
 * Finalize, return confirmation or order change — so nothing breaks without
 * this. Running it once after the Functions deploy only makes the Dispatcher
 * pages show every Rider's real trip state from the start.
 *
 * For each Rider (users where role == "rider") with NO riderDispatchStates
 * document, it reads their assigned orders and prints the classification the
 * server would make (riderDispatch.classifyFromOrders):
 *   any in_transit / delayed   → on_trip (never freed early; assigned/loading
 *                                orders are held for their next trip)
 *   only assigned / loading    → trip_forming
 *   none                       → available_at_hub
 *
 *   # dry run (reads only)
 *   node scripts/classifyRiderDispatchStates.mjs --project vaxtrack-staging
 *   # apply — only with the count the dry run printed
 *   node scripts/classifyRiderDispatchStates.mjs --project vaxtrack-staging --apply --confirm <N>
 *
 * Apply runs the SAME transaction the order-write trigger runs
 * (riderDispatchOps.reconcileRider), one Rider at a time: it re-reads the
 * Rider's orders inside the transaction, so an assignment made between the
 * dry run and the apply is honoured, and a Rider classified meanwhile is left
 * as it is. Writes only riderDispatchStates, riderTrips and each trip
 * member's `dispatchTripId`. Never changes an order's status, assignment,
 * stock or anything else.
 *
 * Guards: --project is required; production (vaxtrack-bef1b) is refused
 * always, emulator included; outside the emulator only vaxtrack-staging is
 * accepted; --apply requires --confirm equal to the planned Rider count.
 *
 * Credentials: Application Default Credentials, or FIRESTORE_EMULATOR_HOST.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const admin = require("firebase-admin");
const D = require("../src/riderDispatch.js");
const ops = require("../src/riderDispatchOps.js");

export const PRODUCTION_PROJECT = "vaxtrack-bef1b";
export const ALLOWED_PROJECT = "vaxtrack-staging";

/** Command-line options, validated. Throws (refusing) on anything unsafe. */
export function parseOptions(argv, { emulator = false } = {}) {
  const value = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  };
  const project = value("--project");
  if (!project) throw new Error("--project is required.");
  if (project === PRODUCTION_PROJECT) throw new Error("Production is refused.");
  if (!emulator && project !== ALLOWED_PROJECT) throw new Error(`Only ${ALLOWED_PROJECT} is accepted outside the emulator.`);
  const apply = argv.includes("--apply");
  const confirmRaw = value("--confirm");
  const confirm = confirmRaw === null ? null : Number(confirmRaw);
  if (apply && !(Number.isInteger(confirm) && confirm >= 0)) throw new Error("--apply requires --confirm <N> (the dry run's Rider count).");
  return { project, apply, confirm };
}

/** Riders without a trip state, and what the server would classify them as. Reads only. */
export async function planClassification(db) {
  const riders = await db.collection("users").where("role", "==", "rider").get();
  const plan = [];
  for (const r of riders.docs) {
    const state = await db.collection(D.RIDER_DISPATCH_STATES).doc(r.id).get();
    if (state.exists) continue;
    const orders = await db.collection("orders").where("assignedRiderId", "==", r.id).get();
    const c = D.classifyFromOrders(orders.docs.map((d) => ({ id: d.id, data: d.data() })));
    plan.push({ riderUid: r.id, accountStatus: r.data().status ?? null, ...c });
  }
  return plan;
}

/** Apply through the server's own transaction. Refuses unless `confirm` matches. */
export async function applyClassification(db, FieldValue, plan, confirm) {
  if (confirm !== plan.length) {
    throw new Error(`Refused: --confirm ${confirm} does not match the ${plan.length} Riders to classify. Run the dry run again.`);
  }
  const results = [];
  for (const p of plan) results.push(await ops.reconcileRider({ db, FieldValue, riderUid: p.riderUid }));
  return results;
}

async function main() {
  const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  const options = parseOptions(process.argv.slice(2), { emulator });
  admin.initializeApp({ projectId: options.project });
  const db = admin.firestore();
  const plan = await planClassification(db);
  const by = (state) => plan.filter((p) => p.state === state).length;
  console.log(`Project ${options.project}${emulator ? " (emulator)" : ""}: ${plan.length} Riders without a trip state.`);
  console.log(`  on_trip ${by(D.STATE.ON_TRIP)} · trip_forming ${by(D.STATE.FORMING)} · available_at_hub ${by(D.STATE.AVAILABLE)}`);
  for (const p of plan) {
    // Ids and counts only — no names, no addresses.
    console.log(`  ${p.riderUid}  ${p.state}  trip orders ${p.orderIds.length}  held ${p.heldOrderIds.length}`);
  }
  if (!options.apply) {
    console.log(`Dry run: nothing written. To apply: --apply --confirm ${plan.length}`);
    return;
  }
  const results = await applyClassification(db, admin.firestore.FieldValue, plan, options.confirm);
  console.log(`Applied: ${results.filter((r) => r.changed).length} classified, ${results.filter((r) => !r.changed).length} already up to date.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
