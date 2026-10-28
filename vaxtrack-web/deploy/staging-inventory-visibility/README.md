# Long-empty inventory visibility — candidate, NOT deployed

Based on `81301fd`. Independent of the pending Rider arrival-display patch.
This release is list housekeeping, not a stock write, manual archive, deletion,
financial adjustment, new ordering restriction or change to existing orders.

## Behaviour

- One clock per vaccine DOCUMENT ID, across all its inventory batches.
- Physical on-hand quantity is the criterion, not free/available quantity.
  Reserved, return-pending, quarantined and expired physical stock prevents an
  empty classification. Contradictory/malformed counters need review and remain
  visible. Voided mistaken entries are not physical stock.
- A server observation starts `inventoryEmptySince` when every batch is confirmed
  empty. Absent historical depletion data is NOT reconstructed from createdAt,
  updatedAt, expiry, order history or the last sale. Existing empty products will
  therefore NOT disappear immediately after deployment.
- More than THREE CALENDAR MONTHS in Philippine time (not 90 days), clamped at
  month-end, makes a product inactive in the default list. Exactly the anniversary
  is not yet "more than" three months. Open pages re-evaluate each minute and on
  window focus; the browser clock controls presentation only.
- Admin Inventory, Med Rep Inventory and Request Order offer Show inactive
  inventory. The Med Rep Dashboard's stock-watch list follows the default view.
  These controls cannot restore a manual archive or make a voided batch orderable.
- Any currently observed positive stock or custody/data problem makes the product
  visible immediately, even if the observer's metadata still says empty.
  When it becomes empty again, a fresh interval starts.
- Restocking does not recreate/delete old batch records or revive old units.
  This is PRODUCT-level visibility, not an individual-batch purge. Historical
  rows remain accessible with Show inactive inventory.
- Admin summary counts and exports follow this visibility choice (as well as
  their existing filters). Manage vaccines still counts ALL non-voided batches.
- Saved cart lines, stock estimates, checkout validation, future orders,
  reservations, Add Stock, proof, invoices and order history do not use this
  housekeeping filter. Hidden products can still be backordered through the
  existing eligible-batch path after selecting Show inactive inventory.
- No vaccine `archived` flag is changed. Manually archived products still require
  explicit restore before adding stock; automatic inactivity never imposes that
  restriction.

## Server contract and limits

Server-owned fields on `vaccines/{vaccineId}`:

| Field | Meaning |
| --- | --- |
| inventoryVisibilityVersion | 1 |
| inventoryStockState | empty / in_stock / needs_review |
| inventoryEmptySince | first confirmed observation of this empty interval, or null |
| inventoryPositiveEvidenceAt | newest positive-stock snapshot commit observed, or null |

Client create, edit or deletion of these fields is refused even for Admin.
Normal catalog edits remain compatible. The cursor collection
`inventoryVisibilityMaintenance` is server-only for reads AND writes.

`observeInventoryVisibility` is a NEW independent, retry-enabled inventory-write
trigger. A transaction queries current batches; it never replays counters from
the event. Late positive snapshots reset an empty interval conservatively at
observation time. The monotonic evidence timestamp makes replay/out-of-order
events idempotent. This is eventually consistent housekeeping, not a complete
historical stock ledger. Lost/unprocessed historical events cannot establish an
exact historical depletion date; live-stock guards and the daily pass are the
backstops, not a claim of instantaneous event delivery.

`reviewInventoryVisibility` is a NEW SCHEDULED JOB, daily 03:00 Asia/Manila.
Deploying it requires explicit approval: this release does NOT reuse or enable
`evaluateDeliveryTiming` or `purgeRiderTrackingData`.

- The daily pass processes at most 200 products, five transactions at a time.
  A durable document-ID cursor rotates through a larger catalog on successive
  days; it does not starve everything after the first page.
- One product reads at most 1,001 batches. More than 1,000 means needs_review,
  not confirmed empty. That product stays visible until a reviewed scale-up.
- One product's failure is logged safely and doesn't block the rest. Failed
  products are revisited on the next full catalog cycle. At 1,000 products the
  daily cycle takes five days, so observation can be delayed accordingly.
- Queries use automatic single-field indexes, no new composite index.
- Costs: a query of each product's batches on affected inventory writes and daily
  review; product writes only when metadata changes; one cursor read/write per
  daily run. No new Firestore listener on pages already reading vaccines. The
  Med Rep Dashboard adds one vaccine-catalog listener.

## Checks before rollout

Candidate checks executed in the preparation workspace (Node 24.22.1): Functions unit 433/433,
web 1400/1400 (including the 22 pending Rider arrival parity tests), lint exit 0,
staging compile exit 0, whitespace clean. The compile is NOT a verification of
the Windows staging environment configuration. Firestore emulator/rules tests
and live browser QA were NOT executed here; they remain release gates.
Functions must also be rechecked with the deployment runtime, Node 22.

Run on the combined checkout, preserving the pending Rider patch:

```powershell
cd C:\VAXTRACK\vaxtrack-web\functions
npx --yes --package=node@22 --package=firebase-tools@15.17.0 --call "npm test"
if ($LASTEXITCODE -ne 0) { throw "Functions unit tests failed. Stop." }
npx --yes --package=node@22 --package=firebase-tools@15.17.0 --call "npm run test:emulator"
if ($LASTEXITCODE -ne 0) { throw "Functions emulator tests failed. Stop." }

cd C:\VAXTRACK\vaxtrack-web
npm run test:rules
if ($LASTEXITCODE -ne 0) { throw "Rules tests failed. Stop." }
npm test
if ($LASTEXITCODE -ne 0) { throw "Web tests failed. Stop." }
npm run lint
if ($LASTEXITCODE -ne 0) { throw "Lint failed. Stop." }
npm run build:staging
if ($LASTEXITCODE -ne 0) { throw "Staging build failed. Stop." }
git diff --check
```

Focused real-emulator file is `functions/test/integration/inventoryVisibility.test.js`.
It refuses to start without a loopback FIRESTORE_EMULATOR_HOST and uses its own
demo project. Do not run it against staging or production. Unit/source checks
do not substitute for this suite or actual rules evaluations.

Manual browser QA on emulator fixtures (never backdate live stock to manufacture
a test): at 375px, 768px and 1366px, test search/pagination/export and the checkbox
with all products inactive. Confirm a current positive batch restores the product
without a reload; a fully reserved batch stays visible; data errors stay visible;
manual archives remain excluded from Med Rep ordering; existing carts survive
toggling the view. No dialogs were modified by this release.

## Compatible staging rollout — approval required, no execution yet

1. Finish emulator/rules/manual checks; review the exact source and current live
   staging baseline. Commit this feature separately from the Rider display.
2. Deploy the reviewed Firestore rules to `vaxtrack-staging`. Old clients never
   write these new fields, so they continue working; this closes forgery before
   observation fields are first created.
3. Deploy ONLY the new `observeInventoryVisibility` trigger. Do not perform a
   blanket functions deployment or update unrelated functions/scheduled jobs.
4. Separately approve and deploy ONLY `reviewInventoryVisibility`, creating the
   new daily scheduled job. Review logs and first observations. Do not enable
   the two other scheduled jobs incidentally.
5. Publish the matching staging web build and check actual product visibility.
   Missing metadata intentionally keeps items visible until observed and aged.

No production change, business-data migration, APK change, stock decrement,
automatic disposal or hard deletion is part of this release. Recovery is Show
inactive inventory or reverting ONLY this display build while investigating;
never alter stock counters, manually backdate clocks or weaken unrelated rules.
