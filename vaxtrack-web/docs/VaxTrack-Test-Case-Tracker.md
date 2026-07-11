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
| DCL-001 | Functional Suitability | Dispatcher | CargoLoading | Orders grouped by rider | assigned/loading orders exist | Open cargo-loading | Groups per approved rider | — | Pending Manual Test | New pulled module; static review passed |
| DCL-002 | Functional Suitability | Dispatcher | CargoLoading | Per-order loaded checkbox persists | Group visible | Toggle isLoaded | isLoaded + loadedAt/By written | — | Pending Manual Test | |
| DCL-003 | Functional Suitability | Dispatcher | CargoLoading | Finalize dispatch batch | All orders loaded | Finalize | Batch: all → in_transit atomically | — | Pending Manual Test | Skips 'loading' status (process note) |
| DCL-004 | Functional Suitability | Dispatcher | CargoLoading | Finalized orders reflect across roles | Finalize done | Check Shipments/Admin/SR/Rider | in_transit everywhere | — | Pending Manual Test | |
| DCL-005 | Reliability | Dispatcher | CargoLoading | Loading/error/empty states | — | Open with no data | Clear empty state, no fake route | — | Pending Manual Test | |

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
| RAD-001 | Functional Suitability | Rider | DeliveryService | Only own assigned orders | Orders assigned to rider | Open dashboard | orders where assignedRiderId == uid | Works | Passed | Verified live 2026-07-10 |
| RAD-002 | Functional Suitability | Rider | Dashboard | Dispatcher assignment appears real-time | Dispatcher assigns | Observe app | Order appears without refresh | Appeared live | Passed | |
| RAD-003 | Functional Suitability | Rider | DeliveryDetail | Detail fields + timeline | Assigned order | Open detail | Clinic/vaccine/type/qty/priority + timeline | Works | Passed | |
| RAD-004 | Reliability | Rider | Screens | Loading/error/empty states | No assignments | Open lists | "No assigned deliveries yet." | Works | Passed | |

## 31. Flutter Rider — Status Updates

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| RSU-001 | Functional Suitability | Rider | DeliveryDetail | Start Loading (assigned → loading) | Assigned order | Tap Start Loading | status loading + audit fields | — | Pending Manual Test | Implemented; not e2e verified |
| RSU-002 | Functional Suitability | Rider | DeliveryDetail | Start Transit (loading → in_transit) | Loading order | Tap Start Transit | status in_transit + startedAt | — | Pending Manual Test | |
| RSU-003 | Functional Suitability | Rider | DeliveryDetail | Mark Delivered | in_transit order | Tap Mark as Delivered | status delivered + deliveredAt | — | Pending Manual Test | |
| RSU-004 | Functional Suitability | Rider | DeliveryDetail | Report Delay with reason | Active order | Tap Report Delay, enter reason | status delayed + delayReason | — | Pending Manual Test | |
| RSU-005 | Functional Suitability | Rider | Cross-role | Rider status change syncs to web | Rider updates status | Check Dispatcher/Admin/SR pages | All reflect new status live | — | Pending Manual Test | Next planned phase |

## 32. Flutter Rider — Proof Upload / Location

| Test Case ID | ISO 25010 Category | Role | Module | Test Scenario | Preconditions | Test Steps | Expected Result | Actual Result | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|
| RPU-001 | Functional Suitability | Rider | ProofScreen | Proof photo upload to Storage | in_transit/delivered order | Take photo, submit | proof_of_delivery/{orderId}/ upload + URL on order | — | Pending Manual Test | Implemented; needs device camera test |
| RPU-002 | Functional Suitability | Rider | ProofScreen | Optional invoice photo upload | Proof selected | Add invoice photo | invoices/{orderId}/ upload + URL on order | — | Pending Manual Test | |
| RLC-001 | Functional Suitability | Rider | LocationService | Rider location writes users/{uid} | Location permission granted | Open dashboard / pull refresh | lastLocation + lastLocationUpdate written | — | Pending Manual Test | Permission flow confirmed on emulator |
| RLC-002 | Functional Suitability | Rider | LocationService | Order location on status change | Status updated | Update any status | orders/{id}.lastLocation written | — | Pending Manual Test | Feeds future Geofence map |

---

## Summary

| Status | Count |
|---|---|
| Passed | 95 |
| Pending Manual Test | 26 |
| Not Applicable | 2 |
| Failed | 0 |
| **Total** | **123** |
