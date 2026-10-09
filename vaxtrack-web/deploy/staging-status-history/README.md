# Isolated staging deployment — order status history + completion attribution

**Target: `vaxtrack-staging` only. NOT deployed yet.** Prepared 2026-10-05.
This folder is a self-contained Firebase project directory. Its own
`.firebaserc` knows only `vaxtrack-staging` (no `default`, so a command without
`--project` fails instead of reaching production `vaxtrack-bef1b`).

## What it contains — and nothing else

| Piece | Source | Change vs. what staging runs today |
|---|---|---|
| `firestore.rules` | The ruleset **currently released on staging** (`deployed-staging-baseline.rules`, read from the Rules API on 2026-10-05; released 2026-09-24, identical to commit `b02da0a` apart from CRLF line endings) | **+11 lines:** the read-only `orders/{orderId}/statusEvents` block, copied verbatim from source `firestore.rules`, inserted right after `destinationCorrections` (its position in source). No other rule changes. |
| `functions/` | `git archive HEAD functions` (the committed tree — no Delivery Calendar, no VAT stash) | **Attribution patch only:** `index.js` passes the caller's verified token email into callables; `markOrderDeliveredWithInventoryConsumption` writes `statusUpdatedByEmail` with `statusUpdatedByUid`. Every other file is byte-identical to `HEAD`. |
| `firebase.json` | New | Firestore **rules** + **functions** only. No indexes, Storage, Hosting. |

Functions actually deployed (selected with `--only`; the other seven callables
are not touched):

* `recordOrderStatusEvent` — **new** on staging (Firestore `onDocumentWritten`
  trigger, `asia-southeast1`). Writes `orders/{id}/statusEvents` and stamps
  `firstDispatchedAt` once.
* `markOrderDeliveredWithInventoryConsumption` — **redeployed** with the
  attribution patch. Its delivery logic and every helper it uses
  (`loadUser`, `requireRole`, `settleBatch`, `isLegacyOrder`,
  `readReservedQuantity`, `readStockInteger`, `DELIVERABLE_FROM`,
  `ALLOCATION_VERSION`) are byte-identical between the source staging was
  deployed from (2026-09-23, `470f2b6`/`dbf6687`) and `HEAD`. The shared
  `callable()` wrapper now passes `enforceAppCheck: ENFORCE_APP_CHECK`, which
  is `false` while `ENFORCE_APP_CHECK` is unset — the same as today.

Explicitly **excluded**: Delivery Calendar rules and `rescheduleOrderDelivery`,
VAT changes, Storage rules, every other Firestore-rule change since 2026-09-24,
production configuration.

## How `firestore.rules` was derived (reproducible)

1. Read the released staging ruleset (read-only Rules API) →
   `deployed-staging-baseline.rules`.
2. Take the `statusEvents` block (comment + `match`) verbatim from the source
   `firestore.rules`.
3. Insert it immediately after the `destinationCorrections` block inside
   `match /orders/{orderId}`; keep the baseline's CRLF line endings.

Diff (`deployed-staging-baseline.rules` → `firestore.rules`):

```diff
@@ -1100,6 +1100,17 @@
             && get(/databases/$(database)/documents/orders/$(orderId)).data.createdByUid == request.auth.uid);
         allow write: if false;
       }
+      // Status history, written only by the recordOrderStatusEvent trigger
+      // through the Admin SDK. Readable by whoever can read the order itself;
+      // no client can add, edit or erase an entry.
+      match /statusEvents/{eventId} {
+        allow read: if isAdmin() || isDispatcher()
+          || (isSalesRep()
+            && get(/databases/$(database)/documents/orders/$(orderId)).data.createdByUid == request.auth.uid)
+          || (isRider()
+            && get(/databases/$(database)/documents/orders/$(orderId)).data.assignedRiderId == request.auth.uid);
+        allow write: if false;
+      }
       // Admin + Dispatcher see all orders. Sales Rep sees only orders they
       // created; Rider sees only orders assigned to them.
       allow get: if isAdmin() || isDispatcher()
```

Emulator proof of isolation: the full rules suite run against the baseline and
against this file differs in exactly `HIST1`, `HIST5`, `HIST6`, `HIST9` (fail →
pass). Nothing that passes on the baseline fails here.

## Proposed commands (do not run until approved)

Run from an **interactive** terminal (the first Firestore-trigger deploy may
ask to grant Eventarc/Pub/Sub service-agent roles; a non-interactive run can
skip such prompts silently):

```bash
cd vaxtrack-web/deploy/staging-status-history/functions
npm ci
cd ..
firebase deploy --only firestore:rules --project vaxtrack-staging --dry-run
firebase deploy --only firestore:rules --project vaxtrack-staging
firebase deploy --only "functions:recordOrderStatusEvent,functions:markOrderDeliveredWithInventoryConsumption" --project vaxtrack-staging
```

## Rollback

* Rules: Firebase Console → Firestore → Rules → History → restore the
  2026-09-24 ruleset; or copy `deployed-staging-baseline.rules` over
  `firestore.rules` here and rerun the rules deploy.
* Trigger: `firebase functions:delete recordOrderStatusEvent --region asia-southeast1 --project vaxtrack-staging`
  (already-written events remain; they are read-only history).
* Callable: redeploy it from this folder after reverting the two-file patch
  (`git show HEAD:vaxtrack-web/functions/index.js` / `.../src/operations.js`).

## Update 2026-10-05 — completion requires recorded evidence (NOT deployed)

The rules, `recordOrderStatusEvent` and the attribution fix above **were deployed
to staging on 2026-10-05 (08:45–08:46 UTC)**. A second, smaller change has since
been added to this folder for "Submit Proof & Complete Delivery":

* `functions/src/deliveryEvidence.js` (new) and two small edits —
  `src/operations.js` calls it in `markOrderDeliveredWithInventoryConsumption`
  after the already-delivered replay; `index.js` maps `proof-missing`,
  `invoice-missing`, `evidence-not-yours` to `failed-precondition`.
* Completion now requires BOTH photos RECORDED on the order (`…SubmittedAt`,
  URL, canonical path, recipient for proof) by the completing rider. A Storage
  file or a legacy bare URL is not enough.
* Rules: unchanged (no rules deploy needed for this step).

Only one function needs redeploying for it:

```bash
firebase deploy --only "functions:markOrderDeliveredWithInventoryConsumption" --project vaxtrack-staging
```

Deploy it together with (or after) installing the new Rider build: an older
Rider build that completes WITHOUT recording both photos would be refused by
the updated callable.

## Update 2026-10-05 (b) — assign and cancel attribution (NOT deployed)

* **Cancel:** `cancelOrderWithInventoryRelease` now writes
  `statusUpdatedByEmail` (the caller's token email, or deletes a stale one)
  with the uid — the shared helper `functions/src/attribution.js`, also used by
  completion. Before, cancelling after a rider's delay report left the RIDER's
  email as "Updated by".
* **Assign:** the web `assignRiderToOrder` (and failed-order recovery) now
  write the full status attribution — `statusUpdatedAt`, `statusUpdatedByUid`,
  `statusUpdatedByEmail` — so the Assigned history event has an actor.
* **Rule:** `isValidRiderAssignment()` additionally requires
  `statusAuditIsServerStamped()` (server time + the caller's own uid), as
  failed-order recovery and every other transition already do. +3 lines in
  `firestore.rules`; no other rule changes. Emulator: against the deployed
  baseline the bundle fixes HIST1/5/6/9 and Nassign-audit, regresses nothing.

**Order matters — web first, rules last.** Today's staging rules already allow
the three fields, so the NEW web build assigns fine under the CURRENT rules; but
an OLD web build (no status audit on assign) would be refused by the NEW rule.

```bash
# 1. publish the new web build to staging (your usual staging hosting step)
# 2. functions (from this folder, functions/ already npm-ci'd):
firebase deploy --only "functions:markOrderDeliveredWithInventoryConsumption,functions:cancelOrderWithInventoryRelease" --project vaxtrack-staging
# 3. rules, once every open dispatcher tab has the new build:
firebase deploy --only firestore:rules --project vaxtrack-staging
```

## Historical behaviour — no backfill

* Status history starts when `recordOrderStatusEvent` is deployed. **Earlier
  transitions are not reconstructed.**
* The order already delivered in the physical test has **no status events**,
  and its `statusUpdatedByEmail` **keeps the stale dispatcher value**; neither
  changes unless a separate, approved backfill is created. None is included
  here, and none should be run for this task.

## Verification after deployment (new staging order only)

1. Med Rep places a new order; Dispatcher assigns a rider, loads it in Cargo
   Loading and finalizes dispatch.
2. Rider completes it in the app.
3. Admin → Deliveries → drawer: **Activity "Updated by" = the rider's email**;
   "Last status update" = the completion time; **Status history** lists the
   transitions (no "could not be loaded").
4. Dispatcher session: the same order's status history loads (no
   `permission-denied`).
5. Firebase Console (read-only): `orders/{id}/statusEvents` — the `in_transit`
   event's `actorUid` = dispatcher, the `delivered` event's `actorUid` = rider.
