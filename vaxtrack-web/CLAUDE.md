# VaxTrack Web — CLAUDE.md

## Project Overview

VaxTrack is a vaccine cold-chain logistics platform for the Philippines. This repository is the **React web portal only**.

## Architecture: Role Boundaries

| Role | Platform | Location |
|---|---|---|
| Admin | React Web (this repo) | `src/pages/admin/` |
| Sales Representative | React Web (this repo) | `src/pages/salesRep/` |
| Dispatcher | React Web (this repo) | `src/pages/dispatcher/` |
| Rider | **Flutter mobile app only** | Sibling folder `vaxtrack_mobile/` (same git repo, one level up) |

**Rider is NOT part of this codebase.** Any React Rider files found in this repo are accidental and should be deleted. The web login page already blocks rider accounts (`"Rider accounts must use the VaxTrack mobile app."`).

## Tech Stack

- React 18 + Vite
- React Router v6 (BrowserRouter)
- Firebase: Auth, Firestore, Analytics
- Lucide React (icons)
- No UI framework — custom CSS per page

## Firebase Collections (source of truth)

| Collection | Status | Used By |
|---|---|---|
| `users` | Exists | Login, route guards, Register, Settings (User Mgmt), Riders, Flutter Rider auth/profile |
| `vaccines` | Exists | AddVaccine, AddStock |
| `vaccineTypes` | Exists | AddVaccine |
| `inventory` | Exists | Admin Inventory, AddStock, Sales Rep Inventory/Request Order |
| `alerts` | Exists | Admin Alerts, AdminDashboard, Dispatcher Dashboard, Analytics |
| `orders` | Exists | **Single source of truth for deliveries.** Admin Deliveries/Analytics, Sales Rep (create + own-order tracking), Dispatcher (assign + status updates + cargo loading), Flutter Rider (assigned orders) |
| `clinics` | Exists | Admin Clinics, Sales Rep Place Order |
| `invoices` | Exists (pulled Invoices module) | Admin Invoices/InvoiceEditor via invoiceService.js |
| `counters` | Exists (pulled Invoices module) | Transactional invoice numbering (`counters/invoice_{year}`) |

There is **no `deliveries` collection** — never create one; everything delivery-related lives on `orders`.

**Canonical order status values:** `pending_dispatch` → `assigned` → `loading` → `in_transit` → `delivered` (terminal), with branches `delayed` (recoverable) and `cancelled` (terminal). Legacy variants `completed` and `canceled` are accepted on read via `deliveryService.normalizeStatusKey` but never written. Do not introduce new statuses (e.g. `picked_up` was rejected during the Rider merge).

**Companion docs:** `docs/VaxTrack-Test-Case-Tracker.md` (full-system, 123 cases), `docs/VaxTrack-Admin-Test-Case-Tracker.md`, `docs/VaxTrack-Maps-Routing-Plan.md`. A production Firestore rules plan was drafted in-session (2026-07-11) — key open questions: Employee-ID login does an unauthenticated `users` query, and dispatchers currently read the whole `users` collection.

## Firestore User Document Schema

```
users/{uid}
  role:   "admin" | "dispatcher" | "salesrep" | "rider"
  status: "approved" | "pending" | "pending_approval" | "rejected" | "disabled"
  email:  string
  employeeId: string (optional)
  name:   string
```

Status values must be consistent across Login.jsx, the route guards (AdminRoute/SalesRepRoute/DispatcherRoute), userService.js, and the Flutter AuthGate. Do not write "active" or "inactive" as status — these are UI display labels only.

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

## Meridian UI Redesign — in progress (visual/layout only, no logic changes)

Dark-green "Meridian" design system rollout. **Visual/CSS only** — no Firestore services, data logic, route guards, status values, or Firebase reads/writes changed in any Meridian phase.

**Foundations (shipped):**
- `src/styles/tokens.css` — CSS custom properties (`--green-950…50`, `--gray-*`, semantic success/danger/warning/info-teal, radii, shadows, `.tnum`); imported globally in `main.jsx`
- `src/styles/meridian-shell.css` — dark-green sidebar + white topbar re-skin for all three role layouts
- `src/pages/StyleGuide.jsx` (+ `.css`) — live style guide at `/style-guide` (isolated, no Firestore)
- Shared primitives in `src/components/ui/`: `StatusBadge.jsx` (consumes normalized `statusKey`), `KpiCard.jsx`, `ui.css`

**Design rules:** dark-green brand; green=success/delivered/approved, red=urgent/delayed/cancelled, amber=loading/warning, teal=assigned/in-transit, neutral gray structure. No bright blue, no emoji avatars, no fake map art, no uppercase microlabels, no heavy shadows. Tabular numerals on all figures.

**Pages redesigned & CONFIRMED WORKING:**
| Page | Notes | Confirmed |
|---|---|---|
| Auth (Login / Register / Pending) | Green brand/logo/buttons/links/focus; `Auth.css` override layer appended (beat the shared `styles.css` blue rules with specificity, no `styles.css` edit) | ✅ live |
| Admin Deliveries (table + filter bar + detail drawer) | Modal → right-side drawer with audit trail; shared StatusBadge/KpiCard | ✅ live |
| Admin Dashboard | Removed fake "Metro Manila" map + hardcoded rider panel + fake inspect modal; added real delivery status breakdown + recent orders (derived from same `orders` array) | ✅ live |
| Sales Rep Dashboard | Consolidated 4 redundant order widgets into one Active-orders table + Stock-to-watch + quiet quick actions | ✅ live |
| Dispatcher Cargo Loading | Summary cards + rider checklist cards. **Finalize dispatch + cross-role reflection LIVE-VERIFIED 2026-07-17** with real order `VT-ORD-1784056096300` (finalized `assigned` → `in_transit`; reflected on Dispatcher Shipments + Admin Deliveries + Sales Rep Order Tracking). DCL-001/003/004 Passed; only DCL-002 (per-checkbox `isLoaded` write) + DCL-005 (empty/error states) still Pending Manual Test | ✅ mostly live-verified |
| Dispatcher Assign Rider | Emoji avatars → initials; green selected state; StatusBadge; green Confirm w/ clear disabled state | ✅ **manual real-assignment test passed 2026-07-14** — real pending order → select approved rider → Confirm → order `status: "assigned"`, `assignedRiderId/name/phone` written, reflected on Admin Deliveries + Sales Rep Order Tracking |
| Dispatcher Dashboard | **Removed the fake "Metro Manila Delivery Network" map** (animated grid, glowing routes, node dots, moving-rider truck, floating labels) from JSX + deleted its CSS; replaced with an honest "Live map view not yet active" info note (real active/delayed badges + pending/riders/delayed footer counts kept). Hero gradient → white card; blue → green on Assign-from-queue/assign buttons, order-id, live pill, monitor icons, operation accents, vaccine dot; de-uppercased kickers/table/badge microlabels; green row hover; neutral View-Shipments button; softened weights + lighter shadows (KPI grid already shared KpiCard). `subscribePendingDispatchOrders`/`subscribeDeliveries`/`subscribeRiders`/`subscribeActiveAlerts` + assign handoff (`localStorage`+navigate) untouched | ✅ **manual test passed 2026-07-16** — page opens, fake map gone, honest note appears, real KPI counts + queue load, Assign from queue works, View Shipments works, no console errors |
| Dispatcher Geofence / Live Monitoring | Bespoke `geo3-status-pill`/`geo3-badge` → shared **StatusBadge** (order list + detail); honest info banner blue → **teal**; card headings de-uppercased; blue → green order-item hover/selected; info-row sub-text forced-red → neutral gray (carries phone/address/location, not errors); cards to subtle border + light shadow. Still honest — no fake GPS/route/map. `subscribeDeliveries` + active-status filter + selection untouched | ✅ **manual test passed 2026-07-16** — page opens, active deliveries load, StatusBadge displays correctly, selecting an order works, no fake GPS/map claims, no console errors |
| Dispatcher Settings | Save Profile button + preference toggles (on-state) blue → green; form inputs gained green focus rings + neutral borders; softened label/heading weights; page title de-blued/tightened; save-confirmation stays green (success). Profile/preferences state + toggle handlers + `localStorage` save untouched | ✅ **manual test passed 2026-07-16** — page opens, toggles/settings work, Save preferences works, no console errors |
| Sales Rep Inventory | Blue → green detox in the `-v2` block: green Request-selected/type-tabs/checkboxes/pagination, sentence-case non-uppercase table headers on quiet gray row, green row hover (no zebra), semantic stock-status chips (Critical=red, Warning=amber, Stable=green), neutral batch/temp chips, teal cold-chain icon, green search/select focus, subtle card shadows. No data/logic/localStorage/route changes | ✅ **manual test passed 2026-07-15** — page opens, real Firestore inventory loads, search/filter/type tabs work, selection works, Request Selected routes correctly, no console errors |
| Sales Rep Order Tracking | Bespoke `track-status` chips → shared **StatusBadge** (rows + selected panel, custom labels via `label`); removed fake gradient mini-map + route line → clean status strip; removed `⚡` emoji; blue → green on primary button/active tab/hover/selected/progress bar/focus/action buttons; de-uppercased side + header labels. No subscription/filter/selection logic changed | ✅ **manual test passed 2026-07-15** — page opens, real Sales Rep orders load, StatusBadge displays correctly, row/details selection works, no console errors |
| Sales Rep Request Order | Blue → green in `request-v2` block + shared base: green stock-filter tabs/Add-to-order button (green hover, gray disabled)/Quick Cart badge/cart-item qty/Place-order button; neutral quantity steppers; sentence-case non-uppercase product chips (category neutral, stock semantic); lighter product-card hover (subtle shadow, no heavy lift); green search/cart-input focus. **CSS only — no JSX changes.** localStorage preselect/cart flow, quantity math, navigation untouched | ✅ **manual test passed 2026-07-15** — page opens, `salesRepSelectedInventory` preselect appears, quantity controls work, Place Order navigation works, no console errors |
| Sales Rep Place Order | Order Summary card flipped bright-blue → deep pine `--green-800` (green-tint labels, tabular nums, white/green Finalize button); "Add more items" → neutral secondary; blue → green/neutral on session highlight, quantity steppers, shipping-address box; gray sentence-case Order Items header + green row hover; green focus rings on clinic select/instructions/search; removed decorative `⊙` glyph (only JSX change). `createSalesRepOrder` payload, `subscribeClinics`, `salesRepQuickCart` flow, validation, submit handler untouched | ✅ **manual test passed 2026-07-15** — page opens, real Firestore clinics load, Order Summary correct, Finalize creates an order → appears in Sales Rep Order Tracking + Admin Deliveries + Dispatcher pending/assignment flow, no console errors |
| Sales Rep Alerts | Semantic tones enforced (critical=red, info/updates=**teal** was blue, delivered=green, warning=amber) on card left-border/badge/icon; filter chips "All"=green + "Updates"=teal; alert status badges rendered **sentence case via CSS `::first-letter`** (no change to derived `tag` strings); "View Details" button was inheriting red base → neutral secondary; green tab underline + search focus; neutral location chip; lighter card hover; modal labels de-uppercased, accent/Close button green. **CSS only — no JSX changes.** `subscribeSalesRepOrders`, `deriveAlertFromOrder`, tab/filter/search state untouched | ✅ **manual test passed 2026-07-15** — page opens, Active/History tabs + filter chips + search work, cards display correctly, View Details modal opens/closes, no console errors |
| Sales Rep Settings | Save button + input focus rings blue → green; labels softened to sentence weight/neutral; heading de-blued/tightened; account-status values kept semantic (Active=green, Pending=amber, Inactive=gray, Rejected=red); shared `.inventory-loading-state` icon blue → neutral gray (also de-blues transient loading/error states on the other SR pages). **CSS only — no JSX changes.** `getUserProfile`/`updateUserProfile`, save handler + field whitelist, name validation, `hasChanges` untouched | ✅ **manual test passed 2026-07-15** — page opens, profile loads, editing a field activates Save, Save persists after refresh, no console errors |
| Admin Riders | **Removed the fake "Live Fleet Map"** (grid bg, drawn roads, hardcoded Manila/Makati/QC labels, positioned markers, zoom/recenter) + orphan `mapZoom` state + unused map icon imports; icon-tile `RiderSummaryCard` → shared **KpiCard** ×4 (clickable filters preserved); blue → green on New Rider/filter chips/Assign+modal primary actions/initials avatars (standby=green, off-duty=gray); semantic status pills; neutral secondary buttons; green search/select focus; softened weights + lighter card/modal shadows. `subscribeRiders`/`updateRiderStatus` + approve/reject/off-duty/reactivate untouched; fake "Assign delivery" toast + `pendingDeliveries` left as-is (flagged for future functional cleanup) | ✅ **manual test passed 2026-07-16** — page opens, fake map gone, real riders load, filters/search work, detail modal opens, approve/reject/off-duty/reactivate work, no console errors |
| Admin Inventory | Icon-tile `SummaryCard` → shared **KpiCard** ×4 (Total/Critical=danger+red rule/Warning=warning/Stable=success, clickable filters); table sentence-case headers on quiet gray row (was blue uppercase) + green row hover + green checkboxes (were blue); blue → green on Add Vaccine/Add Stock/filter chips/pagination/expiry-select focus/vaccine-cell icon/stock-overview blue bar; **Warning stock chip fixed indigo → amber**; temp pill neutralized; Export/light → neutral secondary; bulk bar green tint + neutral buttons; softened weights + lighter shadows. `subscribeInventory` + filters/search/pagination/bulk-select + `normalizeInventoryItem` + Add Vaccine/Add Stock routing untouched | ✅ **manual test passed 2026-07-16** — page opens, real inventory loads, search/filter/pagination work, checkboxes/bulk-select work, Add Vaccine/Add Stock route correctly, no console errors |
| Admin Clinics | Icon-tile `ClinicSummaryCard` → shared **KpiCard** ×4 (Total/Active=success/Pending=warning/Overdue=danger+red rule, clickable filters); table sentence-case headers on quiet gray row + green row hover; **contact-person initials avatars** + clinic-name icon tile blue → green; blue → green on Register-New-Clinic/filter chips/pagination/form focus/modal primary; row actions + modal secondary + grid-view btn → neutral; status pills to semantic tokens; softened weights + lighter card/modal shadows. `subscribeClinics`/`clinicNameExists`/`addClinic` + required-field & duplicate-name checks + `normalizeClinic` + routes untouched | ✅ **manual test passed 2026-07-16** — page opens, real clinics load, search/filter/pagination work, register modal opens, required-field validation + duplicate check work, new clinic saves, no console errors |
| Admin Alerts | Icon-tile `AlertKpi` → shared **KpiCard** ×4 with **semantic tones** (Critical=danger+red rule / Warnings=warning / Pending notices=**info/teal** was blue / Resolved=success); alert-row + modal **notice** accent/icon blue → teal, unread dot blue → green, category "Inventory warning" tile blue → teal; blue → green on Alert-Settings btn/filter chips/priority-action/settings toggles/modal Mark-Resolved; Mark-All-Read + Review + modal secondary → neutral; severity chip neutralized; softened weights + lighter card/modal shadows + green search focus. `subscribeAllAlerts`/`markAlertRead`/`resolveAlert` + mark-read/resolve/priority/category logic + `normalizeAlert` + routes untouched | ✅ **manual test passed 2026-07-16** — page opens, real alerts load, filter tabs work, review modal opens, mark read / Mark Resolved work, Alert Settings toggles work, no console errors |
| Admin Settings | Icon-tile `SettingsSummaryCard` ×4 (both General + User Management tabs) → shared **KpiCard**; blue → green on tab underline/save btn/feature toggles/pagination/form+select focus/card-title accent/staff-avatar; staff **pending** avatar+status sky-blue → amber, inactive → neutral; sentence-case staff-table headers + green row hover; Discard/menu/light buttons → neutral; softened weights + lighter card/menu/modal shadows. **Follow-up 2026-07-16:** System-Features toggles resized 48×28→**46×24** (knob 22→18, on=green/off=gray, `:focus-visible` ring, vertically centered). `subscribeUsers`/`updateUserStatus`/`updateUserRole` + approve/reject/deactivate/reactivate/change-role + feature-toggle state + save/discard + routes untouched | ✅ **manual test passed 2026-07-16** — both tabs work, real users load, status actions + role change work, feature toggles behave, save/discard work, toggles now compact, no console errors |
| Admin Add Vaccine / Add Stock | Scoped Meridian override in **new `AdminForms.css`** (all rules under `.inventory-main`, the `<main>` used only by these two forms — global `styles.css` untouched): blue → green on breadcrumb accent/heading icon tiles/Add-Type link/step-tabs active/primary buttons, green input+select focus rings, neutral form-card borders + 12px radius + light shadow, neutral Cancel/stepper/add-type box, softened labels. **Follow-up 2026-07-16 (Add Vaccine align fix):** two-col grid gap/`align-items:start`, equal-height label rows so Manufacturer input + Vaccine Type select line up, "Add Type" seated in the label row, field icons vertically centered, SKU section + helper/error spacing. `addVaccine`/`addVaccineType`/`skuExists`/`addStockBatch`/`batchIdExists` + SKU-format regex + duplicate SKU/batch checks + date/qty/temp validation + saves + routes untouched | ✅ **manual test passed 2026-07-16** — Add Vaccine: layout aligned, required + SKU-format validation + duplicate-SKU check + save all work; Add Stock: opens correctly after shared spacing changes, required + duplicate-batch + quantity/temp/date validation + save all work; no console errors |

| Admin Analytics | Icon-tile `MetricCard` ×4 → shared **KpiCard** (Total orders=neutral / Avg delivery time=neutral honest "—" / Completion rate=success / Active alerts=danger+red rule, each still opens its detail modal); **chart palette blue → Meridian green** (volume bars `--green-600/700`, region progress green on gray track, heatmap 4-step green sequential + green legend); **fabricated `STATIC_HUBS` "Hub Performance Ranking" table removed** → honest "Hub ranking not available yet" empty state (no hub data fabricated); **"AI Logistics Insight" renamed "Operational insight"** (rule-based on real delayed/alert counts, modal description updated — no AI/ML claims); Export → neutral secondary, selects green focus, sentence-case labels, lighter shadows, green modal icon/Close. `subscribeDeliveries`/`subscribeAllAlerts` + time/region/vaccine filters + all computations (`computeVolumeBuckets`/`computeHeatmap`/`computeRegions`, completion rate) untouched; no new Firestore reads/writes | ✅ **manual test passed 2026-07-16** — page opens, KPI cards + detail modals work, filters work, volume/region/heatmap display with Meridian palette, hub section shows honest unavailable state, "Operational insight" replaces AI wording, no console errors |

| Admin Invoices (queue) | Icon-tile `SummaryCard` ×4 → shared **KpiCard** (Pending/Total=neutral, High priority=danger+red rule, Issued today=success); table sentence-case headers on quiet gray row + green row hover + tabular order-id; blue → green on Create/Continue/Print/Issue buttons + search/filter/priority-select focus; **local invoice `StatusBadge` kept** (invoice statuses ≠ order statuses) but de-uppercased + semantic tokens incl. "Ready to Print" blue → **teal**; de-uppercased filter labels; subtle card border + light shadow. `subscribeInvoiceQueue` + `updateInvoicePriority` write + filters/sort/pagination untouched | ✅ **manual test passed 2026-07-16** — queue opens, orders/invoices load, search/filter/sort/pagination work, priority change persists, no console errors |
| Admin InvoiceEditor | **CSS-only** (chrome inherits the detoxed `Invoices.css`; no JSX edited): blue → green primary buttons (Save Draft/Mark as Issued/dialog), editable-field **focus outlines** blue → green, dialog subtle border + lighter shadow. **Printable A4 `.inv-doc` deliberately preserved** — black print borders, cream item-table header, red invoice number, green grand total, `@media print` block all untouched. `createInvoiceDraft`/`updateInvoiceDraft`/`issueInvoice` + numbering/counter + one-invoice-per-order (doc id = orderId) + issued read-only lock + `validateForIssue` + save-before-issue gate + routes untouched | ✅ **manual test passed 2026-07-16** — Create Invoice opens, draft editing + Save Draft persist, reopening draft works, Mark as Issued works, issued invoice locks read-only, one-invoice-per-order still enforced, Print A4 layout correct, no console errors |

**Admin role — Meridian UI COMPLETE ✅ (2026-07-16):** all Admin pages (Dashboard, Deliveries + detail drawer, Inventory, Riders, Clinics, Alerts, Settings, Add Vaccine, Add Stock, Analytics, **Invoices, InvoiceEditor**) migrated to the Meridian dark-green system, each manually verified. Visual/CSS + presentational-JSX only — no Firestore services/subscriptions/writes, status/approval/resolve/issue logic, duplicate/SKU/batch/one-invoice-per-order checks, calculations, numbering, validation, route guards, or real data changed (only fabricated hub data removed).

**🎉 WEB MERIDIAN UI MIGRATION COMPLETE ✅ (2026-07-16):** all three web roles fully migrated — **Admin** (12 pages incl. Invoices), **Sales Rep** (7 pages), **Dispatcher** (6 pages) + shared Auth pages. Every page manually verified. Visual/CSS + presentational-JSX only across all batches — no Firestore services, subscriptions, writes, business logic, validation, route guards, or real data changed; fake maps + fabricated hub/AI content removed and replaced with honest states. Outstanding non-Meridian item: Cargo Loading finalize + **cross-role web reflection now live-verified 2026-07-17** (order `VT-ORD-1784056096300`: `assigned` → `in_transit` reflected on Dispatcher Shipments + Admin Deliveries + Sales Rep Order Tracking, no console errors; DCL-001/003/004 Passed) — only DCL-002 (per-checkbox `isLoaded` write) + DCL-005 (empty/error states) remain Pending Manual Test. Rider app is Flutter-only (not part of this web migration).

**Dispatcher role — Meridian UI COMPLETE ✅ (2026-07-16):** all 6 Dispatcher pages (Dashboard, Assign Rider, Cargo Loading, Shipments, Geofence/Live Monitoring, Settings) are on the Meridian dark-green system, each manually verified. Visual/CSS + presentational-JSX only — no Firestore services/subscriptions, assignment/status/cargo logic, `localStorage`, validation, or route guards changed. Fake maps removed (Dashboard's "Metro Manila Delivery Network"); Geofence stays honest (no fake GPS/route/map).

**Dispatcher Cargo Loading — PARTIAL runtime QA ✅ (2026-07-17, Dispatcher-side, verified manually by user):** the previously-outstanding live real-rider-card check is now confirmed. `/dispatcher/cargo-loading` opens; the **real rider checklist card renders for QA Rider Two**; the reserved order **VT-ORD-1784056096300 appears under that rider**; the **isLoaded toggle works** and **progress updates**; **Finalize Dispatch becomes enabled and works** — the order moved **assigned → in_transit**; **/dispatcher/shipments reflects In Transit**; no console errors. **Still Pending (Admin/Sales Rep passwords unavailable this session):** Admin Deliveries + Sales Rep Order Tracking reflection of the In Transit change (DCL-004 Admin/SR portion) and the DCL-005 empty-state check. Order VT-ORD-1784056096300 is now `in_transit` (no longer reserved in `assigned`).

**Sales Rep role — Meridian UI COMPLETE ✅ (2026-07-15):** all 7 Sales Rep pages (Dashboard, Inventory, Order Tracking, Request Order, Place Order, Alerts, Settings) are on the Meridian dark-green system, each manually verified. Visual/CSS only across all batches — no Firestore services, subscriptions, order-creation/inventory logic, localStorage flows, validation, route guards, or Firebase reads/writes changed.

**Verification method note:** admin/sales-rep pages were verified live by logging in as dispatcher (who can read `orders`/`alerts`/`users`/`inventory` under dev rules) via a temporary preview route that was removed after each check. All temporary routes/harnesses have been removed.

**Remaining (Meridian migration):** ✅ **NONE — all web pages migrated (Admin, Sales Rep, Dispatcher, Auth).** Optional cleanup only (not blocking): delete dead `RegisterClinic.jsx`/`ClinicSuccess.jsx` and unused legacy CSS blocks (incl. Dispatcher `geo3-*` fake-map leftovers; Analytics `.compact-analytics`/`.analytics-metric-card`/hub-table; per-page dead `*-summary-card`/`*-metric-card`/`*-kpi` rules left after KpiCard conversions). Outstanding functional (not Meridian): Cargo Loading DCL-002 (per-checkbox `isLoaded` write) + DCL-005 (empty/error states) — finalize + cross-role reflection (DCL-001/003/004) live-verified 2026-07-17.

---

## Pulled Changes (2026-07-10, commits b67c443 + e977da4) — statically audited, runtime test pending

Code pulled from a collaborator. Post-pull diagnosis (2026-07-10): builds pass, no regressions, architecture intact. **Not yet runtime-tested** — see Pending Manual Test items in `docs/VaxTrack-Test-Case-Tracker.md`.

**New: Admin Invoices module**
- `pages/admin/Invoices.jsx` (queue), `pages/admin/InvoiceEditor.jsx`, `services/invoiceService.js`, routes `/admin/invoices` + `/admin/invoices/:orderId`, sidebar link
- Reads `orders`; writes new `invoices` collection (doc ID = orderId, one invoice per order) and `counters` (transactional sequential numbering `INV-YYYY-######`)
- Issued invoices are locked from edits; amounts show a dash when items carry no real prices

**New: Dispatcher Cargo Loading**
- `pages/dispatcher/DispatcherCargoLoading.jsx`, `services/cargoLoadingService.js`, route `/dispatcher/cargo-loading`, sidebar link
- Groups assigned/loading orders per approved rider; per-order `isLoaded` checkbox persisted to Firestore with `loadedAt/By` audit fields
- "Finalize dispatch" batch-moves a rider's whole group to `in_transit` atomically (writeBatch) with standard status audit fields
- **Process note:** finalize skips the `loading` status — dispatchers now have two dispatch paths (Shipments' Start Loading → Dispatch vs Cargo Loading's checklist → finalize). Both valid; product decision pending on which is canonical

**New: Sales Rep + Dispatcher route protection**
- `components/SalesRepRoute.jsx` and `components/DispatcherRoute.jsx` — mirror AdminRoute exactly (pending → /pending, rejected/disabled → /login, wrong role → own dashboard); all /sales-rep/* and /dispatcher/* routes now wrapped in App.jsx
- Closes the gap where those routes were previously unprotected

**Also in pull:** Auth.css forgot-password layout fix; `getOrderById` added to orderService.js

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

**Assigned Deliveries ✅ CONFIRMED WORKING (2026-07-10):**
- `DeliveryService.riderDeliveries()` subscribes to `orders` where `assignedRiderId == FirebaseAuth.currentUser.uid` (real-time snapshots, client-side sort by `createdAt`)
- `Delivery` model maps: orderNumber, clinicName, clinicAddress, vaccineName, vaccineType, quantity, unit, priority, normalized status + label, deliveryInstructions, items[] summaries, assignedAt/createdAt/updatedAt, lastLocation
- Status labels match web: Assigned/Loading/In Transit/Delayed/Delivered/Cancelled; Active lists exclude cancelled; empty state "No assigned deliveries yet."
- **Verified live:** Dispatcher assigned an order on web → order appeared on Rider Dashboard in real time (urgent banner, badges, card) → detail screen showed all fields + status timeline

**Rider Status Updates — PARTIAL runtime QA ✅ (2026-07-17, emulator, rider.qa2@vaxtrack.com):**
- ✅ **PASSED — Rider receives assigned orders:** dashboard shows only own orders via `assignedRiderId == FirebaseAuth.currentUser.uid` query (re-confirmed live)
- ✅ **PASSED — Mark Delivered** (VT-ORD-1783611813231): snackbar "Status updated to delivered", order moved to Completed with Delivered badge, KPI Completed count updated live
- ✅ **PASSED — Report Delay with reason** (VT-ORD-1783010866286): reason submitted via dialog, snackbar "Status updated to delayed", Delayed badge on dashboard — `delayReason` write path exercised
- ✅ **PASSED — Rider status updates reflect immediately in the Rider's own live subscription** (no refresh needed — proves Firestore write + snapshot round-trip)
- ✅ **PASSED — Flutter runtime clean:** no permission-denied, no exceptions during status writes (only benign emulator GMS/App Check warnings)
- ⏳ **NOT yet verified:** Start Loading / Start Transit taps (both test orders were already in_transit); web-side reflection of Rider status updates on Admin/Sales Rep/Dispatcher pages (session browser block); Sales Rep fresh-order creation; Admin order visibility; Dispatcher rider assignment; Cargo Loading real rider checklist card / isLoaded toggle / Finalize dispatch
- 📌 **Order VT-ORD-1784056096300 (rider: QA Rider Two) was consumed 2026-07-17 by the Cargo Loading real-rider-card test (DCL-001..003 Passed) and is now `in_transit`** — no longer reserved

**Implemented but NOT yet e2e-tested (next phase):**
- Rider Start Loading / Start Transit taps (assigned → loading → in_transit) — code exists in `delivery_detail_screen.dart` + `delivery_service.dart` with audit fields; delivered/delayed paths verified 2026-07-17
- Proof of delivery / invoice photo upload to Firebase Storage (`proof_of_delivery/{orderId}/`, `invoices/{orderId}/`)
- Location writes: `users/{uid}.lastLocation` on dashboard load, `orders/{id}.lastLocation` on status change — these will activate the web Geofence page's live-location display

**Firestore rules needed for rider (report, not yet deployed):**
- Rider can `create` own `users/{uid}` only with `role == "rider"` and `status == "pending"`
- Rider can read/update own doc; cannot approve self
- Admin (approved) can read/update rider users for approval

**Firestore rules needed for pulled Invoices module (report, not yet deployed):**
- `invoices` collection: approved admin read/write only
- `counters` collection: approved admin write/update only (used for transactional invoice numbering, `counters/invoice_{year}`)

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

## Phase 3 — Admin Service Layer ✅ COMPLETE

All admin pages are Firestore-backed through the service layer below. (Historical goal: replace hardcoded demo data with real Firestore reads/writes.)

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

- ~~`src/pages/rider/`~~ — ✅ deleted (Rider is Flutter-only; no React rider pages remain)
- `src/pages/admin/RegisterClinic.jsx` — redundant with Clinics.jsx inline modal; form saves nothing
- `src/pages/admin/ClinicSuccess.jsx` — hardcoded, only reachable from dead RegisterClinic flow

## Test Accounts (exist in vaxtrack-bef1b)

- **Admin:** admin@vaxtrack.com (`role: "admin"`, approved)
- **Dispatcher:** dispatcher@vaxtrack.com / 123456 (`role: "dispatcher"`, approved); also dispatcher@gmail.com
- **Sales Representative:** test12@gmail.com (`role: "salesrep"`, approved)
- **Riders (approved):** rider@vaxtrack.com, test@gmail.com, rider.test@vaxtrack.com, rider.qa2@vaxtrack.com / rider123456 (QA Rider Two)
- **Rider (pending):** rider.qa1@vaxtrack.com (riders rider / QA-1234)
- **Legacy corrupt docs (ignore/clean up in console):** test321@gmail.com (`role: "pending"`), rider@email.com (`role: "staff"`) — from the old monolithic app's signup; invisible to rider lists by design

## AdminSidebar Note

`AdminSidebar` is exported from `src/pages/admin/Inventory.jsx` and imported by all other admin pages. This is a known architectural smell. Do not move it until the service layer is complete, to avoid merge conflicts during active development.
