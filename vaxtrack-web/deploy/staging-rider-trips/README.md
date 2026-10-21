# Staging rollout — Rider trips (Part B): server-owned assignment, Finalize Dispatch, return to hub

**Target: `vaxtrack-staging` only. PREPARED, NOT DEPLOYED.** Prepared 2026-10-19,
preflight re-checked and runbook corrected 2026-10-21.

**Status:** the Netlify publication blocker is cleared — the site owner confirmed on
2026-10-21 that staging is **locked against auto publishing** and still publishes
`main@acc2f55` (keep it locked). Still required before running anything: approval
to push `fix/rider-navigation-session-lifecycle` and merge it into `main` (option A
below), and the deployment approval itself. Everything else in this runbook has
been checked read-only.

**The Part B commit** below means the reviewed head of
`fix/rider-navigation-session-lifecycle`: `75866e6` plus the stale trip-state fix
(2026-10-21, see "Stale trip state") and this runbook. Run every command from
`vaxtrack-web/` of a **clean checkout of the Part B commit** (or of the `main`
merge commit whose second parent is it — see below), never from
the inventory branch `feat/admin-inventory-removal-controls` (`4f540ae`), whose
functions, rules and web would ship the inventory release too. Every Firebase
command names `--project vaxtrack-staging` explicitly (`.firebaserc`'s default is
production).

## What this release ships

| Layer | Exactly |
|---|---|
| Functions | `assignRiderToOrder`, `finalizeRiderDispatch`, `confirmRiderReturnToHub`, `recheckRiderTripStates` (callables) and `reconcileRiderDispatchOnOrderWrite` (Firestore trigger on `orders/{orderId}`). Nothing else. |
| Rules | `firestore.rules` at the Part B commit (see "Rules delta"). |
| Web | the `vaxtrack-web` tree at the Part B commit (Netlify `npm run build:staging`). |

### Code the five functions run

A deploy uploads the whole `functions/` tree; each named function loads
`index.js` (which requires every module) and runs `riderDispatchOps.js` +
`riderDispatch.js`, which import:

| Module | Last changed | Used for |
|---|---|---|
| `policy.js` | `f8abad1` (delivery hardening, 2026-10-18) | `PolicyError`, `hasLoadingAudit` — Finalize stamps a missing loading audit on a legacy order as it leaves (never overwrites one); `isoDateOnly` |
| `orderRouteFields.js` | `8495a03` | route-field clean-up on assignment |
| `attribution.js` | `baaf34d` | status-updated-by email |

So the Part B functions carry `f8abad1`-era `policy.js`. Nothing of Part A's
timing (`deliveryTiming*.js`) is on their path, and no other live function is
replaced, so the Part A / delivery-hardening changes inside
`operations.js`, `inventoryWorkflow.js`, `failureReturn.js` and `orderHistory.js`
are **not** activated by this release (they stay as deployed 6–14 Oct).

**Not created or changed:** `evaluateDeliveryTiming` and `purgeRiderTrackingData`
(scheduled jobs in the source but not live) and every other function. firebase-tools
15.17.0 matches `--only functions:<name>` by whole name chunks
(`endpointMatchesAnyFilter`), so the five-name list below cannot create them.
Never run `firebase deploy --only functions` without a list.

### Stale trip state (fixed 2026-10-21, before any rollout)

`riderDispatchStates` is written by a trigger that can miss, fail or reorder
events. Reproduced on `75866e6` in the emulator, a stale document alone
authorized unsafe decisions:

| Stored state | Truth (orders) | `75866e6` |
|---|---|---|
| `available_at_hub` | an order `in_transit` with the Rider | assignment **accepted**; the trigger also left it "unchanged" |
| `on_trip` | every trip order finished | assignment refused, return confirmation refused — Rider stuck |
| `trip_forming` | another order `in_transit` | Finalize **accepted**; the later return confirmation **freed the Rider** with that order still out |
| `returning_to_hub` | an order `in_transit` | return confirmation **freed the Rider** |

The fix (`riderDispatch.reconcile`, `riderDispatchOps.js`):

- Every decision re-derives the Rider's state from **every order assigned to
  them**, inside the transaction that acts on it; the stored document is only
  trusted where the orders agree with it. Any order `in_transit`/`delayed` keeps
  the Rider `on_trip`; a finished trip leaves them `returning_to_hub` — never
  `available_at_hub`; only `confirmRiderReturnToHub` frees them.
- The server trip is verified: a stored trip id with no `riderTrips` document, or
  one belonging to another Rider, is not trusted (on the road → `on_trip` on a new
  trip; otherwise `returning_to_hub`, to be confirmed).
- **Fail closed:** an assigned order with a status that cannot be placed stops every
  decision for that Rider (`rider-state-unknown`) and nothing is written.
- **Explicit recovery:** each callable first commits the corrected state in its own
  transaction, so even a refused call repairs it; and `recheckRiderTripStates`
  (Dispatcher/Admin, 1–25 named Riders, one transaction each, idempotent) re-derives
  on demand — the **Re-check trip status** button in Assign Rider. It never frees a
  Rider after a trip.
- **After a confirmed return** the stored `available_at_hub` stands: terminal orders
  (delivered, failed, cancelled, legacy) and the old trip record never pull the Rider
  back on a re-check, the trigger, or a repeated confirmation (a replay); a new trip
  forms normally; only an order that is really on the road takes them out again
  (emulator tests "after a confirmed return …").
- **No new index:** the only new read is `riderTrips/{tripId}` by id; the order
  query is still `assignedRiderId ==` (single field).

### Rules delta (live `37b2ced0` → the Part B commit)

1. **Part A timing locks:** `dispatchTripId` and the 15 `timing*` /
   `expectedArrivalAt` / `automaticDelayedAt` fields become server-only. No live
   client writes any of them (web `acc2f55`: 0 occurrences; Rider app: none).
2. **Part B:** `writesServerOnlyDispatch()` + `assignmentIdentityFields()` refused
   to every client (Admin included) — client assignment and client Finalize are
   gone; Admin repair-create cannot create an assigned or departed order;
   read-only `riderDispatchStates` (Admin/Dispatcher list; a Rider their own) and
   `riderTrips` (Admin/Dispatcher).
3. **Stale-state fix:** `leavesTheRoadDirectly()` — an order `in_transit`/`delayed`
   leaves the road only through the server or the Rider's own delay/resume (and the
   Rider's direct failure report while the compatibility switch is on). Before it,
   an Admin browser could move an in-transit order to `pending_dispatch`, `loading`
   or `delivery_failed` directly, detaching it from its trip (rules test RDS5). No
   live client writes those moves (web `acc2f55` and the Part B web: none; Rider app:
   only delay/resume and its failure report).
4. **No client deletes an order** (`orders` `allow delete: if false`, Admin
   included). Before, an Admin browser could delete an order in any status —
   `assigned`, `loading`, `in_transit`, `delayed` included — taking it out from under
   its Rider's trip and its stock custody (rules test RDS6, singly and in a batch).
   No page and no server workflow deletes an order (checked: web `src/`, the Rider
   app, `functions/src`); orders end through the callables.

No index is needed: Part B queries `orders` by `assignedRiderId` only and reads
`riderDispatchStates` as a collection. (The only `firestore.indexes.json` change
since `acc2f55` is the Part A timing index — not deployed here.)

## Live staging baseline (read-only, 2026-10-21)

| Item | Live now |
|---|---|
| Firestore rules | ruleset `37b2ced0-62b4-48a8-92f7-3d37d20baac3`, released 2026-10-17T09:38:07Z; byte-identical (line endings aside) to `rollback-staging-firestore.rules.20261017T093807Z`. |
| Functions | 24, unchanged since 2026-10-20; none of the Part B functions (`recheckRiderTripStates` included), `evaluateDeliveryTiming` or `purgeRiderTrackingData` exists. |
| Indexes | 11 composite, no field overrides. |
| Web | `https://vaxtrack-staging-1b4f31.netlify.app` serves `assets/index-DCzW7kNX.js` — the `acc2f55` build (verified 2026-10-19 by rebuilding `acc2f55`). `main--vaxtrack-staging-1b4f31.netlify.app` serves the same bundle. |

## Web publication

**Confirmed by the site owner (2026-10-21):** auto publishing is **locked**, and
the published deploy is `main@acc2f55`. Do not unlock it for this rollout — the
Part B build is published by hand at step 3.

What was also established read-only (public GitHub API + public site):

- `origin/main` = `acc2f55` (merge of PR #24); its tree equals `385fd2a`, and
  `75866e6` descends from `385fd2a`. Merging the Part B commit into `main` brings
  exactly `f8abad1`, `0ff64bf`, `c9c744c`, `1206acb`, `75866e6` and the fix /
  runbook commit(s) on top — no inventory code.
- Netlify serves a `main--` branch alias with the live bundle, while
  `feat-admin-inventory-removal-controls--…` and
  `fix-rider-navigation-session-lifecycle--…` return 404. This indicates the
  production branch is `main` and no branch deploy exists for the inventory
  branch (pushed to GitHub on 2026-10-21) — but it is inference, not settings.
- There is no PR for the inventory branch (so no deploy preview of it) and no
  GitHub deployment or check run from Netlify. `fix/rider-navigation-session-lifecycle`
  exists on GitHub at `385fd2a` (already in `main`); the five Part B commits, the
  stale-state fix and this runbook are local only until pushed.

**Why the lock matters:** without it, merging Part B into `main` would publish the
new web **before** the functions and rules exist, and every Assign/Finalize in it
would fail. Check the lock is still on immediately before the merge. Not verified
here (optional): branch-deploy scope — irrelevant while publishing is locked,
because branch deploys and previews are never published to production.

**Publishing Part B without the inventory branch** (choose one, before step 1):

- **A (recommended):** with auto publishing locked, push
  `fix/rider-navigation-session-lifecycle` (the Part B commit), open a PR into `main`
  and merge it. Netlify builds the merge commit but does not publish it. In the
  deploy log, check the commit is that merge (second parent = the Part B commit) and that
  the build contains no `inventoryRemovalService` / `InventoryRemovalDialogs`
  module. Publish it only at step 3. **Never merge
  `feat/admin-inventory-removal-controls` into `main` before the inventory
  rollout** — it contains Part B *and* inventory.
- **B:** a manual production deploy from a local `npm run build:staging` of
  this checkout with the Netlify CLI (`netlify deploy --prod --dir dist`) —
  requires installing the CLI and a Netlify login, neither available here.

## Before the window

- **Checkout prerequisites:** the clean Part B checkout needs its functions
  dependencies (`npm ci` in `functions/`) — the deploy loads `index.js` to
  discover endpoints, and the classification script uses `firebase-admin`. Run
  `npm test` in `functions/` there as a smoke check. (Not done in the 2026-10-21
  preflight: nothing was installed.)
- **QA setup (step 0) — before step 1, on the old system,** create the legacy
  fixtures in "QA plan" (a Rider already on the road, one mid-trip).
- Pre-build the web (option A: the locked, unpublished Netlify deploy is ready;
  option B: `dist/` built and checked) so step 3 is one click.
- Choose a window with no dispatching in progress (no orders being assigned or
  loaded). Agree one operator for steps 1–3 and one Dispatcher contact.
- **Warn Dispatchers** (chat/SMS, 15 minutes before and again at step 2):
  > "Dispatch update starting at HH:MM. For about 5 minutes, **Assign rider**
  > and **Finalize dispatch** may say they are not allowed. Do not retry — wait
  > for our 'done' message, then **reload the page (Ctrl+Shift+R)** and continue.
  > Everything else keeps working."
- Read-only classification preview (no writes):
  `node scripts/classifyRiderDispatchStates.mjs --project vaxtrack-staging` (in
  `functions/`) — note every Rider classified `on_trip`; none may later show as
  available.

## Order: close the direct-write window first, and keep it short

1. **Functions** — the three callables and the reconciler.
2. **Firestore rules** — direct assignment / Finalize refused.
3. **Web** — publish the pre-built Part B build.

Rules go before the web on purpose: a refused write from an old tab is safer than
an old tab assigning an order to a Rider who is already out. Between steps 2 and
3 an already-open Dispatcher tab **fails Assign rider and Finalize dispatch until
it is reloaded**. Steps 2 and 3 are run back to back (target: under 5 minutes,
because the web is pre-built). The reverse order would leave direct writes open
for as long as any old tab exists. When its invocation succeeds, the reconciler
records such a write after the fact (it never frees an in-transit Rider; it holds
the order and logs `rider-dispatch-anomaly`), but only the rules can refuse it.

## Commands (do not run until GO)

```powershell
# 1. Functions — exactly these five. Interactive terminal: the first deploy of a
#    new Firestore trigger may ask to grant Eventarc service-agent roles.
firebase deploy --project vaxtrack-staging --only "functions:assignRiderToOrder,functions:finalizeRiderDispatch,functions:confirmRiderReturnToHub,functions:recheckRiderTripStates,functions:reconcileRiderDispatchOnOrderWrite"
firebase functions:list --project vaxtrack-staging     # expect 29: the 24 + these 5; no evaluateDeliveryTiming / purgeRiderTrackingData

# 1b. Optional, after step 1 — classify existing Riders up front (the server
#     otherwise classifies each Rider on first use). Dry run first.
cd functions
node scripts/classifyRiderDispatchStates.mjs --project vaxtrack-staging
node scripts/classifyRiderDispatchStates.mjs --project vaxtrack-staging --apply --confirm <N from the dry run>
cd ..

# 2. Rules — immediately after step 1 checks pass; message Dispatchers first.
firebase deploy --only firestore:rules --project vaxtrack-staging

# 3. Web — Netlify: publish the pre-built Part B deploy (option A), or option B.
#    Then message Dispatchers: "Done — reload the page."
```

## After each step (read-only checks)

- **1:** `functions:list` shows 28 (with no scheduled job added); logs for the
  five functions show no errors; the reconciler fires on order writes and logs
  `rider-dispatch-anomaly` only if an old tab assigns directly before step 2.
- **2:** an old tab's Assign / Finalize is refused (expected); Rider
  delay → resume still works; Med Rep order tracking unaffected.
- **3:** a reloaded Dispatcher tab shows each Rider's trip status on Assign Rider;
  Cargo Loading Finalize sends the whole trip; a Rider whose trip is finished is
  listed under "Returning to hub" until a Dispatcher confirms the return.

## Failure response: pause dispatch and fix forward

**The normal response to any partial or faulty rollout is: pause dispatch, keep
every Part B function deployed (the trip reconciler above all), fix forward, and
verify trip state before dispatch resumes.** There is no routine "rollback" of
Part B, and the rules are not reversed (see the last subsection).

- **Pause dispatch** means Dispatchers stop *Assign rider*, Cargo Loading ticks and
  *Finalize dispatch*, and do not retry refused actions. Everything else carries
  on: Med Reps order, Riders on the road deliver, delay, resume and report
  failures, Admins decide returns.
- **Fix forward** means redeploying the **same five function names** from a
  corrected commit and/or publishing a corrected web build from the locked site,
  with the Part B rules left in place. Fixes are made on a branch from the Part B commit,
  never from the inventory branch.
- **Never delete or disable a function.** While the reconciler is gone, order
  changes are not recorded into trip state at all. The functions are harmless to
  leave running: the old web never calls the callables, and the reconciler writes
  only `riderDispatchStates`, `riderTrips` and an order's `dispatchTripId` — never
  an order status.

### What the reconciler does and does not guarantee

Keeping `reconcileRiderDispatchOnOrderWrite` deployed is necessary, **not proof
that trip state is right**:

- It is `onDocumentWritten("orders/{orderId}", { retry: true })`. A failed
  invocation is redelivered, but only within the platform's bounded retry window;
  an event that keeps failing is eventually discarded and its change is never
  recorded. Inside an invocation, a transient transaction failure is retried at
  most 3 times (`runTripTransaction`).
- Events are delivered at least once and may arrive out of order. Each invocation
  re-reads the Rider's current orders and stored state in a transaction (it does
  not replay the event's payload), which limits the damage of a late or repeated
  event — but a Rider is only re-reconciled when a later write to one of their
  orders changes `status`, `assignedRiderId` or `dispatchTripId`. A missed event
  can leave that Rider's state stale indefinitely.
- The callables act on the **stored** `riderDispatchStates` document whenever one
  exists (they re-derive from orders only for a Rider with no document). A stale
  document therefore drives real decisions: it can refuse a Rider who is in fact
  back (blocking), or — worse — treat a Rider with an order still on the road as
  available.
- Since the stale-state fix, every assignment, Finalize and return confirmation
  re-derives the Rider from their orders before deciding (and commits the
  correction even when it refuses), so a stale document no longer authorizes a
  decision on its own. `recheckRiderTripStates` (the **Re-check trip status**
  button) repairs named Riders on demand; the classification script still only
  covers Riders without a state document.

So after any incident, trip state is treated as **unverified** until the check
below has been done.

### Before dispatch resumes after any incident: trip-state check (read-only)

1. **Logs** (`firebase functions:log --project vaxtrack-staging --only reconcileRiderDispatchOnOrderWrite`,
   and the same for the three callables; or Cloud Logging for the incident
   window): every error, every invocation that failed repeatedly, and every
   `rider-dispatch-anomaly` warning. Note the order and Rider of each.
2. **Active orders:** every order with an `assignedRiderId` and status `assigned`,
   `loading`, `in_transit` or `delayed`, with its `dispatchTripId`.
3. **Per Rider, compare** their active orders with `riderDispatchStates/{rider}`
   and `riderTrips/{tripId}`:

   | Rider's active orders | Expected stored state |
   |---|---|
   | any `in_transit` / `delayed` | `on_trip`; those orders in `orderIds`; `assigned`/`loading` ones in `heldOrderIds` |
   | only `assigned` / `loading` | `trip_forming` (or `returning_to_hub` holding them in `heldOrderIds`), all in `orderIds` / `heldOrderIds` |
   | none | `returning_to_hub` (trip settled, return not yet confirmed) or `available_at_hub` |

   Also: each member order's `dispatchTripId` equals the state's `tripId`;
   `riderTrips/{tripId}` has the same `orderIds` and a matching `status`
   (`forming` / `departed` / `settled`); no active order is missing from every
   Rider's state; every order named in a log entry from step 1 is accounted for.
4. **Handle mismatches:**
   - **Unsafe** — a Rider with an `in_transit`/`delayed` order stored as
     `available_at_hub` or `trip_forming`, or any active order missing from its
     Rider's state: **dispatch stays paused for everyone** (the callables would
     act on the wrong state, and a "don't use this Rider" note enforces nothing).
   - **Blocking** — stored `on_trip`/`trip_forming` although every member order is
     settled: safe (the Rider is refused) but stuck. Dispatch may resume for other
     Riders only if there is no unsafe mismatch.
   - **Bookkeeping** — `riderTrips` or `dispatchTripId` disagreeing with an
     otherwise correct state: record it; resume only for Riders without it.
   - **Repair:** a Dispatcher or Admin runs **Re-check trip status** (Assign Rider)
     — `recheckRiderTripStates`, the same `riderDispatchOps.reconcileRider`
     transaction for the Riders listed — then this check again. A Rider it reports
     as *could not be checked* has an order with an unplaceable status: fix that
     order through the server paths (or a reviewed fix-forward) — no decision is
     made for that Rider until then. **Never** hand-edit `riderDispatchStates`, `riderTrips` or
     `dispatchTripId`, change an order's status to provoke a reconcile, or cancel
     an in-transit order to free a Rider.
5. Dispatch resumes only when steps 1–4 show no unsafe mismatch; record who
   checked and when.

### Step 1 failed (function deploy error, or errors in the new functions)

1. Do not run step 2. Users are unaffected: the old web still dispatches under the
   old rules.
2. A partially failed deploy: re-run the same five-name command. A code error: fix
   forward from a corrected commit, same five names.
3. If the reconciler is erroring, leave it deployed and fix forward. Before step 2,
   run the trip-state check above for every Rider with active orders (the old
   web's direct writes during this period are recorded only by successful
   invocations), plus the classification dry run for unclassified Riders. Do not
   run step 2 until the logs are clean and the check shows no unsafe mismatch.

### Step 2 done, web not yet published (or the Part B build will not publish)

Old tabs are already refused for Assign/Finalize, so dispatch is paused. Keep it
paused. Publishing the pre-built Part B deploy (step 3) **is** the fix; if that
build is unusable, build a corrected one (merge the fix into `main`, let the
locked site build it, check the commit) and publish that. Run the trip-state
check before dispatch resumes.

### Step 3 done, a problem is found after the web publish

Reverting **only** the web (publishing `acc2f55`) while the Part B rules stay in
place leaves the old *Assign rider* and *Finalize dispatch* refused — dispatching
stays stopped until a fixed Part B build is published. It is a valid fallback
**only as "web reverted + dispatch paused"**, never as a way to resume dispatching.

Recovery procedure:

1. **Pause dispatch.** Message Dispatchers: stop assigning, Cargo Loading and
   Finalize; do not retry; keep the page open for instructions.
2. **Record the state (read-only):** steps 1–3 of the trip-state check, as of now.
3. **Choose the web to show while paused.**
   - Keep the Part B build published if its other pages work: Dispatchers can
     still see trip status and confirm returns.
   - If the Part B build itself is unusable, publish the previous `acc2f55` deploy
     from Netlify's deploy list (the site stays locked) and ask Dispatchers to
     reload. Keep the Part B rules: the old Assign/Finalize stay refused, which is
     intended while paused, and every other page works. Riders whose trips settle
     wait in `returning_to_hub` until a Part B build is back to confirm returns.
4. **Leave all five functions and the Part B rules in place.** Riders on the road,
   Med Rep ordering, failure reports and return decisions continue.
5. **Fix forward.** Correct the web and/or functions on a branch from the Part B
   commit; redeploy the same five function names if needed; merge the web fix into
   `main`; the locked site builds it; check the deploy's commit; publish it.
6. **Verify, then resume.** Run the full trip-state check again and handle every
   mismatch as above. Only then: Dispatchers reload, confirm returns for Riders
   back at the hub, and resume dispatching.

While paused, the Part B rules stop every client from writing assignment or
departure, so no new bypass can occur — but that does not by itself make trip
state correct; only the check does.

### Rules reversal to `37b2ced0`: unavailable for this release

Restoring ruleset `37b2ced0` reopens direct browser assignment and Finalize —
which is exactly how the old web dispatches — and those writes bypass every Part B
server check. There is no ruleset that gives the old web working Assign/Finalize
without reopening that bypass, and no technical means in the Part B commit of preventing
it while those rules are live. A Dispatcher "do not assign" list enforces nothing.

Therefore **rules reversal is not available as an incident action**:

- If any `trip_forming`, `on_trip` or `returning_to_hub` trip exists, or trip state
  has not been verified by the check above, keep the Part B rules, pause dispatch
  and fix forward.
- It could only be considered where direct-write bypass has been **technically
  prevented** (for example a separately reviewed and emulator-tested ruleset or
  code change) **and** trip state has been verified with no active or returning
  trips. Neither exists in this release, so the option is marked unavailable.
- Withdrawing Part B altogether would be its own planned release, not a rollback.

## QA plan (disposable staging data, after step 3 unless marked step 0)

**Do not cancel an in-transit order in staging QA.** The live
`cancelOrderWithInventoryRelease` (deployed 2026-10-06) predates the
cancel-after-dispatch custody handling (`RETURN_ON_CANCEL_FROM`, `f8abad1`) and is
not part of this release, so cancelling `in_transit` / `delayed` releases stock
whose vials are still with the Rider. Orders are cancelled only before departure
(`pending_dispatch`, `assigned`, `loading`), and departed orders are settled by
delivery failure (below) — Part B counts `delivery_failed` as settling a trip.

**Fixtures (labelled `QA-PARTB-<date>`):** one QA Med Rep with a QA clinic/doctor
in its territory; one existing test vaccine with a QA batch of small quantity
(e.g. 20) added through Add Stock; three approved QA Riders (R1, R2, R3) that no
real dispatching uses; orders dated today so they are dispatchable. Record every
order number and Rider used.

| # | Check | Steps | Expected |
|---|---|---|---|
| 0a | Legacy Rider already on the road (**step 0, before step 1**) | Old web: assign order L1 to R3, Cargo Loading tick + Finalize → `in_transit`. | — (fixture) |
| 0b | Legacy Rider mid-trip (**step 0**) | Old web: after 0a, assign order L2 to R3 (stays `assigned`). | — (fixture) |
| 1 | Legacy classification | After step 1: classification dry run; after step 3: Assign Rider list. | R3 = `on_trip`, L1 in the trip, L2 held for the next trip; R3 **not** shown as available; assigning a new order to R3 is refused. |
| 2 | Simultaneous assignment, one order | Two Dispatcher sessions open the same pending order A; assign to R1 and R2 at the same moment. | Exactly one succeeds; the other is told the order is already assigned; A has one `assignedRiderId` and one trip. |
| 3 | Simultaneous assignment, one Rider | Two sessions assign orders B and C to R1 at the same moment. | Both join R1's single forming trip (one `dispatchTripId`); `riderDispatchStates/R1` = `trip_forming` with both. |
| 4 | Multiple orders before departure | Assign D to R1 too; Cargo Loading shows R1's group B, C, D. | All three in the trip; Finalize is blocked until every one is loaded. |
| 5 | Finalize | Tick B, C, D; Finalize. | All three `in_transit` with the same trip id; R1 = `on_trip`. |
| 6 | Repeat Finalize | Click Finalize again (second tab or double click), and retry after a network blip. | No second transition, no duplicate history; a refusal or a replay message — never a new trip. |
| 7 | Refusal after departure | Assign new order E to R1. | Refused ("already left on a trip"); E stays pending. |
| 8 | Terminal settlement | Rider app (R1): report delivery failure on B, C and D (reason "QA"). Admin: confirm each return as **Returned and usable**. | After the last one, R1 = `returning_to_hub`, listed under "Returning to hub"; stock back to available. |
| 9 | Repeat return confirmation | Dispatcher confirms R1's return; then confirms again (second tab / double click). | First: R1 = `available_at_hub`. Second: replay / no-op, no extra trip, no error state. |
| 10 | Legacy Rider not freed | Throughout: R3 never appears available while L1 is `in_transit`. Settle L1 by delivery failure + usable return (as in 8). | Only then R3 = `returning_to_hub`; L2 becomes the next trip after the return is confirmed. |
| 11 | Re-check trip status | After 1–10, a Dispatcher opens Assign Rider for a pending order and clicks **Re-check trip status**. | "…all were up to date" (no correction expected); no Rider becomes available; a Rider still out stays out. Any correction or *could not be checked* is investigated before dispatch continues. |

**Clean-up (no cancel after departure):** requeue each failed QA order
(`requeueFailedOrder`) and cancel it while `pending_dispatch`; cancel E, L2 and any
other undeparted QA order directly; confirm every QA Rider's return to hub. Leave
the labelled QA batch at zero reserved; it can be retired with the inventory
release's Remove unusable stock later.

**Not covered here:** completion by delivery (needs the Rider at the clinic
geofence with proof upload — physical QA, postponed).
