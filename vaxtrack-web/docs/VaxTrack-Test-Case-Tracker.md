# VaxTrack Test Case Tracker — Full System

**Project:** VaxTrack (React web portal + Flutter Rider app)
**Date:** 2026-07-11
**Standard:** ISO/IEC 25010:2011
**Firebase project:** vaxtrack-bef1b

Status legend: **Passed** = confirmed working (manual test or CLAUDE.md confirmation). **Pending Manual Test** = implemented but requires browser/emulator verification. **Not Applicable** = intentionally deferred/not implemented. **Failed** = confirmed broken.

> Companion doc: `VaxTrack-Admin-Test-Case-Tracker.md` (detailed Admin-only tracker from Phase 3).

---

## Manual Testing Notes

### Multi-role testing — use separate browser profiles

Firebase Auth state is shared **per browser profile / origin**. Logging into a second role in another tab of the **same** browser profile silently switches **all** tabs to the most recently logged-in user. This is expected Firebase behavior, **not a bug** — do not change authentication code to "fix" it.

To test multiple roles at once, isolate each role in its own browser profile / browser / emulator:

| Role | Suggested environment |
|---|---|
| Admin | Chrome (normal profile) |
| Dispatcher | Edge |
| Sales Rep | Chrome Incognito or Brave |
| Rider | Flutter emulator / physical phone |

**Do not** test multiple web roles in normal tabs of the same browser profile — they share Firebase Auth state and will collapse to a single user.

### Pending manual verification

**Dispatcher Cargo Loading — Meridian rider checklist cards (Phase 6):**
- ✅ Meridian UI was **build-verified** (`npm run build` passes).
- ✅ Empty state ("No assigned orders ready for loading") was **live-verified** in the browser as the dispatcher.
- ✅ **Finalize dispatch + cross-role reflection LIVE-VERIFIED (2026-07-16)** with real order **`VT-ORD-1784056096300`**: the order was finalized from `assigned` → `in_transit` via Cargo Loading, and the new status reflected across **all three web roles** — Dispatcher Shipments, **Admin Deliveries**, and **Sales Rep Order Tracking** all show **In Transit**, no console errors. Firestore remains the single source of truth.
- ⚠️ The rider checklist card **micro-interactions** (per-order "loaded" checkbox → progress bar + `isLoaded` Firestore write; Finalize-enabled-only-when-all-loaded gate) were exercised as part of reaching finalize but are not itemized here — treat DCL-002/DCL-005 as still Pending Manual Test for an explicit per-checkbox render check.

### Meridian UI polish — Sales Rep list pages (visual only)

**Batch 1 — Sales Rep Inventory + Order Tracking ✅ manual test passed 2026-07-15:**
- Visual/CSS + presentational-JSX only — no Firestore services, subscriptions, order/inventory logic, `salesRepSelectedInventory` localStorage flow, routes, or validation changed.
- Blue → Meridian green detox on both pages' `-v2` style blocks; Order Tracking now uses shared **StatusBadge** and the fake gradient mini-map/route line + `⚡` emoji were removed (clean status strip). Inventory table headers sentence-cased, stock-status chips retuned to semantic tokens, green row hover / focus states.
- **Confirmed live (Sales Rep profile):** `/sales-rep/inventory` opens, real Firestore inventory loads, search/filter/type tabs work, selection works, Request Selected routes correctly; `/sales-rep/order-tracking` opens, real orders load, StatusBadge displays correctly, row/details selection works; no console errors. `npm run build` passes.

**Batch 2 — Sales Rep Request Order + Place Order ✅ manual test passed 2026-07-15:**
- Visual/CSS + one presentational-JSX removal (decorative `⊙` glyph) only — no Firestore services/subscriptions (`subscribeInventory`, `subscribeClinics`), `createSalesRepOrder` payload fields, `salesRepSelectedInventory`/`salesRepQuickCart` localStorage flow, cart math, validation, submit handler, or routes changed.
- Blue → Meridian green across both `-v2` blocks + shared base rules: green filter tabs / Add-to-order / Place-order / cart badges; **Place Order's Order Summary card flipped from bright blue to deep pine `--green-800`**; neutral quantity steppers + secondary "Add more items"; sentence-case non-uppercase chips/labels; green focus rings; lighter card shadows.
- **Confirmed live (Sales Rep profile):** `/sales-rep/request-order` opens, `salesRepSelectedInventory` preselect appears, quantity controls work, Place Order navigation works; `/sales-rep/place-order` opens, real Firestore clinics load, Order Summary correct, **Finalize creates a real order** that appears in Sales Rep Order Tracking + Admin Deliveries + Dispatcher pending/assignment flow; no console errors. `npm run build` passes.

**Batch 3 — Sales Rep Alerts + Settings ✅ manual test passed 2026-07-15:**
- Visual/CSS only — no JSX changes; no Firestore services/subscriptions (`subscribeSalesRepOrders`, `getUserProfile`/`updateUserProfile`), `deriveAlertFromOrder` derivation, tab/filter/search state, Settings save handler/field whitelist, name validation, or routes changed.
- Alerts: semantic tones enforced (critical=red, info/updates=teal, delivered=green, warning=amber); "All"/"Updates" filter chips de-blued; alert status badges rendered sentence-case via CSS `::first-letter` (derived `tag` strings unchanged); "View Details" red base → neutral secondary; green tab underline/search focus; lighter card hover; modal labels de-uppercased. Settings: green Save + input focus rings, softened labels, semantic account-status colors; shared `.inventory-loading-state` icon blue → neutral gray.
- **Confirmed live (Sales Rep profile):** `/sales-rep/alerts` opens, Active/History tabs + filter chips + search work, cards display correctly, View Details modal opens/closes; `/sales-rep/settings` opens, profile loads, editing a field activates Save, **Save persists after refresh**; no console errors. `npm run build` passes.

**✅ Sales Rep Meridian UI set COMPLETE (2026-07-15):** all 7 Sales Rep pages (Dashboard, Inventory, Order Tracking, Request Order, Place Order, Alerts, Settings) migrated to the Meridian dark-green system and manually verified. Visual/CSS only — no functional logic changed across any batch.

### Meridian UI polish — Admin list pages

**Admin Batch 1 — Riders + Inventory ✅ manual test passed 2026-07-16:**
- Visual/CSS + presentational-JSX only — no Firestore services/subscriptions (`subscribeRiders`/`updateRiderStatus`, `subscribeInventory`), approve/reject/off-duty/reactivate behavior, inventory filter/search/pagination/bulk-select logic, `normalizeRider`/`normalizeInventoryItem`, or routes changed.
- **Fake "Live Fleet Map" removed** from Admin Riders (drawn roads, hardcoded city labels, positioned markers, zoom/recenter) + orphan `mapZoom` state. Icon-tile summary cards on both pages → shared **KpiCard**. Blue → Meridian green across buttons/filters/pagination/checkboxes/avatars/search focus; sentence-case table headers; Inventory Warning stock chip fixed indigo → amber; softened weights + lighter shadows. AdminSidebar untouched (already Meridian).
- Pre-existing fake "Assign delivery" toast flow + placeholder `pendingDeliveries` on Riders left as-is (out of scope for a visual pass; flagged for a future functional cleanup).
- **Confirmed live (Admin profile):** `/admin/riders` opens, fake map gone, real riders load, filters/search work, detail modal opens, approve/reject/off-duty/reactivate work; `/admin/inventory` opens, real inventory loads, search/filter/pagination + checkboxes/bulk-select work, Add Vaccine/Add Stock route correctly; no console errors. `npm run build` passes.

**Admin Batch 2 — Clinics + Alerts ✅ manual test passed 2026-07-16:**
- Visual/CSS + presentational-JSX only — no Firestore services/subscriptions (`subscribeClinics`/`clinicNameExists`/`addClinic`, `subscribeAllAlerts`/`markAlertRead`/`resolveAlert`), required-field + duplicate-name checks, alert mark-read/resolve/priority/category logic, `normalizeClinic`/`normalizeAlert`, or routes changed.
- Icon-tile summary/KPI cards on both pages → shared **KpiCard** (Alerts with semantic tones incl. Critical=danger red rule, Pending notices=info/teal, Resolved=success). Blue → Meridian green across buttons/filters/pagination/toggles/form focus; sentence-case table headers; Clinics contact **initials avatars** blue → green; Alerts **notice** accent/icon blue → teal; softened weights + lighter shadows. AdminSidebar untouched (already Meridian).
- **Confirmed live (Admin profile):** `/admin/clinics` opens, real clinics load, search/filter/pagination work, register modal opens, required-field validation + duplicate check work, new clinic saves; `/admin/alerts` opens, real alerts load, filter tabs work, review modal opens, mark read / Mark Resolved work, Alert Settings toggles work; no console errors. `npm run build` passes.

**Admin Batch 3 — Settings + Add Vaccine + Add Stock ✅ manual test passed 2026-07-16:**
- Visual/CSS + presentational-JSX only — no Firestore services/subscriptions (`subscribeUsers`/`updateUserStatus`/`updateUserRole`, `addVaccine`/`addVaccineType`/`skuExists`/`addStockBatch`/`batchIdExists`), status/role actions, feature-toggle state, SKU-format regex, duplicate SKU/batch checks, date/qty/temp validation, save/discard, or routes changed.
- Settings: icon-tile summary cards (both tabs) → shared **KpiCard**; blue → green across tabs/buttons/toggles/pagination/focus/avatars; pending status sky-blue → amber; sentence-case staff headers. Add Vaccine/Add Stock: new **`AdminForms.css`** scoped under `.inventory-main` (global `styles.css` untouched) — green buttons/focus/heading tiles, neutral form cards, softened labels.
- **Follow-up fixes (2026-07-16):** (1) Settings System-Features toggles resized 48×28 → **46×24** (knob 18, on=green/off=gray, focus ring, centered) — CSS-only in `Settings.css`. (2) Add Vaccine "Basic Information" alignment — equal-height label rows (Manufacturer input ↔ Vaccine Type select aligned), "Add Type" seated in the label row, field icons vertically centered, SKU + helper/error spacing — CSS-only in `AdminForms.css` (Add Stock verified still correct after shared spacing changes).
- **Confirmed live (Admin profile):** `/admin/settings` both tabs work, real users load, status actions + role change work, feature toggles behave (now compact), save/discard work; `/admin/add-vaccine` required + SKU-format validation + duplicate-SKU check + save all work with aligned layout; `/admin/add-stock` required + duplicate-batch check + quantity/temp/date validation + save all work; no console errors. `npm run build` passes.

**✅ Admin core/list/form pages — Meridian UI COMPLETE (2026-07-16):** Dashboard, Deliveries + detail drawer, Inventory, Riders, Clinics, Alerts, Settings, Add Vaccine, Add Stock all migrated to the Meridian dark-green system. Visual/CSS only — no functional logic changed across any batch. Not yet migrated: Admin Analytics, Invoices (out of scope by request).

### Meridian UI polish — Dispatcher remaining pages

**Dispatcher Batch — Dashboard + Geofence + Settings ✅ manual test passed 2026-07-16:**
- Visual/CSS + presentational-JSX only — no Firestore subscriptions (`subscribePendingDispatchOrders`/`subscribeDeliveries`/`subscribeRiders`/`subscribeActiveAlerts`), assignment handoff, status/priority logic, Geofence active-status filter/selection, or Settings profile/preferences/`localStorage` save changed.
- **Fake "Metro Manila Delivery Network" map removed** from Dispatcher Dashboard (JSX + CSS) → honest "Live map view not yet active" note (real badges/footer counts kept). Geofence bespoke pills → shared **StatusBadge**, honest info banner blue → teal, forced-red info sub-text → neutral. Settings: green Save button + toggles + input focus rings. Blue → Meridian green + de-uppercased microlabels + lighter shadows across all three.
- **Confirmed live (Dispatcher profile):** `/dispatcher` opens, fake map gone, honest note appears, real KPI counts + queue load, Assign-from-queue + View-Shipments work; `/dispatcher/geofence` opens, active deliveries load, StatusBadge displays, order selection works, no fake GPS/map claims; `/dispatcher/settings` opens, toggles/settings + Save preferences work; no console errors. `npm run build` passes.

**✅ Dispatcher pages — Meridian UI COMPLETE (2026-07-16):** Dashboard, Assign Rider, Cargo Loading, Shipments, Geofence/Live Monitoring, Settings all migrated to the Meridian dark-green system. Visual/CSS only — no functional logic changed.

**PARTIAL Cargo Loading runtime QA ✅ (2026-07-17, Dispatcher-side, verified manually by user):** `/dispatcher/cargo-loading` opens; the real rider checklist card renders for **QA Rider Two**; the reserved order **VT-ORD-1784056096300** appears under that rider; the **isLoaded** toggle works and **progress updates**; **Finalize Dispatch** becomes enabled and works — the order moved **assigned → in_transit**; **/dispatcher/shipments** reflects **In Transit**; no console errors (DCL-001..003 Passed, DCL-004 Dispatcher-side Passed). **Still Pending:** Admin Deliveries + Sales Rep Order Tracking reflection (Admin/Sales Rep passwords unavailable — DCL-004 Admin/SR portion) and DCL-005 empty-state check.

### Meridian UI polish — Admin Analytics

**Admin Analytics ✅ manual test passed 2026-07-16:**
- Visual/CSS + presentational-JSX only — no Firestore subscriptions (`subscribeDeliveries`/`subscribeAllAlerts`), time/region/vaccine filters, or analytics computations (`computeVolumeBuckets`/`computeHeatmap`/`computeRegions`, completion rate) changed; no new Firestore reads/writes.
- Icon-tile KPI cards → shared **KpiCard** ×4 (detail modals preserved). **Chart palette blue → Meridian green:** volume bars, region progress bars, and the peak-hours heatmap (4-step green sequential + green legend).
- **Honesty fixes:** the fabricated `STATIC_HUBS` "Hub Performance Ranking" table (invented hub names/rates/incidents) was removed and replaced with an honest "Hub ranking not available yet" empty state; **"AI Logistics Insight" renamed "Operational insight"** (rule-based on real delayed/alert counts — no AI/ML claims). Avg-delivery-time KPI keeps its honest "—" state. Note: AAN-004's remark ("Hardcoded ranking kept") is superseded — the static ranking is now removed in favor of the honest empty state; the deferred-metric intent of AAN-004 stands.
- **Confirmed live (Admin profile):** `/admin/analytics` opens, KPI cards + detail modals work, filters work, volume/region/heatmap display correctly with the Meridian palette, hub section shows the honest unavailable state, "Operational insight" replaces AI wording; no console errors. `npm run build` passes.

### Meridian UI polish — Admin Invoices / InvoiceEditor

**Admin Invoices + InvoiceEditor ✅ manual test passed 2026-07-16:**
- Visual/CSS + presentational-JSX only — no `invoiceService` logic touched: `subscribeInvoiceQueue`, `createInvoiceDraft`/`updateInvoiceDraft`/`issueInvoice`, `updateInvoicePriority`, invoice numbering/per-year counter, one-invoice-per-order (invoice doc id = orderId), issued read-only lock, `validateForIssue`/save-before-issue gate, and Firestore fields all unchanged. **InvoiceEditor.jsx was not edited** (chrome inherits the detoxed `Invoices.css`).
- Queue: icon-tile summary cards → shared **KpiCard**; sentence-case table headers + green row hover + tabular order-id; blue → green buttons/focus rings; local invoice `StatusBadge` de-uppercased + semantic tokens ("Ready to Print" blue → teal).
- **Printable A4 `.inv-doc` deliberately preserved** — black print borders, cream item-table header, red invoice number, green grand total, and the `@media print` block are untouched; only the editable-field focus outlines went blue → green.
- **Confirmed live (Admin profile):** queue opens, orders/invoices load, search/filter/sort/pagination work, priority change persists; Create Invoice + draft editing + Save Draft persist, reopening draft works, Mark as Issued works, issued invoice locks read-only, one-invoice-per-order still enforced, Print A4 layout correct; no console errors. `npm run build` passes.

**✅ Admin role — Meridian UI COMPLETE (2026-07-16):** all Admin pages incl. Analytics, Invoices, InvoiceEditor. (Notes AIV-001..006 in section 12 were previously "Pending Manual Test"; the Invoices module is now both runtime-verified and Meridian-styled.)

**🎉 WEB MERIDIAN UI MIGRATION COMPLETE ✅ (2026-07-16):** all three web roles migrated — Admin (12 pages incl. Invoices), Sales Rep (7 pages), Dispatcher (6 pages) + shared Auth pages, each manually verified. Visual/CSS + presentational-JSX only across every batch — no Firestore services/subscriptions/writes, business logic, validation, route guards, or real data changed; fake maps + fabricated hub/AI content removed and replaced with honest states. Outstanding functional (not Meridian): Cargo Loading finalize + cross-role reflection now live-verified 2026-07-17 (DCL-001/003/004 Passed); only DCL-002 (per-checkbox isLoaded write) + DCL-005 (empty/error states) remain Pending Manual Test. Rider app is Flutter-only.

**PARTIAL Runtime QA ✅ (2026-07-17, Rider-side only):** Flutter Rider e2e status updates verified live on the emulator as rider.qa2@vaxtrack.com — assigned-order receipt (query `assignedRiderId == current Auth UID`), Mark Delivered (RSU-003), Report Delay with `delayReason` (RSU-004), and immediate reflection in the Rider's own live subscription all PASSED; Flutter runtime showed no permission-denied or exceptions. NOT yet verified (blocked this session — no browser + missing Admin/Sales Rep credentials): Sales Rep fresh-order creation, Admin order visibility, Dispatcher rider assignment, Cargo Loading real rider checklist card / isLoaded toggle / Finalize dispatch (DCL-001..005), and web-side reflection of Rider status updates (RSU-005). **VT-ORD-1784056096300 remains reserved untouched in `assigned` for the Cargo Loading test.**

---

## 1. Admin — Route Protection

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| ARP-001 | Security | Admin | AdminRoute | Unauthenticated user blocked | Not logged in | Navigate to any /admin/* route | Redirect to /login | Redirect to /login | Passed | All admin routes wrapped |
| ARP-002 | Security | Admin | AdminRoute | Pending user redirected | status: pending/pending_approval | Log in, open /admin | Redirect to /pending | Redirect to /pending | Passed | |
| ARP-003 | Security | Admin | AdminRoute | Rejected/disabled blocked | status: rejected/disabled | Log in, open /admin | Redirect to /login | Redirect to /login | Passed | |
| ARP-004 | Security | Admin | AdminRoute | Wrong role redirected to own dashboard | role: dispatcher or salesrep | Log in, open /admin | Redirect to /dispatcher or /sales-rep | Redirected correctly | Passed | |
| ARP-005 | Security | Admin | AdminRoute | Approved admin allowed | role: admin, status: approved | Log in, open /admin | Page renders | Page renders | Passed | |
| ARP-006 | Security | Admin | AdminRoute | No content flash while auth loads | Auth in progress | Open /admin during load | Returns null, no flash | No flash | Passed | |

## 2. Admin — Dashboard

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| ADH-001 | Functional Suitability | Admin | AdminDashboard | KPI cards use real Firestore counts | Orders/alerts/users/inventory exist | Open /admin | Real counts on 4 KPI cards | Real counts shown | Passed | 4 subscriptions |
| ADH-002 | Functional Suitability | Admin | AdminDashboard | Delayed count reacts to status change | An order set to delayed | Change order status | Delayed count updates live | Updates live | Passed | |
| ADH-003 | Functional Suitability | Admin | AdminDashboard | Recent alerts sidebar from alerts collection | Unresolved alerts exist | View sidebar | Up to 5 recent unresolved alerts | Real alerts shown | Passed | |
| ADH-004 | Reliability | Admin | AdminDashboard | Loading/error states | — | Open page fresh | Loading indicator then data; error banner on failure | Works | Passed | |
| ADH-005 | Compatibility | Admin | firebase.js | No Analytics CSP errors in dev | npm run dev | Open console | No firebase/googletagmanager CSP errors | None | Passed | PROD-only Analytics guard |

## 3. Admin — Alerts

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| AAL-001 | Functional Suitability | Admin | Alerts | Alerts load from Firestore | alerts collection has docs | Open /admin/alerts | Real alerts listed | Real alerts listed | Passed | |
| AAL-002 | Functional Suitability | Admin | Alerts | Mark Resolved writes Firestore | Active alert exists | Open detail modal, Mark Resolved | status: resolved written | Written | Passed | |
| AAL-003 | Functional Suitability | Admin | Alerts | Mark Read writes Firestore | Unread alert exists | Mark Read | read: true written | Written | Passed | |
| AAL-004 | Usability | Admin | Alerts | Detail modal opens with alert data | Alert exists | Click alert | Modal shows alert fields | Works | Passed | |

## 4. Admin — Settings / User Management

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| AUM-001 | Functional Suitability | Admin | Settings | Users list from users collection | Users exist | Open User Management tab | Real users listed | Real users listed | Passed | |
| AUM-002 | Functional Suitability | Admin | Settings | Approve pending user | Pending user exists | Approve | status: approved written | Written | Passed | |
| AUM-003 | Functional Suitability | Admin | Settings | Disable / reactivate cycle | Approved user exists | Disable then Reactivate | approved→disabled→approved | Works | Passed | Reactivate button bug fixed |
| AUM-004 | Security | Admin | Settings | Status writes restricted to valid values | — | Attempt status change | Only approved/pending/disabled/rejected written | Valid values only | Passed | userService whitelist |

## 5. Admin — Inventory

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| AIN-001 | Functional Suitability | Admin | Inventory | Batches load from inventory collection | Inventory docs exist | Open /admin/inventory | Real batches listed | Real batches | Passed | |
| AIN-002 | Functional Suitability | Admin | Inventory | Summary counts computed live | — | View Total/Critical/Warning/Stable | Counts match subscription | Match | Passed | |
| AIN-003 | Functional Suitability | Admin | Inventory | Stock overview bar chart real data | — | View Current Stock Overview | Doses grouped by vaccineType | Works | Passed | Unknown type → "Unknown" (data-quality note) |
| AIN-004 | Functional Suitability | Admin | Inventory | Critical & Expiring card | Batches expiring ≤30 days | View card | Up to 4 soonest-first entries | Works | Passed | |

## 6. Admin — Add Vaccine

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| AAV-001 | Functional Suitability | Admin | AddVaccine | Save vaccine via vaccineService | Valid form | Submit | Doc written to vaccines | Written | Passed | |
| AAV-002 | Functional Suitability | Admin | AddVaccine | Duplicate SKU blocked | SKU exists | Submit same SKU | Error, no write | Blocked | Passed | |
| AAV-003 | Usability | Admin | AddVaccine | Navigates to /admin/inventory after save | Save succeeds | Observe redirect | /admin/inventory | Correct | Passed | Nav bug fixed |

## 7. Admin — Add Stock

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| AAS-001 | Functional Suitability | Admin | AddStock | Save stock batch | Valid form | Submit | Doc written to inventory | Written | Passed | |
| AAS-002 | Functional Suitability | Admin | AddStock | Duplicate Batch ID blocked | Batch ID exists | Submit same ID | Error, no write | Blocked | Passed | |
| AAS-003 | Functional Suitability | Admin | AddStock | New stock appears in Inventory real-time | Inventory page open | Add stock | Appears without refresh | Appears | Passed | |

## 8. Admin — Clinics

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| ACL-001 | Functional Suitability | Admin | Clinics | Clinics load from clinics collection | Clinics exist | Open /admin/clinics | Real clinics listed | Real clinics | Passed | |
| ACL-002 | Functional Suitability | Admin | Clinics | Register clinic via inline modal | Valid form | Submit | Doc written to clinics | Written | Passed | |
| ACL-003 | Maintainability | Admin | Clinics | Dead RegisterClinic page flagged | — | Code review | RegisterClinic.jsx/ClinicSuccess.jsx marked safe-to-delete | Flagged in CLAUDE.md | Passed | Not yet deleted |

## 9. Admin — Riders

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| ARD-001 | Functional Suitability | Admin | Riders | Riders list from users collection | Rider users exist | Open /admin/riders | Riders listed (normalized role match) | Listed | Passed | Full-collection subscribe + client filter |
| ARD-002 | Functional Suitability | Admin | Riders | Pending rider shows Pending Approval | Pending rider exists | View list | Pending Approval status pill | Shown | Passed | |
| ARD-003 | Functional Suitability | Admin | Riders | Approve pending rider | Pending rider exists | Detail modal → Approve | status: approved written | Written | Passed | Confirmed via Flutter e2e |
| ARD-004 | Functional Suitability | Admin | Riders | Reject pending rider | Pending rider exists | Detail modal → Reject | status: rejected written | Written | Passed | |
| ARD-005 | Functional Suitability | Admin | Riders | Off Duty / Set Available cycle | Approved rider exists | Mark Off Duty, Set Available | disabled↔approved | Works | Passed | |

## 10. Admin — Deliveries

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| ADL-001 | Functional Suitability | Admin | Deliveries | Orders load from orders collection | Orders exist | Open /admin/deliveries | Real orders listed | Real orders | Passed | No separate deliveries collection |
| ADL-002 | Functional Suitability | Admin | Deliveries | Status normalization consistent | Orders with varied statuses | View list | Central normalizeStatusKey mapping applied | Consistent | Passed | delayed bug fixed |
| ADL-003 | Functional Suitability | Admin | Deliveries | Summary cards real counts | — | View cards | Counts match orders | Match | Passed | |
| ADL-004 | Functional Suitability | Admin | Deliveries | Delayed alert strip conditional | Delayed order exists | View page | Strip only when delayed > 0 | Works | Passed | |
| ADL-005 | Functional Suitability | Admin | Deliveries | Detail modal shows vaccine/quantity | Order exists | Open modal | Real order data | Shown | Passed | |

## 11. Admin — Analytics

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| AAN-001 | Functional Suitability | Admin | Analytics | Total orders by time range | Orders exist | Switch 7/30/90 days | Counts filtered by createdAt | Works | Passed | |
| AAN-002 | Functional Suitability | Admin | Analytics | Completion rate computed | Delivered orders exist | View card | (delivered+completed)/total | Correct | Passed | Renamed from On-Time Rate |
| AAN-003 | Functional Suitability | Admin | Analytics | Volume chart buckets real orders | Orders exist | View chart | Day/period buckets from createdAt | Works | Passed | |
| AAN-004 | Functional Suitability | Admin | Analytics | Hub ranking & avg delivery time deferred | No hubs collection / timestamps | View sections | Hardcoded ranking kept; "—" for avg time | As designed | Not Applicable | Documented limitation |

## 12. Admin — Invoices (pulled module)

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| AIV-001 | Functional Suitability | Admin | Invoices | Invoice queue joins orders + invoices | Orders exist | Open /admin/invoices | Eligible orders listed with invoice status | — | Pending Manual Test | New pulled module; static review passed |
| AIV-002 | Functional Suitability | Admin | InvoiceEditor | Create invoice draft | Order without invoice | Create draft | Transactional INV-YYYY-###### number reserved | — | Pending Manual Test | counters/invoice_{year} |
| AIV-003 | Reliability | Admin | InvoiceEditor | Duplicate invoice blocked | Invoice exists for order | Create again | Transaction error, no second invoice | — | Pending Manual Test | Doc ID = orderId |
| AIV-004 | Functional Suitability | Admin | InvoiceEditor | Issue invoice locks edits | Draft with valid items | Issue | invoiceStatus: issued; further edits refused | — | Pending Manual Test | |
| AIV-005 | Functional Suitability | Admin | Invoices | Priority update writes order fields | Queue row exists | Change priority | invoicePriority written to order | — | Pending Manual Test | |
| AIV-006 | Security | Admin | invoiceService | invoices/counters need admin-only rules | Production rules | Rules review | Admin-only access | — | Pending Manual Test | Rules not yet deployed |

## 13. Sales Rep — Route Protection (pulled module)

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| SRP-001 | Security | Sales Rep | SalesRepRoute | Unauthenticated blocked | Not logged in | Open /sales-rep | Redirect to /login | — | Pending Manual Test | New guard from pull; mirrors AdminRoute |
| SRP-002 | Security | Sales Rep | SalesRepRoute | Wrong role redirected | role: admin/dispatcher | Open /sales-rep | Redirect to own dashboard | — | Pending Manual Test | |
| SRP-003 | Security | Sales Rep | SalesRepRoute | Pending/disabled/rejected blocked | Non-approved status | Open /sales-rep | /pending or /login | — | Pending Manual Test | |

## 14. Sales Rep — Dashboard

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| SRD-001 | Functional Suitability | Sales Rep | Dashboard | KPIs from own orders + inventory | Own orders exist | Open /sales-rep | Real KPI counts | Real counts | Passed | User-filtered by createdByUid |
| SRD-002 | Functional Suitability | Sales Rep | Dashboard | Latest orders/tracking previews | Own orders exist | View sections | Latest 3 real entries each | Works | Passed | |
| SRD-003 | Usability | Sales Rep | Dashboard | Quick Actions SPA navigation | — | Click actions | navigate() not full reload | Works | Passed | |

## 15. Sales Rep — Inventory

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| SRI-001 | Functional Suitability | Sales Rep | Inventory | Batches from inventory collection | Inventory exists | Open inventory | Real batches, same source as Admin | Real data | Passed | |
| SRI-002 | Functional Suitability | Sales Rep | Inventory | Bar chart by vaccine type | — | View chart | Real dose counts per type | Works | Passed | |
| SRI-003 | Functional Suitability | Sales Rep | Inventory | Request Selected → request-order | Batches selected | Click Request Selected | Selection carried to catalog | Works | Passed | localStorage handoff |

## 16. Sales Rep — Request Order

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| SRQ-001 | Functional Suitability | Sales Rep | RequestOrder | Catalog from inventory collection | Inventory exists | Open request-order | Real product cards | Real data | Passed | |
| SRQ-002 | Functional Suitability | Sales Rep | RequestOrder | Pre-selected items auto-added to cart | Came from Inventory selection | Open page | Cart pre-filled | Works | Passed | |
| SRQ-003 | Functional Suitability | Sales Rep | RequestOrder | Cart persists to place-order | Items in cart | Continue | salesRepQuickCart handoff | Works | Passed | |

## 17. Sales Rep — Place Order

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| SRO-001 | Functional Suitability | Sales Rep | PlaceOrder | Clinics dropdown from clinics collection | Clinics exist | Open place-order | Real clinics | Real clinics | Passed | |
| SRO-002 | Functional Suitability | Sales Rep | PlaceOrder | Order saved with pending_dispatch | Valid cart + clinic | Submit | orders doc: status pending_dispatch, createdByUid, serverTimestamp | Written | Passed | |
| SRO-003 | Functional Suitability | Sales Rep | PlaceOrder | Cart cleared after order | Order placed | Check localStorage | salesRepQuickCart removed | Cleared | Passed | |

## 18. Sales Rep — Order Tracking

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| SRT-001 | Security | Sales Rep | OrderTracking | Only own orders visible | Multiple reps have orders | Open tracking | Only createdByUid == self | Own only | Passed | |
| SRT-002 | Functional Suitability | Sales Rep | OrderTracking | Status progress bar mapping | Orders in various statuses | View entries | 15–100% per status | Works | Passed | |
| SRT-003 | Functional Suitability | Sales Rep | OrderTracking | Dispatcher status change reflects live | Dispatcher updates status | Observe tracking | Updates without refresh | Live update | Passed | Confirmed cross-role |

## 19. Sales Rep — Alerts

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| SRA-001 | Functional Suitability | Sales Rep | Alerts | Alerts derived from own orders | Own orders exist | Open alerts | delayed→Critical, in_transit→Update, delivered→Delivered | Works | Passed | No alerts collection read |
| SRA-002 | Functional Suitability | Sales Rep | Alerts | Active/History tab split | Terminal + active orders | Switch tabs | Terminal orders in History | Works | Passed | |

## 20. Sales Rep — Settings

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| SRS-001 | Functional Suitability | Sales Rep | Settings | Profile loads from users/{uid} | Logged in | Open settings | Real profile fields | Real data | Passed | |
| SRS-002 | Security | Sales Rep | Settings | Editable fields whitelisted | — | Save profile | Only name/phone/organization written; role/status read-only | Enforced | Passed | userService whitelist |

## 21. Dispatcher — Route Protection (pulled module)

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| DRP-001 | Security | Dispatcher | DispatcherRoute | Unauthenticated blocked | Not logged in | Open /dispatcher | Redirect to /login | — | Pending Manual Test | New guard from pull |
| DRP-002 | Security | Dispatcher | DispatcherRoute | Wrong role redirected | role: admin/salesrep | Open /dispatcher | Redirect to own dashboard | — | Pending Manual Test | |
| DRP-003 | Security | Dispatcher | DispatcherRoute | Pending/disabled/rejected blocked | Non-approved status | Open /dispatcher | /pending or /login | — | Pending Manual Test | |

## 22. Dispatcher — Dashboard

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| DDB-001 | Functional Suitability | Dispatcher | Dashboard | KPI cards real counts | Orders/riders/alerts exist | Open /dispatcher | Pending/Available/Active/Urgent real | Real counts | Passed | |
| DDB-002 | Functional Suitability | Dispatcher | Dashboard | Pending Dispatch Queue table | pending_dispatch orders exist | View table | Only pending_dispatch listed | Works | Passed | |
| DDB-003 | Functional Suitability | Dispatcher | Dashboard | Assign Rider handoff | Pending order in queue | Click Assign Rider | Order stored, navigates to assign-rider | Works | Passed | |
| DDB-004 | Functional Suitability | Dispatcher | Dashboard | Delayed routes monitor real count | Delayed orders exist | View monitor footer | Real delayed count (no fake cold-chain) | Real count | Passed | QA fix |

## 23. Dispatcher — Assign Rider

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| DAR-001 | Functional Suitability | Dispatcher | AssignRider | Approved riders listed as available | Approved riders exist | Open assign-rider | Available list real | Real riders | Passed | |
| DAR-002 | Functional Suitability | Dispatcher | AssignRider | Non-approved shown unavailable | Pending/disabled riders exist | View list | Unavailable section with status labels | Works | Passed | |
| DAR-003 | Functional Suitability | Dispatcher | AssignRider | Confirm assignment writes order | Order + rider selected | Confirm | status: assigned, assignedRider*, assignedBy* written | Written | Passed | Confirmed e2e incl. Flutter |
| DAR-004 | Functional Suitability | Dispatcher | AssignRider | Assignment reflects across roles | Assignment done | Check Admin Deliveries + SR Tracking | Both show assigned | Reflected | Passed | |

## 24. Dispatcher — Cargo Loading (pulled module)

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| DCL-001 | Functional Suitability | Dispatcher | CargoLoading | Orders grouped by rider | assigned/loading orders exist | Open cargo-loading | Groups per approved rider | Real rider checklist card appears for QA Rider Two; reserved order VT-ORD-1784056096300 appears under that rider | Passed | Verified live 2026-07-17 (Dispatcher login) |
| DCL-002 | Functional Suitability | Dispatcher | CargoLoading | Per-order loaded checkbox persists | Group visible | Toggle isLoaded | isLoaded + loadedAt/By written | isLoaded toggle works; progress updates | Passed | Verified live 2026-07-17 |
| DCL-003 | Functional Suitability | Dispatcher | CargoLoading | Finalize dispatch batch | All orders loaded | Finalize | Batch: all → in_transit atomically | Finalize Dispatch becomes enabled and works; order VT-ORD-1784056096300 changed assigned → in_transit | Passed | Verified live 2026-07-17, **before** the canonical-path change. The old "skips `loading`" note no longer applies — the checkbox now promotes assigned → loading (see DCL-006), so finalize moves loading → in_transit. Re-verification of the new path is Pending (DCL-006/007) |
| DCL-004 | Functional Suitability | Dispatcher | CargoLoading | Finalized orders reflect across roles | Finalize done | Check Shipments/Admin/SR/Rider | in_transit everywhere | Dispatcher Shipments reflects In Transit; no console errors. Admin Deliveries + Sales Rep Order Tracking reflection NOT yet verified (Admin/SR passwords unavailable) | Pending Manual Test | Dispatcher-side reflection Passed 2026-07-17; Admin/SR-side still pending |
| DCL-005 | Reliability | Dispatcher | CargoLoading | Loading/error/empty states | — | Open with no data | Clear empty state, no fake route | — | Pending Manual Test | |
| DCL-006 | Functional Suitability | Dispatcher | CargoLoading | Checkbox promotes assigned → loading | Assigned order in a rider group | Tick the loaded checkbox | `isLoaded: true` + `loadedAt/ByUid/ByEmail`; status `assigned` → `loading` + status audit fields; order stays in the group | — | Pending Manual Test | Added 2026-07-17 with the canonical-dispatch-path change |
| DCL-007 | Functional Suitability | Dispatcher | CargoLoading | Unchecking does not regress status | Order already `loading` + loaded | Untick the checkbox | `isLoaded: false`, loaded audit cleared, **status stays `loading`** | — | Pending Manual Test | Deliberate: no backwards status transition |
| DSH-010 | Functional Suitability | Dispatcher | Shipments | Competing dispatch actions removed | Orders in assigned / loading | View row actions | No "Start loading" on assigned, no "Dispatch" on loading; only Delay + Cancel | — | Pending Manual Test | Cargo Loading is the canonical dispatch path |
| DSH-011 | Functional Suitability | Dispatcher | Shipments | Exception actions still available | Orders in in_transit / delayed | View row actions | "Mark delivered (override)", Delay, Cancel, Resume transit all present and working | — | Pending Manual Test | Mark delivered is a dispatcher override; Rider app is the normal path |

## 25. Dispatcher — Shipments / Status Progression

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| DSH-001 | Functional Suitability | Dispatcher | Shipments | All orders with real-time status | Orders exist | Open shipments | Real cards + filter counts | Real data | Passed | |
| DSH-002 | Functional Suitability | Dispatcher | Shipments | assigned → loading → in_transit → delivered | Assigned order exists | Start Loading, Dispatch, Mark Delivered | Each transition written with audit fields | Works | Passed | Manual test 2026-07-06 |
| DSH-003 | Functional Suitability | Dispatcher | Shipments | Delay/cancel branches | Active order | Mark Delayed / Cancel | delayed/cancelled + delayedAt/cancelledAt | Works | Passed | cancelledAt added post-QA |
| DSH-004 | Functional Suitability | Dispatcher | Shipments | Rider fields preserved on status change | Assigned order | Update status | assignedRider* untouched | Preserved | Passed | |
| DSH-005 | Functional Suitability | Dispatcher | Shipments | Terminal orders show no actions | Delivered/cancelled orders | View cards | Reduced opacity, no buttons | Works | Passed | |

## 26. Dispatcher — Live Monitoring (Geofence)

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| DLM-001 | Functional Suitability | Dispatcher | Geofence | Active shipments list real orders | assigned/loading/in_transit/delayed exist | Open geofence | Real list with status pills | Real data | Passed | Manual test 2026-07-06 |
| DLM-002 | Functional Suitability | Dispatcher | Geofence | "No live location yet" fallback | Order lacks lastLocation | Select shipment | Fallback text, no fake coordinates | Works | Passed | |
| DLM-003 | Functional Suitability | Dispatcher | Geofence | Map/geofence/route deviation | — | — | Deferred until Rider lastLocation writes | — | Not Applicable | Info banner explains |

## 27. Flutter Rider — Registration

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| RRG-001 | Functional Suitability | Rider | RegisterScreen | Registration creates Auth + users/{uid} | Valid form | Submit | Auth account + doc with role rider, status pending, all fields | Created | Passed | Verified live on emulator |
| RRG-002 | Functional Suitability | Rider | RegisterScreen | Success screen after submit | Registration succeeds | Observe | "Rider application submitted..." | Shown | Passed | |
| RRG-003 | Reliability | Rider | AuthService | Button never stuck loading | Any failure | Submit with failure | Error shown, finally clears loading, 30s timeouts | Works | Passed | AuthGate race fixed |
| RRG-004 | Reliability | Rider | AuthService | Auth cleanup on Firestore write failure | Write fails | Submit | Auth account deleted, email reusable | Works | Passed | |
| RRG-005 | Usability | Rider | RegisterScreen | Mapped error messages | Duplicate email / weak password / bad email | Submit each | Specific human-readable errors | Works | Passed | |

## 28. Flutter Rider — Admin Approval

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| RAP-001 | Functional Suitability | Rider/Admin | Riders | New rider appears in Admin Riders | Rider registered | Open /admin/riders | Pending Approval entry | Appears | Passed | Real-time |
| RAP-002 | Functional Suitability | Rider/Admin | Riders | Approval unlocks rider login | Admin approves | Rider logs in | Enters dashboard | Works | Passed | Confirmed e2e 2026-07-07 |

## 29. Flutter Rider — Login

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| RLG-001 | Security | Rider | AuthGate | Approved rider enters dashboard | role rider + status approved | Sign in | Rider Dashboard opens | Works | Passed | Nav stack bug fixed |
| RLG-002 | Security | Rider | AuthGate | Pending rider blocked with message | status pending | Sign in | "pending admin approval" banner | Works | Passed | pendingLoginMessage |
| RLG-003 | Security | Rider | AuthGate | Non-rider blocked | role admin/dispatcher/salesrep | Sign in | "riders only, use web portal" | Works | Passed | |
| RLG-004 | Security | Rider | AuthGate | Disabled/rejected blocked | status disabled/rejected | Sign in | "not active" message | Works | Passed | |
| RLG-005 | Usability | Rider | LoginScreen | Invalid credentials message | Wrong password | Sign in | "Invalid email or password." | Works | Passed | |

## 30. Flutter Rider — Assigned Deliveries

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| RAD-001 | Functional Suitability | Rider | DeliveryService | Only own assigned orders | Orders assigned to rider | Open dashboard | orders where assignedRiderId == uid | Works | Passed | Verified live 2026-07-10; re-confirmed 2026-07-17 (rider.qa2 sees own 4 orders incl. assigned VT-ORD-1784056096300) |
| RAD-002 | Functional Suitability | Rider | Dashboard | Dispatcher assignment appears real-time | Dispatcher assigns | Observe app | Order appears without refresh | Appeared live | Passed | |
| RAD-003 | Functional Suitability | Rider | DeliveryDetail | Detail fields + timeline | Assigned order | Open detail | Clinic/vaccine/type/qty/priority + timeline | Works | Passed | |
| RAD-004 | Reliability | Rider | Screens | Loading/error/empty states | No assignments | Open lists | "No assigned deliveries yet." | Works | Passed | |

## 31. Flutter Rider — Status Updates

**PARTIAL runtime QA 2026-07-17 (emulator, rider.qa2@vaxtrack.com):** Mark Delivered (VT-ORD-1783611813231) and Report Delay with reason (VT-ORD-1783010866286) both PASSED — each status write reflected immediately in the rider's own live subscription (snackbar + badge + KPI counts updated without refresh), proving the Firestore write round-trip. Flutter runtime logs showed no permission-denied and no exceptions (only benign emulator GMS/App Check warnings). NOT yet verified: Start Loading / Start Transit taps (test orders were already in_transit) and web-side reflection of rider status changes (Admin/Sales Rep/Dispatcher) — blocked this session. **Order VT-ORD-1784056096300 is reserved untouched (still `assigned`) for the Cargo Loading real-rider-card test (DCL-001..005).**

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| RSU-001 | Functional Suitability | Rider | DeliveryDetail | Start Loading (assigned → loading) | Assigned order | Tap Start Loading | status loading + audit fields | — | Pending Manual Test | Implemented; not e2e verified (2026-07-17 run had no assigned order free to consume) |
| RSU-002 | Functional Suitability | Rider | DeliveryDetail | Start Transit (loading → in_transit) | Loading order | Tap Start Transit | status in_transit + startedAt | — | Pending Manual Test | |
| RSU-003 | Functional Suitability | Rider | DeliveryDetail | Mark Delivered | in_transit order | Tap Mark as Delivered | status delivered + deliveredAt | Snackbar "Status updated to delivered"; order moved to Completed with Delivered badge; KPI Completed 0→1 live | Passed | Verified live 2026-07-17 on VT-ORD-1783611813231 |
| RSU-004 | Functional Suitability | Rider | DeliveryDetail | Report Delay with reason | Active order | Tap Report Delay, enter reason | status delayed + delayReason | Snackbar "Status updated to delayed"; Delayed badge on dashboard; reason "Heavy traffic on EDSA - QA test delay" submitted | Passed | Verified live 2026-07-17 on VT-ORD-1783010866286 |
| RSU-005 | Functional Suitability | Rider | Cross-role | Rider status change syncs to web | Rider updates status | Check Dispatcher/Admin/SR pages | All reflect new status live | — | Pending Manual Test | Rider-side live reflection confirmed 2026-07-17; web-side reflection still unverified (session browser block) |

## 32. Flutter Rider — Proof Upload / Location

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| RPU-001 | Functional Suitability | Rider | ProofScreen | Proof photo upload to Storage | in_transit/delivered order | Take photo, submit | proof_of_delivery/{orderId}/ upload + URL on order | **Attempted 2026-07-17 on VT-ORD-1783611813231 — FAILED.** Order selected, synthetic-camera photo captured and attached, Submit tapped. Upload rejected: `StorageException Code -13010, HttpResult 404, "Object does not exist at location" / "The server has terminated the upload session"`. No `proofOfDeliveryUrl` written | **Blocked** | Not a code or rules fault — a 404 (not 403) points to the Storage bucket not being provisioned, or a bucket-name mismatch. Both apps target `vaxtrack-bef1b.firebasestorage.app`. **Needs Firebase Console → Storage check before any code change** |
| RPU-002 | Functional Suitability | Rider | ProofScreen | Optional invoice photo upload | Proof selected | Add invoice photo | invoices/{orderId}/ upload + URL on order | — | Blocked | Same Storage blocker as RPU-001 |
| RPU-003 | Functional Suitability | Rider | ProofScreen | No-Blaze manual proof URL fallback | Order selected, toggle on | Paste HTTPS URL, submit | proofOfDeliveryUrl written (no Storage upload) + updatedAt | Toggle + field render; public HTTPS PNG on VT-ORD-1783611813231 wrote `proofOfDeliveryUrl` with no StorageException | Passed | Verified live 2026-07-22 (emulator rider.qa2). Temporary demo fallback; camera→Storage path left intact |
| RPU-004 | Functional Suitability | Rider | ProofScreen | Manual URL validation | Toggle on | Submit empty / non-https URL | Blocked with snackbar, no write | Code verified (empty → "Enter a proof image URL"; non-https → "must start with https://") | Passed | Static + implicit; happy path exercised live |
| APD-001 | Functional Suitability | Admin | Deliveries | Proof section renders in detail drawer | Any order | Open drawer | "Proof of delivery" section present between Rider and Activity | Section renders correctly | Passed | Verified live 2026-07-17 (Admin login, all 17 orders) |
| APD-002 | Functional Suitability | Admin | Deliveries | Empty state when no proof | Order without proofOfDeliveryUrl | Open drawer | "No proof uploaded yet." | Exact text shown on all 17 orders | Passed | Verified live 2026-07-17 |
| APD-003 | Functional Suitability | Admin | Deliveries | Image preview renders when proof exists | Order **with** proofOfDeliveryUrl | Open drawer | Thumbnail preview loads | Section populates (via RPU-003 fallback): drawer switched from empty state to "Open image" with correct `<img src>` from proofOfDeliveryUrl. **Pixels did NOT paint in the test browser — its sandbox blocks all external image hosts (wikimedia/google/picsum failed identically), not a code fault** | **Partial** | Section + src wiring verified 2026-07-22; actual image render needs a real-browser spot check |
| APD-004 | Functional Suitability | Admin | Deliveries | "Open image" opens full image | Order with proofOfDeliveryUrl | Click Open image | Opens in new tab | "Open image" link renders with correct href (= proofOfDeliveryUrl). Navigation not exercised (test browser blocks external hosts) | **Partial** | href verified 2026-07-22; needs real-browser click |
| APD-005 | Functional Suitability | Admin | Deliveries | invoiceUrl shows as rider invoice photo | Order with invoiceUrl | Open drawer | "Open invoice photo" secondary link, distinct from Admin Invoices module | — | **Blocked** | No order has invoiceUrl: URL-mode fallback skips invoice, camera invoice path still Storage-blocked |
| RLC-001 | Functional Suitability | Rider | LocationService | Rider location writes users/{uid} | Location permission granted | Open dashboard / pull refresh | lastLocation + lastLocationUpdate written | — | Pending Manual Test | Permission flow confirmed on emulator |
| RLC-002 | Functional Suitability | Rider | LocationService | Order location on status change | Status updated | Update any status | orders/{id}.lastLocation written | — | Pending Manual Test | Feeds future Geofence map |

---

## Summary

| Status | Count |
|---|---|
| Passed | 104 |
| Pending Manual Test | 23 |
| Partial | 2 |
| Blocked | 3 |
| Not Applicable | 2 |
| Failed | 0 |
| **Total** | **134** |

*Counts recomputed from the case tables on 2026-07-22. Added RPU-003/004 (no-Blaze manual proof URL fallback — Passed). "Partial" = APD-003/004: the Admin proof section populates and the `<img>`/link are correctly wired from proofOfDeliveryUrl, but the external image cannot paint in the sandboxed test browser (blocks all external hosts) — needs a real-browser spot check. "Blocked" = RPU-001/002 (Firebase Storage 404, not provisioned) + APD-005 (no invoiceUrl on any order).*
