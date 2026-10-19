# Staging rollout — Rider trips (Part B): server-owned assignment, Finalize Dispatch, return to hub

**Target: `vaxtrack-staging` only. PREPARED, NOT DEPLOYED.** Prepared 2026-10-19.
Run every command from `vaxtrack-web/` of a checkout of the approved commit — not
from a working tree with unrelated uncommitted work.

## Order: close the direct-write window first

1. **Functions** — the three callables and the reconciler.
2. **Firestore rules** — the restrictive rules (direct assignment / Finalize refused).
3. **Web** — the new Dispatcher build.

Rules go out **before** the web build on purpose. Between steps 2 and 3, an
already-open Dispatcher tab still runs the OLD page, which assigns riders and
finalizes dispatch with direct Firestore writes. The new rules refuse those
writes, so in that window an old tab **fails "Assign rider" and "Finalize
dispatch"** (the old page says it lacks permission / could not finalize)
**until it is refreshed** onto the new build. That is deliberate: a refused
write is safer than letting an old tab assign an order to a Rider who is
already out on a trip. Tell Dispatchers before step 2: *"If assigning or
finalizing fails, refresh the page."* Every other page and action keeps
working (checked below).

The reverse order (web, then rules) would leave the direct-write paths open
for as long as any old tab exists. The reconciler folds such writes in (it
never frees an in-transit Rider; it holds the order for the next trip and logs
`rider-dispatch-anomaly`), but it cannot refuse them — only the rules can.

## Live staging baseline (read-only reads, 2026-10-19)

| Item | Live now |
|---|---|
| Firestore rules | ruleset `37b2ced0-62b4-48a8-92f7-3d37d20baac3`, released 2026-10-17T09:38:07Z. Exact copy: `rollback-staging-firestore.rules.20261017T093807Z` (read from the Rules API). |
| Functions | 24 deployed (8 different source hashes, i.e. several partial deploys): addStockBatchWithAllocation, allocateOnInventoryWrite, allocateOnOrderWrite, cancelOrderWithInventoryRelease, confirmReturnDisposition, continueAllocation, correctOrderDestination, createOrderWithReservation, getReservationProvenance, issueInvoiceForPricedOrder, markOrderDeliveredWithInventoryConsumption, materializeOrderHistory, recordOrderStatusEvent, reportDeliveryFailure, requestOrderDestinationChange, requeueFailedOrder, rescheduleOrderDelivery, reviewOrderDestinationChange, saveInvoiceDraftForPricedOrder, settleClientReportedFailure, syncRiderTrackingOnOrderWrite, trackNavigationSession, trackRiderLocation, validateDeliveryCompletionGeofence. |
| Web | Netlify, git-connected (`/netlify.toml`, `npm run build:staging`). The published deploy could not be read here (no Netlify access); `origin/main` is `acc2f55` (2026-10-14). The compatibility checks below were run against `acc2f55` and must be repeated against whatever commit Netlify actually has published. |

## What changes, compared with live

### Functions (pending `functions/index.js` vs the 24 live)

Exported but not live: `assignRiderToOrder`, `finalizeRiderDispatch`,
`confirmRiderReturnToHub`, `reconcileRiderDispatchOnOrderWrite` (**Part B —
deployed in step 1**) and `evaluateDeliveryTiming`, `purgeRiderTrackingData`
(scheduled jobs, **not part of this rollout**). Nothing live is missing from
the source. Step 1 names its four functions explicitly, so the other 24 keep
the code they run today (a deploy uploads the whole source tree but updates
only the named functions).

### Firestore rules (pending `firestore.rules` vs live `37b2ced0…`)

Line endings aside, the live ruleset equals commit `1206acb`'s file except
for one block — the pending file is live **plus exactly two groups**:

1. **Part A (automatic delivery timing):** 15 `timing*` / `expectedArrivalAt` /
   `automaticDelayedAt` fields added to `serverOnlyOrderFields()`.
2. **Part B (this release):** `dispatchTripId` server-only; `writesServerOnlyDispatch()`
   + `assignmentIdentityFields()` refused to every client (Admin included) in
   `clientOrderWriteIsAllowed()`; the client assignment / dispatch validators
   removed; Admin repair-create may not create an assigned or departed order;
   read-only `riderDispatchStates` (Admin/Dispatcher; a Rider their own) and
   `riderTrips` (Admin/Dispatcher).

No other rule differs.

### Part A (delivery timing) dependencies

Part B does **not** need Part A deployed, and deploying these rules does not
deploy Part A:

- The Part A timing fields become server-only, but **no live writer sets them**:
  the live web (`acc2f55`) and the Rider app never write any timing field (checked:
  0 occurrences), and the live `recordOrderStatusEvent` predates the timing freeze.
  Locking fields nobody writes changes nothing.
- `finalizeRiderDispatch` writes the same dispatch fields the old client did,
  so the live `recordOrderStatusEvent` records the Dispatched event exactly as
  today (no timing baseline — Part A is not live).
- The new web build shows timing only when an order carries `timingStatus`;
  with Part A not live no order does, and the indicator is simply absent.
- No index is needed: Part B queries `orders` by `assignedRiderId` only (single
  field). The Part A composite index is needed only by `evaluateDeliveryTiming`.
- Part A itself (index → `recordOrderStatusEvent` + `requeueFailedOrder` →
  `evaluateDeliveryTiming`, a new Cloud Scheduler job) stays a separate,
  separately approved rollout.

### Compatibility of what is live with the pending rules

| Client | Newly refused by the pending rules | Effect |
|---|---|---|
| Old Dispatcher web (`acc2f55`) | Direct assignment (`orderService.assignRiderToOrder`) and client Finalize (`cargoLoadingService.finalizeRiderDispatch`). Nothing else: it writes no timing field, no `dispatchTripId`, and creates no assigned order. | Assign / Finalize fail until the tab is refreshed onto the new build. |
| Rider app (current staging build) | Nothing. Its only direct `in_transit` write is resume (`delayed → in_transit`), still allowed (rules test RDS3); it writes no assignment or timing field. | None. |
| Admin / Med Rep pages | Admin repair-create of an already-assigned or departed order — no page does that. | None. |

### Web (new build vs `acc2f55`)

Calls three callables that are not live yet (`assignRiderToOrder`,
`finalizeRiderDispatch`, `confirmRiderReturnToHub`) — hence step 1 before step 3.
Reads `riderDispatchStates` (allowed only by the step-2 rules; before them the
pages show "Trip status not confirmed yet" and still work). Every other
callable it uses is live.

## Commands (do not run until approved)

```powershell
# 1. Functions — exactly these four (interactive terminal: the first deploy of
#    a new Firestore trigger may ask to grant Eventarc service-agent roles).
firebase deploy --project staging --only "functions:assignRiderToOrder,functions:finalizeRiderDispatch,functions:confirmRiderReturnToHub,functions:reconcileRiderDispatchOnOrderWrite"
firebase functions:list --project staging     # expect 28: the 24 above + these 4

# 1b. Optional, any time after step 1 — classify existing Riders up front
#     (the server otherwise classifies each Rider on first use). Dry run first.
cd functions
node scripts/classifyRiderDispatchStates.mjs --project vaxtrack-staging
node scripts/classifyRiderDispatchStates.mjs --project vaxtrack-staging --apply --confirm <N from the dry run>
cd ..

# 2. Rules — immediately after step 1 (keeps the direct-write window short).
#    Warn Dispatchers first: "If assigning or finalizing fails, refresh the page."
firebase deploy --only firestore:rules --project staging
```

3. **Web** (Netlify): build the approved commit (`npm run build:staging` as a
   local preflight), let Netlify build it with auto-publishing locked, then
   **Publish** that deploy. Ask Dispatchers to refresh open tabs.

## After each step (read-only checks)

- Step 1: `functions:list` shows 28; function logs show no errors; the
  `rider-dispatch-anomaly` warning appears only if an old tab assigns directly
  before step 2 (each one is held, never freeing a Rider — review them).
- Step 2: an old tab's Assign / Finalize is refused; Rider delay → resume still
  works; Med Rep order tracking unaffected.
- Step 3: Assign Rider shows each Rider's trip status; Cargo Loading Finalize
  sends the whole trip; a Rider whose trip is finished appears under
  "Returning to hub" until a Dispatcher confirms the return.

## Rollback

- Rules: `firebase deploy --only firestore:rules --project staging` from a
  checkout whose `firestore.rules` is `rollback-staging-firestore.rules.20261017T093807Z`
  (or Console → Firestore → Rules → History → `37b2ced0…`). Only after the web
  is also rolled back — the old web needs the old rules to assign.
- Web: Netlify → publish the previous deploy.
- Functions: the four new ones can stay (unused by the old web, and the
  reconciler only maintains trip state); to remove them,
  `firebase functions:delete assignRiderToOrder finalizeRiderDispatch confirmRiderReturnToHub reconcileRiderDispatchOnOrderWrite --project staging --region asia-southeast1`.
  `riderDispatchStates` / `riderTrips` documents are inert without them.
