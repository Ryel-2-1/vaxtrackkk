# Staging rollout — Admin inventory removal controls

**Target: `vaxtrack-staging` only. PREPARED, NOT DEPLOYED.** Prepared 2026-10-20 on
branch `feat/admin-inventory-removal-controls` (based on `75866e6`, Rider Part B).
Run every command from `vaxtrack-web/` of a clean checkout of the approved commit,
never from a working tree with unrelated changes. Every command names the project
explicitly (`.firebaserc`'s default is production).

## What this release is

Four new Admin callables, plus the server checks the existing order and stock
paths now apply:

| Callable | Does |
|---|---|
| `setVaccineArchived` | archive / restore a vaccine product (new orders and Add Stock refuse it) |
| `voidInventoryBatch` | void a provably unused, mistaken batch (kept as a record) |
| `removeUnusableStock` | quarantine free doses; dispose of quarantined doses |
| `correctStockQuantity` | Correct Stock, moved from a direct client write to the server |

Rules: no client hard-deletes a vaccine or batch; the only client write to a batch
is an audited re-price; archive, void, usage, counter, correction and date fields
are server-written; new read-only `inventoryAuditEvents` (Admin).

## Prerequisite: Rider Part B is rolled out first

This branch sits on top of the unshipped Part B commit and the Part A timing work.
An inventory rollout from it **cannot** be separated from them:

- **Rules.** This branch's `firestore.rules` = live + Part A timing locks + Part B
  dispatch rules + inventory. Deploying it before Part B's callables and web would
  break the live Dispatcher's Assign / Finalize. After the Part B rollout
  (`deploy/staging-rider-trips/README.md`) the live rules equal `75866e6`'s file,
  and this release's rules change **only** the inventory sections (checked:
  `stockPriceFields`, `vaccineArchiveFields`, `inventory` update/delete,
  `vaccines` create/update/delete, new `inventoryAuditEvents`).
- **Web.** This branch's web build contains Part A, Part B and inventory UI. After
  the Part B rollout the remaining delta is the inventory UI only.
- **Functions.** See "What the inventory functions also ship" below.

**Order:** Part B rollout (its own runbook, approved separately) → this rollout.

## Live staging baseline (read-only checks, 2026-10-20)

| Item | Live now |
|---|---|
| Firestore rules | ruleset `37b2ced0-62b4-48a8-92f7-3d37d20baac3`, released 2026-10-17T09:38:07Z — byte-identical (line endings aside) to `deploy/staging-rider-trips/rollback-staging-firestore.rules.20261017T093807Z`. |
| Functions | 24, 9 distinct source hashes, deployed 2026-09-23 … 2026-10-17 from working trees (not mappable to single commits: the source hash covers the upload zip, which includes file timestamps). |
| Indexes | 11 composite, `fieldOverrides: []`. This release needs no index: its queries are single-field (`inventoryIds` array-contains; `inventoryId ==`). `firestore.indexes.json` is unchanged. |

Live deploy times of the functions this release replaces:

| Function | Live since (UTC) |
|---|---|
| createOrderWithReservation | 2026-10-11T13:12 |
| addStockBatchWithAllocation | 2026-10-14T08:01 |
| cancelOrderWithInventoryRelease | 2026-10-06T10:27 |
| confirmReturnDisposition | 2026-10-06T10:27 |
| requeueFailedOrder | 2026-10-10T06:59 |
| allocateOnInventoryWrite | 2026-10-06T10:27 |
| allocateOnOrderWrite | 2026-10-06T10:27 |
| continueAllocation | 2026-10-14T08:01 |
| materializeOrderHistory | 2026-10-06T10:27 |

## Exact function deploy list (13)

**Step 1a — every function that quotes or reserves stock (9).** Each runs the
allocator or the order quote, which now: refuses archived products and voided
batches, never allocates a voided batch, and stamps batch usage in the same
transaction. They go FIRST so no old copy can reserve from a batch voided later.

```powershell
firebase deploy --project vaxtrack-staging --only "functions:createOrderWithReservation,functions:addStockBatchWithAllocation,functions:cancelOrderWithInventoryRelease,functions:confirmReturnDisposition,functions:requeueFailedOrder,functions:allocateOnInventoryWrite,functions:allocateOnOrderWrite,functions:continueAllocation,functions:materializeOrderHistory"
```

**Step 1b — the four new callables.**

```powershell
firebase deploy --project vaxtrack-staging --only "functions:setVaccineArchived,functions:voidInventoryBatch,functions:removeUnusableStock,functions:correctStockQuantity"
firebase functions:list --project vaxtrack-staging   # expect previous count + 4
```

**Not deployed by this release** (named so a broad deploy is never used):
`evaluateDeliveryTiming`, `purgeRiderTrackingData` (scheduled jobs — Part A /
retention, separate approval), `recordOrderStatusEvent` (Part A), the Part B
callables and reconciler (their own rollout), `trackRiderLocation`,
`trackNavigationSession`, `syncRiderTrackingOnOrderWrite`,
`markOrderDeliveredWithInventoryConsumption`, `validateDeliveryCompletionGeofence`,
`reportDeliveryFailure`, `settleClientReportedFailure`, `getReservationProvenance`,
the destination, schedule and invoice callables. Never run
`firebase deploy --only functions` without a list.

### What the inventory functions also ship

A deploy uploads the whole `functions/` tree and updates the named functions, so
the 9 functions in step 1a run **everything on their code paths at the approved
commit**, not just the inventory change. Since their live versions (6–14 Oct),
those paths also changed in `f8abad1` (Part A + delivery hardening) and earlier
commits:

| Function | Also ships |
|---|---|
| confirmReturnDisposition | per-batch split decisions (`lines`) and split history events — the single-disposition call the live web makes still works |
| requeueFailedOrder | clears the Part A `timing*` fields on requeue (a no-op while Part A is not live) |
| cancelOrderWithInventoryRelease | cancel-after-dispatch returns + loading-custody checks (`cancellationReturnsForInspection`) |
| createOrderWithReservation, addStock, allocator triggers, materializeOrderHistory | the allocator / history code as of the commit (including `f8abad1`'s order-history changes) |

These are the server halves of features whose web halves ship with the Part B
build (which already includes `f8abad1`), so after the Part B rollout the web
and these functions match. No scheduled job is created or changed.

## Step 2 — Firestore rules (immediately after step 1)

```powershell
firebase deploy --only firestore:rules --project vaxtrack-staging
```

Effect on already-open Admin tabs (old build): **Correct stock fails** (the old
page writes the batch directly, which is now refused) **until the tab is
refreshed** onto the new build. Re-pricing and VAT classification keep working.
No other role is affected: no Sales Rep, Dispatcher or Rider client writes
`inventory` or `vaccines`.

## Step 3 — Web

Build the approved commit (`npm run build:staging` as a local preflight), let
Netlify build it with auto-publishing locked, then **Publish** that deploy. Ask
Admins to refresh open tabs.

## After each step (read-only checks)

- 1a: function logs show no errors; orders, Add Stock, cancel, return decisions
  and requeue behave as before.
- 1b: `functions:list` shows the 4 new callables in asia-southeast1.
- 2: an old Admin tab's Correct stock is refused; re-price still works.
- 3: Inventory shows Manage vaccines, Remove unusable stock, Void batch and the
  stock change history. Existing batches show Void as unavailable ("cannot be
  proven unused") — expected: only batches added after step 1a are voidable.

## Rollback

- Web: Netlify → publish the previous deploy.
- Rules: deploy `75866e6`'s `firestore.rules` (the post-Part-B baseline) — only
  after the web is rolled back, since the old web's Correct Stock needs the old
  rule.
- Functions: redeploy the 9 step-1a functions from `75866e6`; delete the four
  new ones with
  `firebase functions:delete setVaccineArchived voidInventoryBatch removeUnusableStock correctStockQuantity --project vaxtrack-staging --region asia-southeast1`.
- **Data caveat:** the old code ignores `voided` and `archived`. If any batch was
  voided or vaccine archived before a functions rollback, the old allocator could
  reserve a voided batch's recorded quantity and the old order path would accept
  an archived product. Check `inventoryAuditEvents` for `batch_voided` /
  `vaccine_archived` entries before rolling back functions, and decide how to
  neutralise them first (an approved, audited data step — not prepared here).
