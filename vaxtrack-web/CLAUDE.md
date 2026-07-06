# VaxTrack Web — CLAUDE.md

## Project Overview

VaxTrack is a vaccine cold-chain logistics platform for the Philippines. This repository is the **React web portal only**.

## Architecture: Role Boundaries

| Role | Platform | Location |
|---|---|---|
| Admin | React Web (this repo) | `src/pages/admin/` |
| Sales Representative | React Web (this repo) | `src/pages/salesRep/` |
| Dispatcher | React Web (this repo) | `src/pages/dispatcher/` |
| Rider | **Flutter mobile app only** | Separate repo: `vaxtrack_mobile` |

**Rider is NOT part of this codebase.** Any React Rider files found in this repo are accidental and should be deleted. The web login page already blocks rider accounts (`"Rider accounts must use the VaxTrack mobile app."`).

## Tech Stack

- React 18 + Vite
- React Router v6 (BrowserRouter)
- Firebase: Auth, Firestore, Analytics
- Lucide React (icons)
- No UI framework — custom CSS per page

## Firebase Collections

| Collection | Status | Used By |
|---|---|---|
| `users` | Exists | Login, AdminRoute, Register, Settings (User Mgmt) |
| `vaccines` | Exists | AddVaccine, AddStock |
| `vaccineTypes` | Exists | AddVaccine |
| `inventory` | Exists | AddStock |
| `alerts` | Exists | alertService.js (unused by UI yet) |
| `orders` | Exists | orderService.js (SalesRep/Dispatcher) |
| `deliveries` | **Does not exist yet** | Deliveries.jsx (currently hardcoded) |
| `clinics` | Exists (created by Step 5) | Clinics.jsx |

## Firestore User Document Schema

```
users/{uid}
  role:   "admin" | "dispatcher" | "salesrep" | "rider"
  status: "approved" | "pending" | "pending_approval" | "rejected" | "disabled"
  email:  string
  employeeId: string (optional)
  name:   string
```

Status values must be consistent across Login.jsx, AdminRoute.jsx, and userService.js (when created). Do not write "active" or "inactive" as status — these are UI display labels only.

## Dev Server

```
npm run dev
```

The `.claude/launch.json` is configured to run Vite on port 5176 to avoid conflicts with other running Node processes.

---

## Completed Changes

### Phase 1 — Admin Audit (read-only)
- Audited all 12 admin pages, 2 service files, firebase.js, Login.jsx, App.jsx
- Identified: all admin pages except AddStock/AddVaccine use hardcoded data
- Identified: AdminSidebar lives inside Inventory.jsx (architectural smell, not yet fixed)
- Identified: missing service layer for inventory, deliveries, riders, clinics, users, alerts
- Identified: navigation bugs (missing /admin/ prefix in some navigate() calls)
- Identified: RegisterClinic.jsx form saves nothing to Firestore

### Phase 2 — Admin Route Protection ✅ CONFIRMED WORKING
Files changed:
- `src/components/AdminRoute.jsx` — **new file**
- `src/App.jsx` — all 12 admin routes wrapped in `<Route element={<AdminRoute />}>`

Behaviour:
- Unauthenticated → `/login`
- Pending/pending_approval → `/pending`
- Rejected/disabled → `/login`
- Wrong role (Dispatcher, SalesRep) → their correct dashboard
- Admin + approved → page renders
- Loading state returns `null` (no flash of protected content)

Runtime verified: all 9 tested admin routes redirect unauthenticated users to `/login`.

Known gap to fix later: `status: "inactive"` (used in Settings.jsx UI) is not blocked by AdminRoute or Login.jsx. Safe for now because Settings.jsx does not yet write to Firestore.

### Phase 3 Steps 1–3.5 ✅ CONFIRMED WORKING

**Step 1 — alertService.js + Alerts.jsx**
- `subscribeAllAlerts`, `resolveAlert`, `markAlertRead` added to alertService.js
- Alerts.jsx wired to Firestore; hardcoded data removed
- Confirmed: Firestore alerts appear, modal opens, Mark Resolved updates Firestore status, Mark Read updates read field

**Step 2 — userService.js + Settings.jsx User Management**
- `userService.js` created: `subscribeUsers`, `updateUserStatus`
- Settings.jsx User Management wired to Firestore `users` collection
- Status flow confirmed: pending → approved (Active) → disabled (Inactive) → approved (Active)
- Bug fixed: StaffDetailsModal was missing Reactivate button for inactive users

**Step 3 — inventoryService.js + Inventory.jsx**
- `inventoryService.js` created: `subscribeInventory`
- Inventory.jsx wired to Firestore; hardcoded vaccine array removed
- Real summary counts (Total / Critical / Warning / Stable) from live subscription
- Loading state + smart empty state added
- Navigation bugs fixed: AddVaccine + AddStock both navigated to `/inventory` → fixed to `/admin/inventory`
- Duplicate `<small>` temp helper in AddStock.jsx removed

**Step 6 — deliveryService.js + Deliveries.jsx ✅ CONFIRMED WORKING**
- `deliveryService.js` created: `subscribeDeliveries` listens on `orders` collection (no separate `deliveries` collection exists yet), client-side sort by `createdAt`, error callback
- Status normalization centralized in `deliveryService.js` with shared helpers: `normalizeStatusKey`, `getOrderStatusValue`, `mapOrderStatusLabel`, `mapOrderStatusType`
- `getOrderStatusValue` checks multiple field names: `status`, `orderStatus`, `deliveryStatus`, `shipmentStatus`, `dispatchStatus`
- Each order object from the service includes: `rawStatus` (original Firestore value), `statusKey` (normalized key), `statusLabel` (display text), `statusType` (CSS/filter category)
- Full status mapping: `pending`/`pending_dispatch`/`assigned`/`loading` → Loading, `in_transit` → In Transit, `delayed` → Delayed, `cancelled`/`canceled` → Cancelled, `completed`/`delivered` → Delivered
- Deliveries.jsx wired to Firestore; hardcoded `initialDeliveries` removed; `normalizeDelivery` maps service-computed fields to UI shape
- Summary cards show real counts; alert strip only appears when delayed deliveries exist; region filter populated dynamically
- "New Delivery" button shows notice (deliveries are created through Sales Rep → Dispatcher flow)
- All keys use `delivery.uid` (Firestore doc ID); loading/error/empty states added
- Detail modal shows vaccine name and quantity from order data
- Bug fixed: `status: "delayed"` not reflecting — root cause was direct `STATUS_MAP[raw.status]` lookup with no normalization and missing status keys; fixed by centralizing normalization in the service layer
- Firebase Analytics disabled during local development (`import.meta.env.PROD` guard in `firebase.js`); only initializes in production builds. Eliminates CSP errors from `firebase.googleapis.com`, `firebaseinstallations.googleapis.com`, `googletagmanager.com` during `npm run dev`
- **Firestore rules note:** Admin Deliveries uses the existing `orders` collection. During development, Firestore rules were temporarily updated to allow authenticated users to read/write orders so Admin Deliveries can subscribe. Before production deployment, these rules must be tightened so only approved admin/authorized roles can access the correct order operations.

**Step 7 — riderService.js + Riders.jsx ✅ CONFIRMED WORKING**
- `riderService.js` created: `subscribeRiders` queries `users` where `role == "rider"`, `updateRiderStatus` writes to `users/{uid}`
- Riders.jsx rewritten: hardcoded array removed; Firestore subscription is sole source of truth
- Status mapping: `approved`→Standby, `pending`/`pending_approval`→Pending Approval, `disabled`→Off Duty, `rejected`→Rejected
- Field mapping: `fullName||name||displayName||email`, `vehiclePlate||motorcycle||motorcycleId||vehicle`, `employeeId` for display ID only
- Rider lifecycle: pending→Approve/Reject, approved→Mark Off Duty, disabled→Set Available, rejected stays
- All keys use `rider.uid` (Firestore doc ID); duplicate key bug fixed
- "New Rider" shows notice about Firebase Auth requirement

**Step 4 — vaccineService.js + AddVaccine.jsx + AddStock.jsx**
- `vaccineService.js` created: `getVaccineTypes`, `addVaccineType`, `skuExists`, `addVaccine`, `getVaccines`, `batchIdExists`, `addStockBatch`
- AddVaccine.jsx and AddStock.jsx refactored to use service; all Firestore imports removed from components
- Confirmed: Add Vaccine saves, duplicate SKU blocked; Add Stock saves, duplicate Batch ID blocked; new stock appears in Inventory real-time

**Step 8 — AdminDashboard.jsx real counts ✅ CONFIRMED WORKING**
- Wired to 4 Firestore subscriptions: `subscribeDeliveries` (orders), `subscribeAllAlerts` (alerts), `subscribeRiders` (users), `subscribeInventory` (inventory)
- KPI cards show real counts: total orders, delayed/missing, critical stock, registered riders
- Recent alerts sidebar populated from Firestore alerts (unresolved, most recent 5)
- Trend percentages removed (no historical data to compute from); "Riders Online" renamed to "Registered Riders"
- Loading/error states added; `subscribeAllAlerts` and `subscribeInventory` wrapped in try/catch (no error callback in those services)

**Step 9 — Analytics.jsx ✅ CONFIRMED WORKING**
- No separate `analyticsService.js` needed — reuses `subscribeDeliveries` and `subscribeAllAlerts`
- Real data from Firestore:
  - Total Orders: count from `orders`, filtered by time range (7/30/90 days) and vaccine
  - Active Alerts: unresolved count from `alerts`
  - Completion Rate: `(delivered + completed) / total` from orders in range
  - Volume Chart: orders grouped by `createdAt` into day buckets (7d) or period buckets (30d/90d)
  - Vaccine Filter: dynamically populated from unique `vaccineName` values in orders
  - Heatmap: computed from order `createdAt` timestamps (day of week × morning/afternoon/evening)
  - AI Insight: semi-dynamic, references actual delayed order count
  - Region Distribution: computed from orders `region` field if present; graceful empty state if not
- Hardcoded sections kept (with reason):
  - Hub Performance Ranking: no `hubs` collection exists
  - Average Delivery Time: no dispatch/arrival timestamps on orders (shows "—" with explanation)
- "On-Time Rate" renamed to "Completion Rate" (honest label for delivered/completed ÷ total)
- Loading/error states added

**Step 3.5 — Inventory.jsx real-time overview sections**
- "Current Stock Overview" card: horizontal colored bar chart, total doses grouped by vaccineType, sorted highest-to-lowest, bars scaled to max quantity with per-type colors (blue/green/gold/red/purple). Matches Sales Rep Inventory graph style.
- "Critical & Expiring" card: shows critical-status batches + batches expiring within 30 days (up to 4), sorted soonest-first. Replaces the static Cold Storage card.
- Both sections powered by the existing `subscribeInventory` subscription (no new Firestore query needed).
- Known gap: batches with no `vaccineType` field appear under "Unknown" — not fixed, data quality issue in existing Firestore docs.

**Step 10 — Sales Rep Inventory wired to Firestore ✅ CONFIRMED WORKING**
- `SalesRepInventory.jsx` rewritten: all hardcoded `inventoryData` (10 fake items) and `vaccineTypes` array removed
- Subscribes to Firestore `inventory` collection via `subscribeInventory` from `inventoryService.js` — same data source as Admin Inventory
- `inventoryService.js` updated: `subscribeInventory` now accepts optional `onError` callback (backward compatible)
- `normalizeStock` maps Firestore fields to UI shape: `vaccineName`→name, `vaccineType`→type, `manufacturer`, `batchId`, `expiryDate`, `quantity`/`remainingQty`/`remainingQuantity`/`stock` (safe fallback chain), `temperature`/`storageTemp`, status derived from quantity thresholds
- Horizontal colored bar chart ("Available Stock by Vaccine Type"): groups by `vaccineType`, sums real quantities, bars scaled to max with per-type colors, shows dose counts (not percentages)
- Vaccine type tabs dynamically generated from Firestore data
- Metrics (Expiring ≤ 30 Days, Total Safe Stock, Cold-Chain Alerts) computed from real data
- Loading/error/empty states: spinner, permission-denied message, "No inventory data" notice
- Selection + "Request Selected" stores real batch data to localStorage, navigates to request-order
- Search, status filter, expiry filter, pagination all work with real data
- **Firestore rules required:** salesrep users need read access to `inventory` collection

**Step 11 — Sales Rep Request Order wired to Firestore ✅ CONFIRMED WORKING**
- `SalesRepRequestOrder.jsx` rewritten: hardcoded `productCatalog` (6 fake vaccines) removed
- Now subscribes to Firestore `inventory` via `subscribeInventory` — same data source as Admin/Sales Rep Inventory
- `normalizeProduct` maps Firestore fields to product card shape: `vaccineName`→name, `batchId`→sku, `vaccineType`→category, `quantity`→stock, `storageTemp`→temp (with smart °C suffix detection to avoid double °C)
- Reads `salesRepSelectedInventory` from localStorage on load and auto-adds pre-selected items to cart (from Inventory "Request Selected" flow)
- Search, stock filter ("All Products" / "In Stock Only"), quantity controls, cart add/remove all work with real data
- Loading/error states: spinner, permission-denied message
- Cart saves to `salesRepQuickCart` localStorage, navigates to Place Order page

**Step 12 — Sales Rep Place Order wired to Firestore ✅ CONFIRMED WORKING**
- `SalesRepPlaceOrder.jsx` rewritten: hardcoded `fallbackItems` (3 fake items), `unitPriceMap` (6 fake SKU prices), and `clinics` (3 hardcoded Manila clinics) all removed
- Reads cart items from `salesRepQuickCart` localStorage (written by Request Order page); empty cart shows dedicated state with "Browse Catalog" button
- Clinic dropdown wired to Firestore `clinics` collection via `subscribeClinics` from `clinicService.js`; loading state while clinics load; graceful empty state if no clinics exist
- Fake pricing section removed (unit prices, handling fee, urgent fee were not real); replaced with "Order Summary" showing vial count, item count, and priority
- `createSalesRepOrder` (already in `orderService.js`) saves to `orders` collection with `status: "pending_dispatch"`, `serverTimestamp()` for `createdAt`/`updatedAt`
- Fields written: `orderNumber`, `clinicName`, `clinicAddress`, `vaccineName`, `vaccineType`, `quantity`, `unit`, `storageTemp`, `priority`, `deliveryInstructions`, `items[]`, `createdByRole`, `createdByUid`, `createdByEmail`, `createdAt`, `updatedAt`
- Clears `salesRepQuickCart` from localStorage after successful order
- Admin Deliveries compatibility confirmed: new orders appear in Admin Deliveries with correct status mapping
- **Firestore rules required:** salesrep users need read access to `clinics` collection and write access to `orders` collection

**Step 13 — Sales Rep Order Tracking wired to Firestore ✅ CONFIRMED WORKING**
- `SalesRepOrderTracking.jsx` rewritten: hardcoded `defaultOrders` (4 fake orders), `loadLatestOrder` localStorage reader, and `formatCurrency` pricing all removed
- Subscribes to `subscribeSalesRepOrders(user.uid, ...)` — shows only orders created by the logged-in Sales Rep
- Reuses `normalizeStatusKey` and `getOrderStatusValue` from `deliveryService.js`; custom `mapTrackingLabel` for Sales Rep display labels
- `statusProgress` maps each status to a progress percentage (15–100%)
- Active/History tabs: delivered/completed/cancelled = history, everything else = active
- Sidebar shows order details, rider info, vaccine items, delivery instructions, total quantity
- Removed fake pricing section; replaced with total quantity display
- Loading/error/empty states; search by order ID, clinic, vaccine, or status

**Step 14 — Sales Rep Dashboard wired to Firestore ✅ CONFIRMED WORKING**
- `SalesRepDashboard.jsx` rewritten: hardcoded `inventoryRows` (12 fake vaccines), `requestRows` (3 fake orders), `trackingRows` (3 fake tracking), `quickActions` with `<a href>` all removed
- Subscribes to `subscribeSalesRepOrders(user.uid, ...)` and `subscribeInventory`
- KPI cards: Total Orders, Pending Dispatch, Delivered, In Transit — all real counts from Firestore
- Inventory table: real Firestore batches with computed status from quantity/expiry
- My Order Requests: latest 3 real orders; Recent Activity: latest 3 orders
- Order Tracking Preview: latest 3 active (non-delivered/cancelled) orders
- Quick Actions converted from `<a href>` to `<button onClick={() => navigate(route)}>` for SPA navigation
- "Place Order" routes to `/sales-rep/request-order` (catalog) not `/sales-rep/place-order` (checkout)
- Loading state shows spinner while both subscriptions load

**Step 15 — Sales Rep Alerts wired to Firestore ✅ CONFIRMED WORKING**
- `SalesRepAlerts.jsx` rewritten: hardcoded `initialActiveAlerts` (4 fake alerts) and `initialHistoryAlerts` (3 fake resolved alerts) all removed
- Subscribes to `subscribeSalesRepOrders(user.uid, ...)` — derives alert-like entries from order statuses
- Alert mapping: `delayed`→Critical, `cancelled`→Critical, `assigned`→Update, `in_transit`→Update, `delivered/completed`→Delivered, `pending/pending_dispatch`→Pending, `loading`→Update
- Active tab shows non-terminal orders (pending, assigned, loading, in_transit, delayed); History tab shows terminal orders (delivered, completed, cancelled)
- Filters: All, Critical, Updates (active tab); adds Delivered filter on history tab
- Search by order ID, title, body text, or clinic name
- Detail modal shows severity, priority, clinic, time, vaccine, quantity
- Success tone CSS added for delivered/completed alert cards (green border, icon, badge)
- Loading/error/empty states; no hardcoded alerts remain

**Step 16 — Sales Rep Settings wired to Firestore ✅ CONFIRMED WORKING**
- `SalesRepSettings.jsx` completely rewritten: was a duplicate of old SalesRepAlerts code with 7 hardcoded alerts — replaced with a real profile/settings page
- Loads user profile from Firestore `users/{uid}` via `getUserProfile` (new function in `userService.js`)
- Displays real data: name, email, phone, organization, role, status, employeeId, UID
- Editable fields: name, phone/contactNumber, organization — saved via `updateUserProfile` (new function in `userService.js`)
- Protected fields (read-only): role, status, employeeId, email, UID — with note "managed by your administrator"
- `userService.js` updated: added `getUserProfile(uid)` (getDoc), `updateUserProfile(uid, profileData)` with whitelist of editable fields
- Status display labels: approved→Active, pending/pending_approval→Pending Approval, disabled→Inactive, rejected→Rejected
- Role display labels: salesrep→Sales Representative, admin→Administrator, dispatcher→Dispatcher, rider→Rider
- Save button disabled when no changes detected; loading/saving spinners; success/error toast messages
- Field fallback chain: `name||fullName||displayName`, `phone||contactNumber`, `organization||company||clinic`
- CSS: added `.settings-page-header`, `.settings-field`, `.settings-save-btn`, `.settings-detail-row`, `.settings-status.*`, `.settings-uid`, `.settings-readonly-note`
- Loading/error states; no hardcoded data remains

---

**Step 17 — Dispatcher Dashboard + Assign Rider wired to Firestore ✅ CONFIRMED WORKING**
- `DispatcherDashboard.jsx` rewritten: hardcoded `mockOrders` (3 fake orders) removed; hardcoded KPI values (`availableRiders=12`, `activeDeliveries=8`, `delayedDeliveries=2`) removed
- Subscribes to 4 Firestore sources: `subscribePendingDispatchOrders` (pending orders table), `subscribeDeliveries` (all orders for active/delayed counts), `subscribeRiders` (available rider count), `subscribeActiveAlerts` (alert banner)
- KPI cards show real counts: Pending Orders, Available Riders (approved status), Active Deliveries (assigned/in_transit/loading), Urgent Orders + delayed count
- Pending Dispatch Queue table shows only `pending_dispatch` orders from Firestore; empty state when no orders pending
- Operation Summary sidebar uses real counts with dynamic text
- Map monitor footer shows real pending/rider counts instead of hardcoded values
- Loading state with spinner; error banner for data load failures
- `DispatcherAssignRider.jsx` rewritten: hardcoded `riders` array (3 fake riders) removed
- Subscribes to `subscribeRiders` from `riderService.js`; shows approved riders as available, others as unavailable with status labels
- Rider fields mapped: `fullName||name||displayName||email`, `vehiclePlate||motorcycle||motorcycleId||vehicle`, `phone||contactNumber`, `employeeId`
- Order details panel reads from localStorage (set by Dashboard's "Assign Rider" button); shows real order data (vaccine, quantity, clinic, address, instructions, priority)
- `assignRiderToOrder` in `orderService.js` updated: now accepts optional `dispatcher` param to write `assignedByUid`, `assignedByEmail`; also writes `assignedRiderPhone` if available
- On successful assignment: clears localStorage, shows success toast, redirects to Dashboard after 1.2s
- Confirm Assignment button disabled when no rider selected or no order data
- Loading/error/empty states for rider list; error toast for failed assignments
- CSS: added `.dispatcher-loading-state`, `.dispatcher-empty-queue`, `.unavailable-riders-heading`, `.rider-phone`, `.alerts-v2-toast.error`
- **Firestore rules note:** dispatcher users need read access to `orders`, `users` (riders), and `alerts` collections, plus write access to `orders` for assignment updates
- **Manual test confirmed 2026-07-02:** Sales Rep order appears in Dispatcher Dashboard → Dispatcher assigns rider → order status changes to `assigned` → assigned order reflects across all three roles (Dispatcher, Admin Deliveries, Sales Rep Order Tracking)

**Step 18 — Dispatcher Shipments / Cargo Loading Queue wired to Firestore ✅ CONFIRMED WORKING**
- `DispatcherShipments.jsx` rewritten: hardcoded `pendingLoads` (2 fake loads), hardcoded in-progress cards (2 fake), hardcoded logistics efficiency stats all removed
- Subscribes to `subscribeDeliveries` from `deliveryService.js` — shows all orders with real-time status
- Filter bar: Active (assigned+loading+in_transit+delayed), Assigned, Loading, In Transit, Delayed, Delivered, Cancelled — all with real counts
- Queue Status bar shows real proportional segments (active/delivered/cancelled)
- Shipment Summary sidebar shows real counts per status category
- Status update actions wired to Firestore via `updateOrderStatus` (new function in `orderService.js`):
  - assigned → Start Loading / Mark Delayed / Cancel
  - loading → Dispatch / Mark Delayed / Cancel
  - in_transit → Mark Delivered / Mark Delayed / Cancel
  - delayed → Resume Transit / Cancel
- `updateOrderStatus` writes: `status`, `updatedAt`, `statusUpdatedAt`, `statusUpdatedByUid`, `statusUpdatedByEmail`; plus `deliveredAt` for delivered, `delayedAt` for delayed, `startedAt` for in_transit, `cancelledAt` for cancelled, `cancelReason` if provided
- Preserves all assigned rider fields (assignedRiderId, assignedRiderName, etc.)
- Shipment cards show: order number, vaccine name, clinic, quantity, rider name/phone, priority tag, status tag with color coding
- Terminal orders (delivered/cancelled) show with reduced opacity, no action buttons
- Loading/error/empty states; toast notifications for status updates
- CSS: added `.shipments-filter-bar`, `.shipment-filter-btn`, `.shipment-card-v2` with status color variants, `.status-tag.*`, `.shipment-actions-row`, `.shipment-action-btn` with tone variants
- **Manual test confirmed 2026-07-06:** Sales Rep order → Dispatcher assigns rider → order appears in Shipments as Assigned → Start Loading → Dispatch → Mark Delivered. Status changes reflect across Dispatcher, Admin Deliveries, and Sales Rep Order Tracking in real time. Firestore remains single source of truth.

**Step 19 — Dispatcher Live Monitoring / Geofence wired to Firestore ✅ CONFIRMED WORKING**
- `DispatcherGeofence.jsx` rewritten from scratch (previously 100% mock data)
- Removed hardcoded: rider "Juan Dela Cruz", delivery ID "TRK-9824", batch "PFZ-2023-A01", location "Quezon City (GPS Unverified)", "1.2km from Planned Route", fake destinations, ETA/coldChain/nextArrival/criticalDelay, all mock timeline entries, all fake map roads/routes/checkpoints/geofence shape, zoom/layer/refresh controls
- Subscribes to `subscribeDeliveries` from `deliveryService.js` — filters to active statuses: assigned, loading, in_transit, delayed
- Left panel: "Active Shipments (N)" list with real orderNumber, clinicName, assignedRiderName, and status pill per order; clicking selects
- Right panel: shipment detail card with real rider name/phone, order + vaccine + quantity + unit, priority, destination + clinicAddress, live location, last status update
- Live Location fallback: if `lastLocation` (GeoPoint) is null, shows "No live location yet — Waiting for Rider mobile app location update." No fake coordinates, no fake route paths
- Info banner explains: "Live GPS tracking not yet active. Map view, geofence, and route deviation detection will activate once the Rider mobile app begins sending location updates."
- Loading/error/empty states added; error state distinguishes permission-denied from generic load failure
- CSS: added `.geo3-info-banner`, `.geo3-order-list`, `.geo3-order-item` (with `.active` state), `.geo3-status-pill` (with assigned/loading/transit/delayed tones), `.geo3-badge` (same tones), `.geo3-muted`
- No maps/GPS/route optimization/geofence logic implemented yet — deferred until Rider mobile begins writing `lastLocation`
- **Manual test confirmed 2026-07-06:** Dispatcher opens Geofence → sees 7 real active shipments (IN TRANSIT, DELAYED) with real rider names, real clinics, real vaccine quantities. "No live location yet" fallback works. No mock data remains.

**Step 20 — Dispatcher Final QA Pass ✅ CONFIRMED WORKING**
- Full inspection of all Dispatcher pages + supporting services confirmed:
  - No hardcoded/mock shipment/order/rider/GPS data in completed pages
  - All 4 completed pages (Dashboard, Assign Rider, Shipments, Geofence) subscribe to Firestore and treat it as the sole source of truth
  - Status normalization is centralized in `deliveryService.normalizeStatusKey` — consistent across Dashboard/Shipments/Geofence
  - Loading/error/empty states present on every completed page; permission-denied is distinguished from generic load failure
  - No `console.log`/`debugger`/`TODO`/`FIXME` in completed pages (only legitimate `console.error` in subscription error callbacks)
- **Round 1 fix:** Dashboard hardcoded `Cold-chain Status: Stable` MonitorInfo replaced with real `Delayed Routes: {delayedDeliveries} delayed` count
- **Round 2 fixes:** removed 3 unused Lucide imports — `MapPin` (Dashboard), `Filter` (Shipments), `CheckCircle2` (Geofence)
- **Manual test confirmed 2026-07-06:** All completed Dispatcher pages Firestore-backed, no hardcoded data, status flow consistent, build passed

## Dispatcher Role — PHASE COMPLETE ✅

All 4 primary Dispatcher pages are Firestore-backed. Manual testing confirmed on 2026-07-06.

| Page | Status | Data Source |
|---|---|---|
| Dashboard | ✅ Complete | `orders` + `users` (riders) + `alerts` |
| Assign Rider | ✅ Complete | `users` (riders); writes to `orders` |
| Shipments / Cargo Loading Queue | ✅ Complete | `orders`; writes status updates |
| Geofence / Live Monitoring | ✅ Complete | `orders` (active statuses); `lastLocation` fallback |
| Settings | ⚠️ Deferred | Still hardcoded profile/preferences (localStorage only) |

**Confirmed working end-to-end:**
1. Sales Rep places order → Dispatcher Dashboard shows in Pending Dispatch Queue
2. Dispatcher assigns rider → status: assigned; reflects on Admin Deliveries + Sales Rep Order Tracking
3. Dispatcher Shipments → Start Loading → Dispatch → Mark Delivered; each transition writes audit fields and syncs across all roles
4. Dispatcher Geofence shows only active orders (assigned/loading/in_transit/delayed) with real rider/clinic/vaccine data
5. "No live location yet" fallback works when `lastLocation` is absent
6. All statuses (pending_dispatch/assigned/loading/in_transit/delayed/delivered/completed/cancelled/canceled) normalized consistently

**Deferred (not required for Dispatcher phase completion):**
- DispatcherSettings.jsx — hardcoded profile; can be wired later like SalesRepSettings using `getUserProfile`/`updateUserProfile`
- Real GPS/map/geofence/route deviation — requires Flutter Rider `lastLocation` writes first
- Decorative "Metro Manila Delivery Network" CSS art on Dashboard — pure visual dressing, no fake numeric data

---

## Flutter Rider — Registration / Approval / Login ✅ CONFIRMED WORKING (2026-07-07)

Rider mobile app lives in the separate `vaxtrack_mobile` repo (structured lib/: models, screens, services, theme). Full registration → admin approval → login cycle manually tested and confirmed.

**Registration (Flutter):**
- `RegisterScreen` → `AuthService.registerRider()` creates the Firebase Auth account, then writes Firestore `users/{uid}` (doc ID = Auth UID) with: `role: "rider"`, `status: "pending"`, `fullName`, `email`, `phone`, `vehiclePlate`, `createdAt`, `updatedAt`
- Signs out after registration; success screen: "Rider application submitted. Please wait for admin approval."
- 30s timeouts on Auth create + Firestore write; mapped error messages (email-already-in-use, weak-password, invalid-email, network, operation-not-allowed, permission-denied); Auth account deleted if the Firestore write fails so the email stays reusable
- **AuthGate registration race fixed:** creating the Auth account fires `authStateChanges`; AuthGate previously loaded the new pending profile and signed out mid-write, corrupting registration. Fixed with `AuthService.registrationInProgress` flag — AuthGate stays passive (spinner, no profile load, no sign-out) while registration runs

**Login (Flutter):**
- LoginScreen only performs Firebase Auth sign-in; role/status validation is centralized in AuthGate (root `home` widget)
- `AppUser.fromFirestore` normalizes: `role`/`status` are `trim().toLowerCase()`; approved rider condition is `role == "rider" && status == "approved"`
- Blocked states surface via `AuthService.pendingLoginMessage` (set by AuthGate before signOut, displayed by the next LoginScreen mount): pending → "pending admin approval", disabled/rejected → "not active", non-rider → "riders only, use web portal", missing doc → "Rider profile not found", Firestore permission-denied → "check Firestore rules"
- **Navigation stack bug fixed:** register-success and logout previously pushed `/login` as a route on top of (or replacing) AuthGate, so a successful sign-in never became visible. Now all flows return to root `'/'` (AuthGate decides); LoginScreen pops to root after sign-in

**Admin Riders (web) compatibility:**
- `riderService.subscribeRiders` now subscribes to the whole `users` collection and filters client-side with normalized role check (`trim().toLowerCase() === "rider"`) — the old exact-match `where("role", "==", "rider")` silently missed docs with case/whitespace role variants
- Pending riders appear as "Pending Approval" with Approve/Reject in the details modal; `updateRiderStatus` writes `approved`/`rejected` to `users/{uid}`
- Known data-quality note: two legacy corrupt docs exist from the old monolithic app's signup (`role: "pending"` on test321@gmail.com, `role: "staff"` on rider@email.com) — invisible to rider lists by design; clean up in Firebase Console when convenient

**Confirmed end-to-end (manual + emulator):** register in Flutter → pending rider appears in Admin Riders → Admin approves → rider logs in → Rider Dashboard opens (with location permission flow). Temporary debug logs removed after confirmation; `flutter analyze` passes with 0 issues.

**Firestore rules needed for rider (report, not yet deployed):**
- Rider can `create` own `users/{uid}` only with `role == "rider"` and `status == "pending"`
- Rider can read/update own doc; cannot approve self
- Admin (approved) can read/update rider users for approval

---

## Sales Rep Role — PHASE COMPLETE ✅

All 7 Sales Rep pages are now Firestore-backed. Manual testing confirmed on 2026-07-02.

| Page | Status | Data Source |
|---|---|---|
| Dashboard | ✅ Complete | `orders` (user-filtered) + `inventory` |
| Inventory | ✅ Complete | `inventory` collection |
| Request Order | ✅ Complete | `inventory` collection |
| Place Order | ✅ Complete | `clinics` + writes to `orders` |
| Order Tracking | ✅ Complete | `orders` (user-filtered) |
| Alerts | ✅ Complete | `orders` (user-filtered, derived alerts) |
| Settings | ✅ Complete | `users/{uid}` (read + profile update) |

**Confirmed working end-to-end:**
1. Dashboard — KPIs, inventory table, order requests, tracking preview, quick actions all Firestore-backed
2. Inventory — real batches with quantity/expiry status, horizontal bar chart by vaccine type
3. Request Order — real inventory catalog, cart flow, pre-selection from Inventory page
4. Place Order — real clinics dropdown, order saves to `orders` with `status: "pending_dispatch"`
5. Order Tracking — real orders filtered by `createdByUid`, active/history tabs, progress bars
6. Alerts — derived from order statuses (delayed→Critical, cancelled→Critical, assigned/in_transit→Update, delivered→Delivered)
7. Settings — real profile from `users/{uid}`, editable name/phone/organization, read-only role/status/employeeId
8. Quick Actions navigate correctly (SPA navigation, not full page reload)
9. Sales Rep-created orders reflect on Admin Deliveries with correct status mapping

**Deferred (UI polish, not functional):**
- SalesRepLayout sidebar notifications are still hardcoded (cosmetic)
- Responsive/mobile polish
- Any remaining CSS inconsistencies across pages

---

## Current Focus: Phase 3 — Admin Service Layer

All admin pages except AddStock and AddVaccine run on hardcoded demo data. The goal is to replace that data with real Firestore reads/writes through a clean service layer.

### Service Files Plan

| File | Status | Serves |
|---|---|---|
| `src/services/alertService.js` | ✅ Complete | Alerts.jsx, AdminDashboard.jsx, Analytics.jsx |
| `src/services/orderService.js` | ✅ Complete | SalesRepPlaceOrder.jsx, SalesRepOrderTracking.jsx, SalesRepDashboard.jsx, SalesRepAlerts.jsx, Dispatcher |
| `src/services/inventoryService.js` | ✅ Complete | Inventory.jsx, SalesRepInventory.jsx, SalesRepRequestOrder.jsx, AdminDashboard.jsx |
| `src/services/userService.js` | ✅ Complete | Settings.jsx (User Management tab), SalesRepSettings.jsx |
| `src/services/vaccineService.js` | ✅ Complete | AddVaccine.jsx, AddStock.jsx |
| `src/services/deliveryService.js` | ✅ Complete | Deliveries.jsx, AdminDashboard.jsx, Analytics.jsx, SalesRepOrderTracking.jsx, SalesRepAlerts.jsx |
| `src/services/riderService.js` | ✅ Complete | Riders.jsx, AdminDashboard.jsx |
| `src/services/clinicService.js` | ✅ Complete | Clinics.jsx, SalesRepPlaceOrder.jsx |

### Implementation Order

1. Expand `alertService.js` + wire `Alerts.jsx` ✅ COMPLETE
2. `userService.js` + wire Settings.jsx User Management ✅ COMPLETE (bug fix: added Reactivate to modal + try/catch on updateStatus)
3. `inventoryService.js` + wire `Inventory.jsx` ✅ COMPLETE
4. `vaccineService.js` + refactor `AddVaccine.jsx` + `AddStock.jsx` ✅ COMPLETE
5. `clinicService.js` + wire `Clinics.jsx` ✅ COMPLETE
6. `deliveryService.js` + wire `Deliveries.jsx` ✅ COMPLETE
7. `riderService.js` + wire `Riders.jsx` (reads + status updates only) ✅ COMPLETE
8. Wire `AdminDashboard.jsx` real counts (depends on steps 1–7) ✅ COMPLETE
9. `Analytics.jsx` wired to Firestore ✅ COMPLETE

### Deferred Items (do not implement yet)

- "New Rider" Firestore write — requires Firebase Auth account creation first, not a simple addDoc
- `settingsService.js` — org profile / feature toggles have no downstream effect yet
- AdminSidebar extraction from Inventory.jsx — architectural cleanup, not urgent
- Firestore rules: salesrep users need `inventory` collection read access for Sales Rep Inventory to work

### Alerts.jsx Architecture Decisions

- `alertService.js` handles Firestore only — no UI logic
- `Alerts.jsx` keeps all UI, modal, and filter logic inline — do not split yet
- Future cleanup phase (separate session) may extract:
  - `AlertDetailsModal.jsx`
  - `AlertCard.jsx`
  - `utils/formatRelativeTime.js`

---

## Known Issues / Navigation Bugs (not yet fixed)

These exist in the codebase but have not been addressed:

| File | Bug |
|---|---|
| `AddStock.jsx` | `navigate("/inventory")` → ✅ fixed `/admin/inventory` |
| `AddVaccine.jsx` | `navigate("/inventory")` → ✅ fixed `/admin/inventory` |
| `RegisterClinic.jsx` | `navigate("/clinic-success")` should be `/admin/clinic-success` |
| `ClinicSuccess.jsx` | navigates to `/clinics` and `/register-clinic` — missing `/admin/` prefix |
| `Clinics.jsx` | `window.location.href = "/login"` should use `navigate("/login")` |

## Files Safe to Delete (not yet deleted)

- `src/pages/rider/` — all files (already staged for deletion in git, not imported anywhere)
- `src/pages/admin/RegisterClinic.jsx` — redundant with Clinics.jsx inline modal; form saves nothing
- `src/pages/admin/ClinicSuccess.jsx` — hardcoded, only reachable from dead RegisterClinic flow

## Test Accounts Needed

The following Firestore test users do not exist yet. When creating them in Firebase Console, the `users/{uid}` document must have:

- **Sales Representative:** `role: "salesrep"`, `status: "approved"`
- **Dispatcher:** `role: "dispatcher"`, `status: "approved"`
- **Rider:** `role: "rider"`, `status: "approved"` — for testing web login block only; actual rider usage is Flutter

## AdminSidebar Note

`AdminSidebar` is exported from `src/pages/admin/Inventory.jsx` and imported by all other admin pages. This is a known architectural smell. Do not move it until the service layer is complete, to avoid merge conflicts during active development.
