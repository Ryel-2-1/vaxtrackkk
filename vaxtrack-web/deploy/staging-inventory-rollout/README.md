# Staging rollout — inventory allocation (prepared 2026-10-06, NOT deployed)

Target: `vaxtrack-staging` only. Every command runs from `vaxtrack-web/` of a
checkout of the APPROVED release commit — not from a working tree that holds
unrelated uncommitted work (see "Overlap" in the session report).

## Live staging baseline (read-only reads, 2026-10-06)

| Item | Live now | Rollback point |
|---|---|---|
| Firestore rules | ruleset `2e5ab805-17fc-4ae3-89e2-dd330e5431b0`, released 2026-10-05T08:48:32Z | `rollback-staging-firestore.rules.20261005T084832Z` (exact copy) |
| Indexes | none of the 6 composite indexes exist; no extra live indexes | nothing to restore |
| createOrderWithReservation | `createorderwithreservation-00004-key` (2026-09-23) | that revision |
| cancelOrderWithInventoryRelease | `cancelorderwithinventoryrelease-00003-jeq` (2026-09-23) | that revision |
| markOrderDeliveredWithInventoryConsumption | `markorderdeliveredwithinventoryconsumption-00006-ven` (2026-10-05) | that revision |
| saveInvoiceDraftForPricedOrder | `saveinvoicedraftforpricedorder-00004-niw` (2026-09-23) | that revision |
| issueInvoiceForPricedOrder | `issueinvoiceforpricedorder-00004-duh` (2026-09-23) | that revision |
| Rider staging APK | debug-signed, 1.0.0 (versionCode 1), built 2026-10-05 18:09 | archive it before building (step f) |

## Deploy (in this order)

```powershell
# a. Indexes only
firebase deploy --only firestore:indexes --project staging

# b. Wait until every index is READY (re-run until exit code 0 / "ALL READY")
node deploy/staging-inventory-rollout/check-index-readiness.cjs vaxtrack-staging

# c. Functions — exact targets only (15)
firebase deploy --project staging --only "functions:createOrderWithReservation,functions:cancelOrderWithInventoryRelease,functions:markOrderDeliveredWithInventoryConsumption,functions:addStockBatchWithAllocation,functions:reportDeliveryFailure,functions:confirmReturnDisposition,functions:requeueFailedOrder,functions:getReservationProvenance,functions:allocateOnInventoryWrite,functions:allocateOnOrderWrite,functions:continueAllocation,functions:settleClientReportedFailure,functions:saveInvoiceDraftForPricedOrder,functions:issueInvoiceForPricedOrder,functions:rescheduleOrderDelivery"
firebase functions:list --project staging
```

d. Web (Netlify, git-connected; build = `npm run build:staging` per `/netlify.toml`):
1. Netlify → Deploys → **Lock / Stop auto publishing** *before* pushing.
2. `npm run build:staging` locally as a preflight.
3. Push the release commit to the branch Netlify builds (Site configuration →
   Build & deploy → Branches). Wait for "Deploy ready" (not published).
4. After step c succeeded: Deploys → that deploy → **Publish deploy**.

```powershell
# e. Compatibility-mode rules (legacyRiderFailureWritesAllowed() must return true)
Select-String -Path firestore.rules -Pattern "function legacyRiderFailureWritesAllowed" -Context 0,1
firebase deploy --only firestore:rules --project staging
```

```powershell
# f. Rider staging build → vivo V2419 (from vaxtrack_mobile/)
New-Item -ItemType Directory -Force ..\..\rider-rollback | Out-Null
Copy-Item build\app\outputs\flutter-apk\app-staging-debug.apk ..\..\rider-rollback\app-staging-debug-1.0.0+1.apk
flutter build apk --flavor staging -t lib/main_staging.dart --debug
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" devices -l      # note the serial with model:V2419
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" -s <V2419_SERIAL> install -r build\app\outputs\flutter-apk\app-staging-debug.apk
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" -s <V2419_SERIAL> shell dumpsys package com.example.vaxtrack_mobile.staging | Select-String "versionName|versionCode"
# expect versionName=1.1.0 versionCode=2
```
Debug signing is deliberate: the device already has a debug-signed staging
build, so this upgrades in place (no uninstall, no lost login) and the old APK
can be reinstalled as a downgrade.

g. Remediation (after e; needs Application Default Credentials for staging):
```powershell
cd functions
node scripts/remediateStagingArvReturns.mjs --project vaxtrack-staging
# review the dry run, then (separately authorized):
node scripts/remediateStagingArvReturns.mjs --project vaxtrack-staging --apply --confirm VT-ORD-1791195696119-0YTC,VT-ORD-1791195833333-YVU3
```

## Rollback (reverse order: web → rules → functions → Rider)

1. **Web:** Netlify → Deploys → the previously published deploy → **Publish deploy**. Keep auto publishing locked.
2. **Rules:** Firebase Console → Firestore → Rules → history → ruleset
   `2e5ab805-17fc-4ae3-89e2-dd330e5431b0` → Restore → Publish. CLI equivalent:
   ```powershell
   New-Item -ItemType Directory -Force $env:TEMP\vt-rules-rollback | Out-Null
   Copy-Item deploy\staging-inventory-rollout\rollback-staging-firestore.rules.20261005T084832Z $env:TEMP\vt-rules-rollback\firestore.rules
   Set-Content -Encoding utf8 $env:TEMP\vt-rules-rollback\firebase.json '{"firestore":{"rules":"firestore.rules"}}'
   Push-Location $env:TEMP\vt-rules-rollback; firebase deploy --only firestore:rules --project vaxtrack-staging; Pop-Location
   ```
3. **Functions:**
   - Changed functions → route 100% traffic back to the revisions above:
     Google Cloud Console → Cloud Run → (service) → Revisions → Manage traffic.
     (With gcloud: `gcloud run services update-traffic createorderwithreservation --to-revisions=createorderwithreservation-00004-key=100 --region=asia-southeast1 --project=vaxtrack-staging`, likewise for the other four.)
   - New functions → delete:
     ```powershell
     firebase functions:delete addStockBatchWithAllocation reportDeliveryFailure confirmReturnDisposition requeueFailedOrder getReservationProvenance allocateOnInventoryWrite allocateOnOrderWrite continueAllocation settleClientReportedFailure rescheduleOrderDelivery --region asia-southeast1 --project staging --force
     ```
   - A traffic pin lasts until the next deploy; a permanent rollback is a
     redeploy of those functions from the source that built the revisions.
4. **Rider:** `adb -s <V2419_SERIAL> install -r -d ..\..\rider-rollback\app-staging-debug-1.0.0+1.apk`
5. **Indexes:** leave them (unused indexes are harmless).

### Not simply reversible (data written by the new code)
- Version-2 orders (backorders, partial reservations): old code has no allocator
  and no fully-reserved gate. Cancel or fully settle every open v2 order first.
- `returnPendingQuantity` / `quarantinedQuantity`: old code computes available as
  quantity − reserved, so these units would look available (oversell risk).
  Resolve every pending return and correct quarantined stock first.
- Reservations with status `returned`: old cancel refuses them
  (`reservation-already-settled`).
- Per-item VAT snapshots on new orders: stay; old invoice functions ignore them.
- The ARV remediation, once applied, has no automatic reverse.
After real v2 activity, prefer a roll-forward fix over a rollback.
