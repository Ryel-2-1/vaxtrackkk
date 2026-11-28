# VaxTrack — CLAUDE.md

Vaccine cold-chain ordering and delivery for the Philippines (client: 3MGS Pharma). Three web roles and a rider phone app, on Firebase.

**Current as of 2026-11-27** (branch `codex/ui-changes`, commit `3849dfa`). It describes the system as built. The chronological build log from July to September 2026 is archived in [`docs/CLAUDE-HISTORY.md`](docs/CLAUDE-HISTORY.md). That log is historical: many of its "deferred", "not built" and "do not" notes are now wrong. **Trust the code over any document**, this one included.

---

## Rules for working here

- **Never target production (`vaxtrack-bef1b`).** Run the Firebase CLI only with `--project vaxtrack-staging` or a `demo-vaxtrack-*` emulator project.
- **Deploys need explicit approval each time.** Staging is the reference environment. A new scheduled function (`onSchedule`) needs a separate decision before it goes to staging, because Cloud Scheduler costs money. All three current ones are on staging and production (`purgeRiderTrackingData` kept on staging and deployed to production on 2026-11-28); a full function deploy includes them.
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
- **Terms gate:** `TermsGate` wraps each role's area inside its route guard. Anyone who hasn't agreed to the current Terms of Use and Data Privacy Agreement (`services/termsAgreement.js`) sees only that screen until they agree, which writes the version and server time to their own `users/{uid}`. A read failure lets the portal through. Logging out anywhere goes through `LogoutConfirmation`.
- **Services** (`src/services/`, about 140 modules): pure models (`*Model.js`, `*View.js`) are separate from Firebase wrappers. Callable wrappers turn server refusals into `UserMessageError` subclasses that carry the server's stable `code`.
- **User-facing errors:** only a `UserMessageError`'s own text is ever shown, through `friendlyErrorMessage()` (`liveDataErrors.js`). That function also strips the Functions SDK's trailing ` [400]` (`withoutTransportStatus`). Everything else is mapped by error code. `tests/userMessages.test.js` enforces this.
- **Live data:** use `listenLive()` (it reconnects automatically). Edit forms use `useLiveDraft` + `StaleEditNotice`.
- **Order reads:** a new screen should not listen to the whole `orders` collection (every order ever placed, on every visit). Query what it shows, as Cargo Loading (`status in` assigned/loading) and the Delivery Calendar (`subscribeCalendarDeliveries`: the month grid plus open orders) do since 2026-11-14. The Admin and Dispatcher dashboards, Live Tracking and Geofence read only open orders (`subscribeOpenDeliveries`, `subscribeActiveTripDeliveries`, `subscribeRecentOrders`, server counts via `countOrderTotals`). **Still whole-collection, on purpose** (2026-11-15): Admin Deliveries (full history), Analytics (its Med Rep/Rider Performance offer "All time"), Riders (all-time on-time rate), Clinics (each clinic's last delivery), Dispatcher Shipments (Delivered/Cancelled tabs) and Invoices. Each needs either a server-maintained summary or server-side paging to narrow without changing what it shows; at current volume the cost is small, revisit at a few thousand orders.
- **Dashboards (2026-11-14):** each role leads with what needs action. Overdue-before-dispatch and the Med Rep follow-up rules live in `dashboardAttention.js`; the Med Rep bell counts only unread follow-up updates (tone `critical`), not every order.
- **Dialogs inside an Admin `<main>`** must portal through `AdminDialogLayer`. A transformed `<main>` traps fixed overlays, and `tests/adminDialogs.test.js` guards this.
- **Floating windows (2026-11-14):** `installFloatingWindows()` (`components/ui/floatingWindow.js`, started in `main.jsx`) makes every `role="dialog"` + `aria-modal="true"` window and alert dialog movable (drag the top 64 px), resizable (bottom-right corner) and recentrable (double-click the title band), with its last button row pinned. No per-dialog code. Side drawers are skipped, and it is off below 640 px wide.
- **Explanatory copy (2026-11-23):** page descriptions and "how this is calculated" notes sit behind an `InfoHint` (ⓘ, mouse/keyboard/touch), not as visible paragraphs. Admin page headers (`AdminLayout`) show the page description as "About this page".
- **CSS import order** (`main.jsx`): `index.css` → `styles.css` → `styles/tokens.css` → `meridian-shell.css` → `shell-transitions.css` → the role layers (`admin-polish`, `admin-foundation`, `salesrep-polish`, `dispatcher-polish`) → `paged-tables.css` → `dialog-fit.css` → `shell-chrome.css`.
  - Role layers are strictly scoped to that role's root and are additive only.
  - `!important` is used only to beat the global `button` / `input` `min-height: 46px !important` resets in `styles.css`.
  - Colours come from `tokens.css`.
- **Maps (2026-11-15): Google Maps** on every web map — the clinic pin picker with Places address search (Register Clinic, Manage location, doctor home, routing hub), Live Tracking, the delivery map and Dispatcher Geofence (`src/components/maps/`, `GooglePinPicker`, `GoogleFleetMap`, `GoogleRouteMap`). Needs `VITE_GOOGLE_MAPS_API_KEY` (+ `VITE_GOOGLE_MAPS_MAP_ID`; unset uses the dev-only `DEMO_MAP_ID`); restrict the key by referrer + Maps JavaScript API + Places API (New). Leaflet + OpenStreetMap remain ONLY as an invisible safety net (no key, `VITE_MAP_PROVIDER=osm`, or Google failing to load); users get no switch. Places search stores only coordinates (and the address if the Admin chooses) — Google's terms limit keeping Places coordinates, so have this reviewed before the client relies on it. The rider app still uses `flutter_map`/OpenStreetMap.
- **Routing:** Valhalla motorcycle profile, called from the browser on a keyless public endpoint (`VITE_MOTORCYCLE_ROUTING_URL`, default `valhalla1.openstreetmap.de`). Road flags are checked before a route is saved, with no car fallback. That endpoint is fair-use (FOSSGIS: at most 1 request/second, no availability guarantee; the app spaces requests 1.1 s apart). Decision 2026-11-09: keep it at current volume (about 8 plans a day, only on a Dispatcher's click); self-host if volume grows or outages disrupt delivery days. An outage only blocks planning new routes; saved routes keep working. Toll-free routing, detours and verified trip planning: see **Recent changes** below.

## Server authority (functions)

Clients cannot write anything that moves stock, money, status or access; the rules refuse it, and a callable does it.

| Area | Callables / triggers | Notes |
|---|---|---|
| Orders and stock | `createOrderWithReservation`, `cancelOrderWithInventoryRelease`, `markOrderDeliveredWithInventoryConsumption`, allocation triggers | Atomic reservation, allocation by priority, stock consumed exactly once. **A batch must expire after the delivery day** (2026-11-09): one expiring today can't be ordered (`batch-expires-today`), one expiring on or before the delivery date is refused (`batch-expires-before-delivery`) and never allocated, rescheduled onto, or edited onto. Orders already holding such stock still dispatch and deliver through the expiry day (`expiryGuard.js`). **A batch must also have arrived by the delivery day** (2026-11-13, `arrivesBy`): stock with a later `arrivalDate` is not reserved for an earlier delivery, so the order keeps waiting (checkout still works and warns); a reschedule before a reserved batch arrives is refused (`reserved-batch-arrives-later`) |
| Pricing | inside order creation | VAT-inclusive **integer centavos**. **Every batch price is entered with VAT included** (2026-11-11): Add Stock and re-pricing have no basis choice; the server and rules refuse `priceIsVatInclusive: false`. Batches stored before VAT keep that meaning when read, and re-pricing one pre-fills its with-VAT amount. A negotiated (agreed) price needs a reason. **SC/PWD discounts were withdrawn for new orders on 2026-11-03** (`statutory-discount-unavailable`); orders that already carry one keep it |
| Zero-rating | `requestZeroRateApproval`, `reviewZeroRateApproval` | Destination-based zero-rating policy still awaits business confirmation. There is no free toggle for Med Reps |
| Destinations | `correctOrderDestination`, `requestOrderDestinationChange`, `reviewOrderDestinationChange` | Doctor-first destinations (home or a linked clinic) |
| Requested arrival | inside order creation and reschedule (`requestedArrival.js`) | **No operating hours** since 2026-11-13: the old 7 AM–4 PM rule is gone and any time of day may be requested. A same-day request whose window has already passed is refused (`requested-arrival-passed`) |
| Dispatch and trips | `assignRiderToOrder`, `finalizeRiderDispatch`, `confirmRiderReturnToHub`, `rescheduleOrderDelivery` | Server-owned `riderDispatchStates` and `riderTrips`. `rescheduleOrderDelivery`: Admin in any open status; a Med Rep on their **own** order until the rider leaves (`pending_dispatch`, `assigned`, `loading`), with a required reason (2026-11-13) |
| Delivery completion | `validateDeliveryCompletionGeofence` + completion | Must be inside the clinic geofence, with accuracy ≤ 100 m and a fix ≤ 3 min old. A mock-location fix is refused (`rider-location-mocked`) |
| Offline completion | `submitOfflineDeliveryCompletion`, `resolveOfflineCompletionReview` | Accepted automatically within 3 h if it fits the clinic area and the rider's server trail; otherwise a dispatcher reviews it |
| Failures and returns | `reportDeliveryFailure`, `confirmReturnDisposition`, `requeueFailedOrder` | |
| Tracking | `trackRiderLocation`, `trackNavigationSession`, `syncRiderTrackingOnOrderWrite` | Deviation (500 m for 3 min), near destination and awaiting completion are all **decided on the server**. Trails are kept 4 h (TTL + purge) |
| Inventory | `addStockBatchWithAllocation`, `updateBatchMetadata`, `correctStockQuantity`, `voidInventoryBatch`, `removeUnusableStock`, `setVaccineArchived` | Each writes an `inventoryAuditEvents` entry. A batch quantity above 5,000 vials needs the Admin's confirmation (`largeQuantityConfirmed`, `large-quantity-unconfirmed`; `stockQuantityLimit.js`). Optional `lotNumber` (manufacturer's printed lot) and `supplier` (internal only, never on invoices) at Add Stock and in batch edits (2026-11-13); older batches show "Not recorded". `location` is optional in batch edits (2026-11-14; Add Stock never collects one) |
| Stock alerts | `reviewStockAlertsOnInventoryWrite`, `reviewStockAlertsOnConfigWrite`, `recheckStockAlerts` | `stock_low` (low or out) and `batch_expiry` (≤ 30 days, or expired). Admin-only. No threshold is invented: since the reorder settings were removed (2026-11-10), "low" fires only for an old `inventoryAnalyticsConfig` that still has a safety stock; "out" and expiry are unchanged |
| Inventory forecast | `inventoryAnalyticsRun.js`, `analyticsRisk.js`, `seasonality.js`, `functions/scripts/generateInventoryAnalytics.mjs` | Advisory only. Weighted 8-week average × a season factor: the same weeks last year once about 61 weeks of orders exist, else the Admin's busy months + % (`inventoryAnalyticsConfig {busyMonths, busyIncreasePercent}`, 0–300). Suggested order = what's needed to cover the next 30 days (shortage), no lead time or safety stock (removed 2026-11-10) |
| Invoices | `saveInvoiceDraftForPricedOrder`, `issueInvoiceForPricedOrder` | One invoice per order; transactional numbering. The invoice no longer prints SC/PWD rows. A draft save records each line's ACTUAL reserved/delivered lots (`invoiceLots.js`): the LN cell prints Lot Number (else Batch ID), with quantities when there are several, in the same Excel cell; export and issue wait for that save. Issued invoices are left as issued |
| Staff accounts | `createStaffAccount`, `createStaffSetupLink`, `getStaffEmailVerification`, `setStaffStatus`, `setStaffRole` | Staff role and status change only here. `getStaffEmailVerification` (Admin only, up to 10 uids per call, one Staff Directory page) returns just `emailVerified` and `lastSignInMs` from Auth. An admin can't change their own account, so there is always an approved admin. Changes are logged in `staffAccountEvents`. First admin of a new install: `functions/scripts/createFirstAdmin.mjs` |
| Delivery timing | `evaluateDeliveryTiming` (schedule, every 5 min) | Two separate facts: `timingStatus` is late against the ROUTE (dispatch + ETA + grace); `requestedArrivalMissedAt` is past what the Med Rep REQUESTED (`requestedArrivalOps.js`). The chip "Past requested arrival" replaces "On time" |
| Retention (scheduled) | `purgeRiderTrackingData` | Every 6 h (Manila), at most 300 docs per kind per run: deletes `riderLocations` idle 24 h, `riderLocationTrails` idle 4 h (backup to the `expireAt` TTL), ended navigation sessions/states after 24 h, and deviation events after 90 days (not those of a trip still navigating). Only the trail has a TTL, so without this job the rest piles up. **On staging (kept by decision 2026-11-28) and on production (deployed 2026-11-28).** `evaluateDeliveryTiming` and `reviewInventoryVisibility` went onto staging on 2026-11-05 |

Every callable goes through `callable()` in `functions/index.js`. It requires sign-in and maps a `PolicyError` code to an `HttpsError`, using the map in `toHttpsError`; a new code goes there. `tests/inventoryContract.test.js` pins the exact export list, so update it when adding a function. `functions/index.js` currently exports 56 functions, 3 of them scheduled (`reviewInventoryVisibility`, `evaluateDeliveryTiming`, `purgeRiderTrackingData`).

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

- **Clinic details (2026-11-25):** only an Admin edits an existing clinic's details (Clinics → `EditClinicDetailsModal`, validated by `services/clinicDetails.js`, which checks only the fields that changed so old, incomplete records can be repaired field by field). The master location (coordinates) is not changed by it and stays Admin-only through Manage location.
- **Rider profile photo (2026-11-15):** one object per rider at Storage `profile_photos/{uid}/photo.jpg`, written and removed only by that rider from the app (`profile_photo_service.dart`); the web shows it through `RiderAvatar` (Riders, Deliveries, Assign Rider, Cargo Loading).
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

## Recent changes (2026-11-27)

Merged into `main` and `production` on 2026-11-27 (web on Netlify; the rider app ships as an APK). Fold each part into the sections above over time.

### Verified motorcycle routes, ETA labels and clinic links

- **Highways yes, expressways/tolls no** (2026-11-27, `motorcycleRequest()`): `use_highways: 1` (national/trunk highways such as EDSA, MacArthur are usable), `use_tolls: 0`, plus `exclude_tolls`, `exclude_highways` (motorway class), `exclude_ferries`. The public server answers those with warning **208** ("hard exclusions … ignoring") but still returns toll-free routes; 208 is the one warning accepted, any other still fails closed, and the returned path's highway/toll/ferry flags are still checked before any save. `trace_attributes` uses the same costing without the exclusions. On NLEX/SLEX/CAVITEX test corridors this was 3–26 min faster than the old `use_highways: 0`; `use_highways` alone took the expressway. A trip that can't reach a stop names that stop in the error (`label` on `routeThroughStops` stops, `error.stopOrderId`).
- **Toll/highway detours** (`routeService.js`): when Valhalla returns a leg that uses a toll road, motorway or ferry, the app no longer just refuses. It reads the rejected leg's edges (`trace_attributes`), excludes points on those edges (`exclude_locations`, at most 48, up to 2 detour attempts) and asks again with `alternates: 2`. Every result still goes through the same road checks. Long trips are routed in sections of up to 10 locations; a multi-stop section that fails is retried leg by leg. New code `route-destination-toll` means the pin itself sits on a toll road (confirm a toll-free entrance). `route-restricted` now means no verified detour was found. A failing leg carries `legIndex`.
- **Bigger travel matrices:** `travelMatrix` splits `sources_to_targets` into requests of at most 100 location pairs and stitches the rows back together.
- **Plans use verified routes** (`timeAwareRouting.planVerifiedTrip`): Cargo Loading's departure planner and the Dispatcher Geofence re-plan try up to 3 suggested stop orders against real routes. A leg that fails is marked unusable for the next try, and arrival times come from the verified route's own leg times. The route that was verified is the one saved (`saveRoute(..., verifiedRoute)`), not fetched again. `planTrip` is still exported; only the System Explorer uses it now.
- **ETA labels** (web, rider app): `dispatchArrivalTime()` (`deliveryTiming.js`) / `dispatchEtaText()` (`delivery_timing.dart`) shows the server's `expectedArrivalAt` as **"ETA at dispatch"**, only while `in_transit` or `delayed`. Otherwise the label is **"Saved ETA"** (web) or **"Planned arrival"** (rider app) from `savedOrderRouteEta()` / `formatEta`, which prefers the saved `routeEtaText` clock time (it includes the departure chosen in Cargo Loading). The saved ETA is still shown alongside when it differs. Times are formatted in Asia/Manila on both web and Flutter.
- **Clinic access links** (`userService.updateMedRepClinicAccess`, used by `clinicAccessService.js`): linking or unlinking a Med Rep from a clinic now changes only that one clinic, using the territory as saved at transaction time, instead of rewriting the whole territory. Linking requires an approved Med Rep, a clinic with a verified pin and an active area (the clinic's area is added). Links to deleted areas or clinics are removed.
- **Doctor home address:** saving with no changes writes nothing (the rules require a changed field); every field error now shows in the form message.
- Tests updated: `motorcycleRouting`, `timeAwareRouting`, `deliveryTiming`, `departurePlanner`, `clinicAccess`, `doctorAddresses`, `requestedArrivalVisibility`, and Flutter `delivery_cards_test.dart`.

### System Explorer (local dev tool, untracked)

A local-only simulator that runs real VaxTrack business handlers against a Firestore emulator, to walk through scenarios (10-stop dispatch, stock shortage, conflicting time windows, GPS deviation, offline sync, delivery completion). It is not part of the normal Vite or Netlify builds.

- **Files:** `system-explorer.html`, `vite.system-explorer.config.mjs`, `firebase.system-explorer.json`, `src/components/dev/` (UI, fixtures, architecture graph) and `scripts/system-explorer/` (`api.mjs` Vite plugin = local HTTP bridge, `engine.mjs` calling the `functions/src` handlers with synthetic users, `smoke.mjs`, `README.md`).
- **Ports and project:** web at `http://127.0.0.1:5193/system-explorer.html`; Firestore emulator on 8293, project `demo-vaxtrack-explorer` (hub 4493, logging 4593). Never point it at staging or production.
- **Commands** (from `vaxtrack-web`): `npm run emulators:system-explorer`, then in a second window `npm run dev:system-explorer`; `npm run test:system-explorer` runs the smoke test while both are up.
- **What is real vs simulated:** Firestore transactions and listeners are real (emulator); writes go through the Admin SDK, so **security rules are not exercised** here (use `npm run test:rules` for that). Auth, App Check, callable transport and Storage uploads are shown but bypassed. The road matrix, GPS samples, proof metadata, multi-rider balancing, the weighted load centre and **temperature alerts are simulator models only**: cold-chain monitoring is still out of scope for the product.

## Open items (reviewed 2026-11-27)

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
5. **Scope decisions — closed (2026-11-15).** Rider rating is built (Admin → Rider Performance, `RiderPerformance.jsx`). Hub ranking, cold-chain monitoring, fleet-wide optimization, a destination-based zero-rating policy and a price floor are **not needed** — don't build them.
6. **Production rollout** (2026-11-09):
   - the old prototype database was backed up (`gs://vaxtrack-bef1b-backups-sg/pre-cleanup-20261109T0734Z`, also in `vaxtrack-bef1b-firestore-backups`), deleted, and recreated in `asia-southeast1`;
   - it is clean: one approved Admin, no other data. Staff are added through Add Staff; the 3MGS catalog and clients are imported later;
   - deployed on 2026-11-09: Storage bucket (`asia-southeast1`), Firestore indexes, 54 functions (not `purgeRiderTrackingData`), Firestore and Storage rules. **Re-synced with staging on 2026-11-27** from `codex/ui-changes` @ `3849dfa`: all 55 functions updated (still not `purgeRiderTrackingData`), and Firestore + Storage rules released (both were already identical to the repo, as on staging). **`purgeRiderTrackingData` added on 2026-11-28** (production now has all 56 functions);
   - web: https://vaxtrack-prod.netlify.app, a separate Netlify account, built from the `production` branch with `VAXTRACK_BUILD_MODE=production` (see `netlify.toml`; `scripts/checkBuildTarget.mjs` refuses a build pointed at the wrong project). Google Analytics is off in every build;
   - App Check: web registered (reCAPTCHA Enterprise key "VaxTrack production web"), enforcement off;
   - backups: daily managed Firestore backups kept 14 days, point-in-time recovery (7 days), delete protection on. Auth accounts and Storage photos are not in these backups;
   - rider app: production riders install a signed APK directly, never from Google Play (decision 2026-11-09). A sideloaded app can't pass Play Integrity, so the production build does not start App Check (`AppCheckAttestation.none`), and **App Check is not enforced in production** for Firestore, Storage or functions (riders would be locked out). Release key: `android/key.properties` + `vaxtrack-upload-keystore.jks`, both gitignored; losing them means updates can't install over the app. The production "Android key (auto created by Firebase)" only accepts the app signed with an allowed SHA-1: the release certificate `DA:12:91:09…` was added on 2026-11-09 (without it, sign-in fails with a generic "Sign in failed"). A new signing key needs its SHA-1 added there too.
