# VaxTrack — CLAUDE.md

Vaccine cold-chain ordering and delivery for the Philippines (client: 3MGS Pharma). Three web roles and a rider phone app, on Firebase.

**Current as of 2026-11-04** (branch `codex/ui-changes`, commit `e573146`). It describes the system as built. The chronological build log from July to September 2026 is archived in [`docs/CLAUDE-HISTORY.md`](docs/CLAUDE-HISTORY.md). That log is historical: many of its "deferred", "not built" and "do not" notes are now wrong. **Trust the code over any document**, this one included.

---

## Rules for working here

- **Never target production (`vaxtrack-bef1b`).** Run the Firebase CLI only with `--project vaxtrack-staging` or a `demo-vaxtrack-*` emulator project.
- **Deploys need explicit approval each time.** Staging is the reference environment. Scheduled functions (`onSchedule`) are **not** deployed to staging without a separate decision, because Cloud Scheduler costs money.
- **The user commits.** Don't commit, push, merge, reset or switch branches unless asked.
- **Emulator ports.** Emulator tests use port 8181. `emulators:exec` on Windows sometimes leaves the Java process running. Stop it only after checking that its command line contains `--project_id demo-vaxtrack-`.
- **Never print secrets or personal data.** `.env*` files are local-only; `.env.example` lists the keys.
- **Deploy order** when rules tighten a client write: functions first, then `firestore:rules`, then hosting. Triggers that retry need `--force` in non-interactive deploys. With `--only` naming the functions, that deletes nothing.

## Layout

| Path | What |
|---|---|
| `vaxtrack-web/` (this repo root) | React 18 + Vite web portal, the Firestore and Storage rules, and the tests |
| `vaxtrack-web/functions/` | Cloud Functions (Node 22, 2nd gen, `asia-southeast1`). **All business authority lives here.** |
| `../vaxtrack_mobile/` | Flutter rider app (same git repo, one level up) |

Roles: **Admin**, **Dispatcher** and **Med Rep** (stored as `salesrep`) use the web; **Rider** uses Flutter only. The web login blocks rider accounts.

## Web architecture

- **Routing:** `App.jsx` lazy-loads pages inside one persistent shell per role (`AdminShell`, `SalesRepShell`, `DispatcherLayout`). A page renders content only and registers inside its role's shell route; it never renders its own sidebar. Route guards are `AdminRoute`, `SalesRepRoute` and `DispatcherRoute`. They read `users/{uid}` after sign-in and fail closed on an unknown role or status.
- **Services** (`src/services/`, about 120 modules): pure models (`*Model.js`, `*View.js`) are separate from Firebase wrappers. Callable wrappers turn server refusals into `UserMessageError` subclasses that carry the server's stable `code`.
- **User-facing errors:** only a `UserMessageError`'s own text is ever shown, through `friendlyErrorMessage()` (`liveDataErrors.js`). That function also strips the Functions SDK's trailing ` [400]` (`withoutTransportStatus`). Everything else is mapped by error code. `tests/userMessages.test.js` enforces this.
- **Live data:** use `listenLive()` (it reconnects automatically). Edit forms use `useLiveDraft` + `StaleEditNotice`.
- **Dialogs inside an Admin `<main>`** must portal through `AdminDialogLayer`. A transformed `<main>` traps fixed overlays, and `tests/adminDialogs.test.js` guards this.
- **CSS import order** (`main.jsx`): `index.css` → `styles.css` → `styles/tokens.css` → `meridian-shell.css` → `shell-transitions.css` → the role layers (`admin-polish`, `admin-foundation`, `salesrep-polish`, `dispatcher-polish`) → `paged-tables.css` → `dialog-fit.css` → `shell-chrome.css`.
  - Role layers are strictly scoped to that role's root and are additive only.
  - `!important` is used only to beat the global `button` / `input` `min-height: 46px !important` resets in `styles.css`.
  - Colours come from `tokens.css`.
- **Maps:** Leaflet + OpenStreetMap tiles, no key.
- **Routing:** Valhalla motorcycle profile, called from the browser on a keyless public endpoint (`VITE_MOTORCYCLE_ROUTING_URL`, default `valhalla1.openstreetmap.de`). Road flags are checked before a route is saved, with no car fallback. That endpoint is fair-use (FOSSGIS: at most 1 request/second, no availability guarantee; the app spaces requests 1.1 s apart). Decision 2026-11-09: keep it at current volume (about 8 plans a day, only on a Dispatcher's click); self-host if volume grows or outages disrupt delivery days. An outage only blocks planning new routes; saved routes keep working.

## Server authority (functions)

Clients cannot write anything that moves stock, money, status or access; the rules refuse it, and a callable does it.

| Area | Callables / triggers | Notes |
|---|---|---|
| Orders and stock | `createOrderWithReservation`, `cancelOrderWithInventoryRelease`, `markOrderDeliveredWithInventoryConsumption`, allocation triggers | Atomic reservation, allocation by priority, stock consumed exactly once. **A batch must expire after the delivery day** (2026-11-09): one expiring today can't be ordered (`batch-expires-today`), one expiring on or before the delivery date is refused (`batch-expires-before-delivery`) and never allocated, rescheduled onto, or edited onto. Orders already holding such stock still dispatch and deliver through the expiry day (`expiryGuard.js`) |
| Pricing | inside order creation | VAT-inclusive **integer centavos**. **Every batch price is entered with VAT included** (2026-11-11): Add Stock and re-pricing have no basis choice; the server and rules refuse `priceIsVatInclusive: false`. Batches stored before VAT keep that meaning when read, and re-pricing one pre-fills its with-VAT amount. A negotiated (agreed) price needs a reason. **SC/PWD discounts were withdrawn for new orders on 2026-11-03** (`statutory-discount-unavailable`); orders that already carry one keep it |
| Zero-rating | `requestZeroRateApproval`, `reviewZeroRateApproval` | Destination-based zero-rating policy still awaits business confirmation. There is no free toggle for Med Reps |
| Destinations | `correctOrderDestination`, `requestOrderDestinationChange`, `reviewOrderDestinationChange` | Doctor-first destinations (home or a linked clinic) |
| Dispatch and trips | `assignRiderToOrder`, `finalizeRiderDispatch`, `confirmRiderReturnToHub`, `rescheduleOrderDelivery` | Server-owned `riderDispatchStates` and `riderTrips` |
| Delivery completion | `validateDeliveryCompletionGeofence` + completion | Must be inside the clinic geofence, with accuracy ≤ 100 m and a fix ≤ 3 min old. A mock-location fix is refused (`rider-location-mocked`) |
| Offline completion | `submitOfflineDeliveryCompletion`, `resolveOfflineCompletionReview` | Accepted automatically within 3 h if it fits the clinic area and the rider's server trail; otherwise a dispatcher reviews it |
| Failures and returns | `reportDeliveryFailure`, `confirmReturnDisposition`, `requeueFailedOrder` | |
| Tracking | `trackRiderLocation`, `trackNavigationSession`, `syncRiderTrackingOnOrderWrite` | Deviation (500 m for 3 min), near destination and awaiting completion are all **decided on the server**. Trails are kept 4 h (TTL + purge) |
| Inventory | `addStockBatchWithAllocation`, `updateBatchMetadata`, `correctStockQuantity`, `voidInventoryBatch`, `removeUnusableStock`, `setVaccineArchived` | Each writes an `inventoryAuditEvents` entry. A batch quantity above 5,000 vials needs the Admin's confirmation (`largeQuantityConfirmed`, `large-quantity-unconfirmed`; `stockQuantityLimit.js`) |
| Stock alerts | `reviewStockAlertsOnInventoryWrite`, `reviewStockAlertsOnConfigWrite`, `recheckStockAlerts` | `stock_low` (low or out) and `batch_expiry` (≤ 30 days, or expired). Admin-only. No threshold is invented: since the reorder settings were removed (2026-11-10), "low" fires only for an old `inventoryAnalyticsConfig` that still has a safety stock; "out" and expiry are unchanged |
| Inventory forecast | `inventoryAnalyticsRun.js`, `analyticsRisk.js`, `seasonality.js`, `functions/scripts/generateInventoryAnalytics.mjs` | Advisory only. Weighted 8-week average × a season factor: the same weeks last year once about 61 weeks of orders exist, else the Admin's busy months + % (`inventoryAnalyticsConfig {busyMonths, busyIncreasePercent}`, 0–300). Suggested order = what's needed to cover the next 30 days (shortage), no lead time or safety stock (removed 2026-11-10) |
| Invoices | `saveInvoiceDraftForPricedOrder`, `issueInvoiceForPricedOrder` | One invoice per order; transactional numbering. The invoice no longer prints SC/PWD rows |
| Staff accounts | `createStaffAccount`, `createStaffSetupLink`, `setStaffStatus`, `setStaffRole` | Staff role and status change only here. An admin can't change their own account, so there is always an approved admin. Changes are logged in `staffAccountEvents`. First admin of a new install: `functions/scripts/createFirstAdmin.mjs` |
| Delivery timing | `evaluateDeliveryTiming` (schedule, every 5 min) | Two separate facts: `timingStatus` is late against the ROUTE (dispatch + ETA + grace); `requestedArrivalMissedAt` is past what the Med Rep REQUESTED (`requestedArrivalOps.js`). The chip "Past requested arrival" replaces "On time" |
| Scheduled (not on staging) | `purgeRiderTrackingData` | Deploy only with explicit approval. `evaluateDeliveryTiming` and `reviewInventoryVisibility` went onto staging on 2026-11-05 |

Every callable goes through `callable()` in `functions/index.js`. It requires sign-in and maps a `PolicyError` code to an `HttpsError`, using the map in `toHttpsError`; a new code goes there. `tests/inventoryContract.test.js` pins the exact export list, so update it when adding a function.

## Data (Firestore)

- **`orders`** is the single source of truth for deliveries. There is **no** `deliveries` collection.
- **Statuses:** `pending_dispatch` → `assigned` → `loading` → `in_transit` → `delivered`, plus the branches `delayed`, `delivery_failed` and `cancelled`.
- **`users/{uid}`:**
  - `role` is `admin`, `dispatcher`, `salesrep` or `rider`;
  - `status` is `approved`, `pending`, `pending_approval`, `rejected` or `disabled`;
  - "Active" and "Inactive" are display labels only.
- **Other key collections:**

  | Area | Collections |
  |---|---|
  | Catalog and stock | `vaccines`, `inventory`, `inventoryReservations`, `inventoryAuditEvents` |
  | Clinics and doctors | `areas`, `clinics`, `doctors/{id}/deliveryAddresses` |
  | Orders and billing | `orderReceipts`, `orderHistory*`, `invoices`, `counters`, `zeroRateRequests` |
  | Alerts | `alerts` |
  | Rider tracking | `riderLocations`, `riderNavigationSessions`, `riderDispatchStates`, `riderTrips`, `riderLocationTrails` |
  | Accounts | `staffAccountEvents` |
  | Analytics | `inventoryAnalyticsConfig` |

- **Rules:** `firestore.rules` is deny-by-default, with per-role, per-field allowlists. Adding a client-written field means updating the allowlist and `tests/firestore.rules.test.js`.

## Rider app (Flutter, `../vaxtrack_mobile`)

- **Flavors:** `production` and `staging`. Entry points are `lib/main_production.dart` and `lib/main_staging.dart`. Staging installs as "VaxTrack Rider (Staging)".
- **Build:**
  ```
  flutter build apk --debug --flavor staging -t lib/main_staging.dart
  flutter build apk --release --flavor production -t lib/main_production.dart --split-per-abi
  ```
  Production riders get the `app-arm64-v8a-production-release.apk` (nearly all current phones; `armeabi-v7a` only for very old ones). The in-app Google Navigation SDK spike was removed on 2026-11-09; turn-by-turn hands off to the Google Maps app.
- **Structure:**
  - `lib/tracking/`: the tracking controller, write policy and contract;
  - `lib/offline/`: offline records, tied to the signed-in rider;
  - `lib/screens/`, `lib/widgets/`, `lib/services/`, `lib/utils/`.
- **Delivery decisions are the server's.** The app shows the saved route plan (`SavedRoutePlan`), and navigation moves to the next stop automatically.
- **Sign-up:** riders apply in the app with a password policy of 8+ characters, mixed case and a number.

## Commands

| What | Command |
|---|---|
| Dev server | `npm run dev -- --mode staging --port 5176` (the `vaxtrack-web-staging` entry in `.claude/launch.json`) |
| Web unit tests | `npm test` |
| Lint | `npm run lint` |
| Build | `npm run build:staging` |
| Firestore rules tests | `npm run test:rules` (emulator, `demo-vaxtrack-rules`) |
| Functions unit tests | `cd functions && npm test` |
| Functions integration tests | `cd functions && npm run test:emulator` (`demo-vaxtrack-functions`). A couple of concurrency tests sometimes fail with "Transaction is invalid or closed"; rerun that file alone |
| Flutter | `flutter analyze`, `flutter test` |

## Open items (2026-11-04)

1. **MOD-10** is done:
   - stock and expiry alerts;
   - rider push via FCM (`notifyRiderOnOrderWrite`, `riderPushTokens`, `lib/services/push_service.dart`);
   - the channel list.

   **SMS and email are out of scope** (decision, 2026-11-04). Don't build them.
2. **App Check:**
   - the web hook is wired (`VITE_APPCHECK_*`);
   - the rider app activates it in `lib/bootstrap.dart` (staging debug token through `--dart-define=APP_CHECK_DEBUG_TOKEN`; production does not start it, see item 6);
   - enforcement is controlled by `functions/.env.<projectId>` `ENFORCE_APP_CHECK` and is off;
   - the console registration hasn't been done.
3. **Field tests on a phone** with the current APK: offline completion, fake GPS, shared phones, the route screen, and a 15–20 minute locked-screen ride.
4. **Data:** production has users with a missing or invalid status.
5. **Scope decisions for the adviser:** hub ranking (recommend descoping), cold chain, rider rating, fleet-wide optimization, the zero-rating policy, the price floor.
6. **Production rollout** (2026-11-09):
   - the old prototype database was backed up (`gs://vaxtrack-bef1b-backups-sg/pre-cleanup-20261109T0734Z`, also in `vaxtrack-bef1b-firestore-backups`), deleted, and recreated in `asia-southeast1`;
   - it is clean: one approved Admin, no other data. Staff are added through Add Staff; the 3MGS catalog and clients are imported later;
   - deployed: Storage bucket (`asia-southeast1`), Firestore indexes, 54 functions (not `purgeRiderTrackingData`), Firestore and Storage rules;
   - web: https://vaxtrack-prod.netlify.app, a separate Netlify account, built from the `production` branch with `VAXTRACK_BUILD_MODE=production` (see `netlify.toml`; `scripts/checkBuildTarget.mjs` refuses a build pointed at the wrong project). Google Analytics is off in every build;
   - App Check: web registered (reCAPTCHA Enterprise key "VaxTrack production web"), enforcement off;
   - backups: daily managed Firestore backups kept 14 days, point-in-time recovery (7 days), delete protection on. Auth accounts and Storage photos are not in these backups;
   - rider app: production riders install a signed APK directly, never from Google Play (decision 2026-11-09). A sideloaded app can't pass Play Integrity, so the production build does not start App Check (`AppCheckAttestation.none`), and **App Check is not enforced in production** for Firestore, Storage or functions (riders would be locked out). Release key: `android/key.properties` + `vaxtrack-upload-keystore.jks`, both gitignored; losing them means updates can't install over the app. The production "Android key (auto created by Firebase)" only accepts the app signed with an allowed SHA-1: the release certificate `DA:12:91:09…` was added on 2026-11-09 (without it, sign-in fails with a generic "Sign in failed"). A new signing key needs its SHA-1 added there too.
