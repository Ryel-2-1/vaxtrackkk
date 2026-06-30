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
- "Current Stock Overview" card: vertical scrollable bar list, total doses grouped by vaccineType, sorted highest-to-lowest. Replaces the old column bar chart.
- "Critical & Expiring" card: shows critical-status batches + batches expiring within 30 days (up to 4), sorted soonest-first. Replaces the static Cold Storage card.
- Both sections powered by the existing `subscribeInventory` subscription (no new Firestore query needed).
- Known gap: batches with no `vaccineType` field appear under "Unknown" — not fixed, data quality issue in existing Firestore docs.

---

## Current Focus: Phase 3 — Admin Service Layer

All admin pages except AddStock and AddVaccine run on hardcoded demo data. The goal is to replace that data with real Firestore reads/writes through a clean service layer.

### Service Files Plan

| File | Status | Serves |
|---|---|---|
| `src/services/alertService.js` | ✅ Complete | Alerts.jsx, AdminDashboard.jsx, Analytics.jsx |
| `src/services/orderService.js` | Complete — SalesRep/Dispatcher only, do not touch | SalesRep, Dispatcher |
| `src/services/inventoryService.js` | ✅ Complete | Inventory.jsx, AdminDashboard.jsx |
| `src/services/userService.js` | ✅ Complete | Settings.jsx (User Management tab) |
| `src/services/vaccineService.js` | ✅ Complete | AddVaccine.jsx, AddStock.jsx |
| `src/services/deliveryService.js` | ✅ Complete | Deliveries.jsx, AdminDashboard.jsx, Analytics.jsx |
| `src/services/riderService.js` | ✅ Complete | Riders.jsx, AdminDashboard.jsx |
| `src/services/clinicService.js` | ✅ Complete | Clinics.jsx |

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
- Analytics.jsx real data — needs aggregation across multiple collections
- AdminSidebar extraction from Inventory.jsx — architectural cleanup, not urgent

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
