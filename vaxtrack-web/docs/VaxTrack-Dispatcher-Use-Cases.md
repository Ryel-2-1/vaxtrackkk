# VaxTrack — Dispatcher Use Cases

Written from the code on `codex/ui-changes` (14 Nov 2026). Every rule below is enforced on the server (Cloud Functions in `functions/src/`) or by the Firestore rules, unless marked as a screen-only convenience. Refusal codes are the server's stable `code`; the quoted text is the message the Dispatcher sees.

**Actor:** Dispatcher — a web user whose `users/{uid}` has `role: "dispatcher"` and `status: "approved"`. Admins may also run UC-D04, UC-D05, UC-D07 and UC-D12; they are listed here because the Dispatcher owns them day to day.

**Screens** (`src/pages/dispatcher/`, inside the `DispatcherLayout` shell):

| Screen | Route | Use cases |
|---|---|---|
| Dashboard | `/dispatcher` | UC-D01 |
| Calendar | `/dispatcher/schedule` | UC-D02 |
| Assign Rider | `/dispatcher/assign-rider` | UC-D04, UC-D05 |
| Shipments | `/dispatcher/shipments` | UC-D11, UC-D13, UC-D14, UC-D15, UC-D16 |
| Delivery Monitoring | `/dispatcher/geofence` | UC-D08, UC-D10 |
| Cargo Loading | `/dispatcher/cargo-loading` | UC-D06, UC-D07, UC-D09, UC-D12 |
| Live Tracking | `/dispatcher/live-tracking` | UC-D10 |
| Settings | `/dispatcher/settings` | UC-D17 |

**Common refusals** (any server call):

| Code | When | Message |
|---|---|---|
| `profile-missing` | No `users` document | "Your account profile could not be found." |
| `wrong-role` | Not a Dispatcher (or Admin where allowed) | "Your account cannot perform this action." |
| `not-approved` | Account not approved | "Your account is not approved." |

**Order lifecycle the Dispatcher drives:** `pending_dispatch` → `assigned` → `loading` → `in_transit` → `delivered`, with the branches `delayed`, `delivery_failed` and `cancelled`. **Rider trip states** (server-owned `riderDispatchStates`): `available_at_hub` → `trip_forming` → `on_trip` → `returning_to_hub` → back to `available_at_hub`.

---

## UC-D00 — Sign in and accept the Terms

| | |
|---|---|
| **Screen** | Login, then the Terms gate (`TermsGate`) |
| **Preconditions** | A Dispatcher account exists (created by an Admin through Add Staff). |
| **Trigger** | The Dispatcher opens the portal. |

**Main flow**
1. The Dispatcher signs in with email and password.
2. `DispatcherRoute` reads `users/{uid}` and lets in only an approved Dispatcher.
3. If the account has not agreed to the current Terms of Use and Data Privacy notice, the Terms screen appears. The Dispatcher ticks the box and presses **Agree and continue**; the version and time are saved to the profile.
4. The Dashboard opens.

**Exceptions**
- Wrong email or password: "Invalid email or password." (one message for every failure).
- A rider account is refused at the web login.
- Unknown role or status: the route guard fails closed and the portal does not open.
- **Sign out** on the Terms screen leaves without agreeing.

**Postconditions:** the Dispatcher is in the portal; the Terms acceptance is recorded.

---

## UC-D01 — See what needs attention (Dashboard)

| | |
|---|---|
| **Screen** | Dashboard (`DispatcherDashboard.jsx`) |
| **Preconditions** | Signed in. |
| **Trigger** | The Dispatcher opens the Dashboard. |

**Main flow**
1. The Dashboard shows four counters, each a button:
   - **Urgent orders**: urgent orders ready for dispatch. Opens the assignment queue.
   - **Awaiting assignment**: orders ready for dispatch, with how many are past their requested date (`dashboardAttention.js`), how many are upcoming and how many need scheduling. Opens the queue.
   - **Cargo loading**: orders assigned or being loaded. Opens Cargo Loading.
   - **Out for delivery**: orders in transit or delayed, with how many are behind schedule. Opens Shipments.
2. The **Pending Dispatch Queue** lists orders whose requested day has begun (Manila), soonest first, urgent first within a day, with an **Assign Rider** button per row ("Waiting for stock" when the order is not fully reserved; continues in UC-D04).
3. Below it: the live delivery overview, the Dispatch Summary (priority, rider availability, route condition, requested arrival), and two read-only lists: **Scheduled for a later date** and **Orders without a usable delivery date**.

**Alternate flows**
- An order dated in the future is shown under Upcoming, read-only: "This order is scheduled for {date} and cannot be dispatched yet." It joins the queue at 00:00 Manila on its date.
- An order with no valid date appears under Needs scheduling; an Admin must store a date first.
- An order still waiting for stock cannot be assigned: "This order is still waiting for stock. It can be assigned once every item is fully reserved."

**Exceptions:** a list that fails to load shows "—" instead of a false zero, with a notice.

**Postconditions:** none; read-only.

---

## UC-D02 — View the Delivery Calendar

| | |
|---|---|
| **Screen** | Calendar (`DispatcherSchedule.jsx` → `DeliveryCalendar`, role `dispatcher`) |
| **Preconditions** | Signed in. |
| **Trigger** | The Dispatcher opens the Calendar. |

**Main flow**
1. The month grid shows scheduled orders per day, with a red dot for urgent ones. Only the visible month plus open orders are read (`subscribeCalendarDeliveries`).
2. The Dispatcher filters by status and priority, picks a day, and sees that day's orders, ten per page.
3. Each order shows its Med Rep's name, looked up once per visit through `getOrderMedRepNames` (at most 20 orders per call; the Dispatcher never reads the staff directory).
4. Orders with no valid date are listed separately as needing scheduling.

**Business rule:** the Dispatcher **cannot** change a delivery date here. Rescheduling (`rescheduleOrderDelivery`) is for the Admin (any open order) and for the order's own Med Rep (until the rider leaves, with a reason).

**Exceptions**
- Name lookup failure: the row shows "Name unavailable".
- Calendar load failure: "Could not load the delivery calendar".

**Postconditions:** none; read-only.

---

## UC-D03 — Review rider availability

| | |
|---|---|
| **Screen** | Assign Rider; Dashboard's Dispatch Summary |
| **Preconditions** | Signed in. |
| **Trigger** | The Dispatcher needs to choose a rider. |

**Main flow**
1. The screen lists approved riders with their trip state from the server: at the hub, trip forming, on a trip, or returning.
2. "Free" riders are approved riders with no active delivery.
3. If a rider's state looks stale, the Dispatcher refreshes it; the screen calls `recheckRiderTripStates` for the riders on screen (1 to the maximum allowed per call).

**Exceptions**
- `invalid-request`: "Name between 1 and {max} riders to re-check."

**Postconditions:** rider trip states are re-derived from their orders.

---

## UC-D04 — Assign a rider to an order

| | |
|---|---|
| **Screen** | Dashboard queue → Assign Rider (`DispatcherAssignRider.jsx`) |
| **Server** | `assignRiderToOrder` (`riderDispatchOps.js`); Dispatcher or Admin |
| **Preconditions** | The order is `pending_dispatch`, unassigned, its requested day has begun, and it is fully reserved. The rider is an approved rider at the hub or forming a trip. |
| **Trigger** | **Assign Rider** on a queue row, then choosing a rider. |

**Main flow**
1. The Dispatcher picks the order and a rider.
2. The server re-reads both in one transaction and re-derives the rider's trip from their orders.
3. If the rider is at the hub, a new trip is started; if a trip is already forming, the order joins it.
4. The order becomes `assigned`, linked to the rider and the trip.

**Alternate flow:** the same assignment sent twice returns the first result (`replayed`) and writes nothing.

**Exceptions**

| Code | Message |
|---|---|
| `order-not-found` | "That order no longer exists." |
| `order-not-pending` | "That order is no longer awaiting dispatch. Refresh the queue." |
| `order-already-assigned` | "That order has already been assigned to a rider." |
| `scheduled-date-not-reached` | "This order is scheduled for {date} and cannot be dispatched yet." |
| `scheduled-date-missing` / `scheduled-date-invalid` | The order has no usable delivery date. |
| `order-not-fully-reserved` | "This order is still waiting for stock. It can be assigned once every item is fully reserved." |
| `rider-not-found` | "That rider account no longer exists." |
| `not-a-rider` | "That account is not a rider." |
| `rider-not-approved` | "That rider is not approved for assignment." |
| `rider-on-trip` | "This rider has already left on a trip. New orders can be assigned after they return to the hub." |
| `rider-returning` | "This rider is returning to the hub. Confirm their return before assigning new orders." |
| `rider-state-unknown` | "This rider's trip status could not be confirmed. Refresh and try again." |
| `trip-full` | "A trip can carry at most 50 orders. Dispatch this rider first." |

**Postconditions:** order `assigned`; rider state `trip_forming`; the rider gets a push notification.

---

## UC-D05 — Add more orders to a forming trip

Same as UC-D04, choosing a rider whose trip is still forming. The order joins the existing trip (at most 50 orders). A rider who has left or is returning cannot take new orders until UC-D12.

---

## UC-D06 — Confirm orders as loaded

| | |
|---|---|
| **Screen** | Cargo Loading (`DispatcherCargoLoading.jsx`) |
| **Writes** | `updateOrderLoadedState` (`cargoLoadingService.js`), a client transaction limited by the Firestore rules |
| **Preconditions** | The order is `assigned` or `loading`, grouped under its rider. |
| **Trigger** | The Dispatcher ticks an order's **loaded** box as the vials go into the rider's box. |

**Main flow**
1. The screen lists only orders that are assigned or being loaded (`status in` assigned/loading), grouped by rider, with a loaded count.
2. Ticking an `assigned` order marks it loaded and moves it to `loading`.
3. The first tick stamps a loading audit (who and when) that is never cleared.

**Alternate flows**
- Unticking clears the loaded flag but does **not** move the order back to `assigned`; the audit stays.
- An order whose date has not been reached cannot move to `loading`.

**Exceptions**
- `order-not-found`: "That order no longer exists."
- The order's status no longer allows loading changes: a status-transition refusal.
- `not-signed-in`: "Your session has expired. Please sign in again."

**Postconditions:** loaded flags and the loading audit are saved. Once loaded, cancelling the order holds its vials as a return for Admin inspection (see UC-D13).

---

## UC-D07 — Plan the trip's departure and route (Cargo Loading)

| | |
|---|---|
| **Screen** | Cargo Loading → departure planner (`DeparturePlanner.jsx`; enabled by `VITE_DEPARTURE_PLANNER_ENABLED`, on in staging and production) |
| **Writes** | `saveRiderTripRoute` (several stops) or `saveOrderRoute` (one stop) |
| **Preconditions** | The rider's trip is forming; hub location and routing settings exist. |
| **Trigger** | The Dispatcher opens the planner for a rider's group. |

**Main flow**
1. The planner gets motorcycle travel times between the hub and each stop from Valhalla (requests spaced 1.1 s apart).
2. It suggests a stop order that meets each clinic's requested arrival (window, before a time, or exact), counting service time at each stop and waiting where allowed.
3. It shows each stop's planned arrival, any stop that misses its request, and the estimated return to the hub.
4. **Use this plan** saves the route line and the planned arrival per stop.

**Alternate flows**
- The Dispatcher may reorder stops by hand and re-check.
- A departure that has already passed is flagged; a stop that cannot be met is shown as late, never hidden.

**Exceptions**
- A route cannot be found on roads a motorcycle may use: no route is saved (no car fallback).
- Routing service unavailable: planning is blocked; saved routes keep working.
- A trip needs at least two stops for a trip route; "Refresh the destination before generating a route." when a destination changed.

**Postconditions:** the trip has a saved route and planned arrival times, used by the rider app and by server-side deviation checks.

---

## UC-D08 — Generate one order's route

| | |
|---|---|
| **Screen** | Delivery Monitoring (`DispatcherGeofence.jsx`), opened from Cargo Loading's **Generate route first** (`?order=<id>`) |
| **Writes** | `saveOrderRoute` |
| **Preconditions** | The order has a confirmed destination. |
| **Trigger** | Finalize dispatch warns that an order has no route, and the Dispatcher follows the link. |

**Main flow**
1. The page opens on the order.
2. The Dispatcher generates the route from the hub to the destination and saves it.

**Exceptions:** "Refresh the destination before generating a route." when the destination changed since the page loaded.

**Postconditions:** the order has a saved route and arrival estimate.

---

## UC-D09 — Finalize dispatch (the trip leaves)

| | |
|---|---|
| **Screen** | Cargo Loading → **Finalize dispatch** |
| **Server** | `finalizeRiderDispatch` (`riderDispatchOps.js`); Dispatcher or Admin |
| **Preconditions** | Every order in the rider's forming trip is `loading` and confirmed loaded; each order's date has been reached; reserved batches are still in date. |
| **Trigger** | The Dispatcher presses **Finalize dispatch** and confirms ("Finalize dispatch?"). |

**Main flow**
1. The dialog lists the orders and warns (without blocking) about any order with no route ETA, offering **Generate route first**. It reminds that the rider's location must be on.
2. The server re-reads the rider's whole trip and every order in one transaction. The orders sent must be exactly the trip's.
3. All orders move to `in_transit` together; delivery timing starts; the trip is marked departed.

**Exceptions**

| Code | Message |
|---|---|
| `invalid-request` | "No orders to dispatch." |
| `rider-on-trip` | "This rider still has orders out for delivery. Refresh cargo loading." |
| `trip-changed` | "This rider's trip changed. Refresh cargo loading." / "The orders for this rider changed. Refresh cargo loading and dispatch again." |
| `order-not-dispatchable` | "One of these orders is no longer ready for dispatch. Refresh cargo loading." |
| `order-not-loaded` | "Every order must be confirmed as loaded before dispatch." |
| `scheduled-date-not-reached` | "This order is scheduled for {date} and cannot be dispatched yet." |
| `order-not-fully-reserved` | The order is still waiting for stock. |
| `reserved-batch-expired` | A reserved batch expires before the delivery day: nothing leaves with it. |

**Postconditions:** orders `in_transit`; rider `on_trip`; the rider app shows the saved route; the server starts tracking deviation (500 m for 3 min), nearness to the destination, and timing (late against the route; past the requested arrival).

---

## UC-D10 — Monitor deliveries live and re-plan a trip

| | |
|---|---|
| **Screen** | Delivery Monitoring (`DispatcherGeofence.jsx`); Live Tracking (`DispatcherLiveTracking.jsx`) |
| **Writes** | `saveRiderTripRoute` (re-plan) |
| **Preconditions** | At least one rider is on a trip and sharing location. |
| **Trigger** | The Dispatcher watches the map. |

**Main flow**
1. The map shows each rider's live position, the planned route and each stop's clinic geofence.
2. The server raises alerts the Dispatcher sees: route deviation, near destination, awaiting completion (15 minutes at the destination), location not updating (10 minutes), running late, and past the requested arrival.
3. To re-plan, the Dispatcher presses **Re-optimize plan**. The planner (`planTrip`) uses the rider's current position as the start, keeps the departure fixed at now, and finds the stop order that misses the fewest requested arrivals.
4. The new route and planned arrivals are saved; the page reports whether every request is met or how many cannot be, and the estimated hub return.

**Exceptions**
- "No reachable visiting order for these stops." — no route found; nothing is saved.
- Rider location unavailable: the page explains the rider's location must be on.

**Postconditions:** the trip's route and arrival estimates reflect the rider's real position.

---

## UC-D11 — Review an offline delivery record

| | |
|---|---|
| **Screen** | Shipments → **Review offline** (`OfflineReviewDialog.jsx`) |
| **Server** | `resolveOfflineCompletionReview` (`offlineCompletionOps.js`); Dispatcher or Admin |
| **Preconditions** | A rider completed a delivery with no signal; the server could not accept it automatically (outside 3 hours, outside the clinic area, inconsistent with the rider's trail, or a mocked location). |
| **Trigger** | An "offline review" alert or the order's row in Shipments. |

**Main flow**
1. The dialog shows the rider's photos, recipient, GPS fix, distance from the clinic and why it was held.
2. **Approve**: the server completes the order (`delivered`, `completionMode: offline_approved`) and consumes stock exactly once.
3. **Reject** (a reason is required): the order stays `in_transit`; the rider completes it live or reports a failure; the reason reaches the rider app.

**Exceptions**

| Code | Message |
|---|---|
| `invalid-payload` | "Choose approve or reject." / "That delivery could not be identified." |
| `note-required` | "Add a reason for rejecting this offline delivery." |
| `no-pending-review` | "This delivery has no offline record waiting for review." |
| `review-changed` | "This offline record changed while you were reviewing it. Open it again." |
| `order-not-found` | "That delivery no longer exists." |

**Postconditions:** the review alert is resolved; the order is either delivered or still in transit.

---

## UC-D12 — Confirm a rider's return to the hub

| | |
|---|---|
| **Screen** | Cargo Loading (returning riders) |
| **Server** | `confirmRiderReturnToHub` (`riderDispatchOps.js`); Dispatcher or Admin |
| **Preconditions** | Every order on the rider's trip is finished (delivered, failed or cancelled); the rider is `returning_to_hub`. |
| **Trigger** | The rider arrives back; the Dispatcher presses **Confirm return**. |

**Main flow**
1. The server checks nothing is still on the road.
2. The trip is marked returned.
3. Orders assigned to the rider while away become the rider's next forming trip; otherwise the rider is available at the hub.

**Alternate flow:** confirming the same return twice returns the first result.

**Exceptions**

| Code | Message |
|---|---|
| `trip-changed` | "This rider's trip changed. Refresh and try again." |
| `trip-not-settled` | "This rider still has orders out for delivery. Confirm their return once every order is finished." / "This rider is not returning from a trip." |

**Postconditions:** rider `available_at_hub` or `trip_forming`; they can take new orders.

---

## UC-D13 — Cancel an order

| | |
|---|---|
| **Screen** | Shipments → **Cancel order** (`OrderCancellationAction`) |
| **Server** | `cancelOrderWithInventoryRelease` (`operations.js`); scope `dispatcher` |
| **Preconditions** | The order is not delivered. Unlike a Med Rep (pre-departure only), a Dispatcher may cancel after loading or dispatch. |
| **Trigger** | **Cancel order**, a reason, then confirm. |

**Main flow**
1. The dialog explains what happens to the stock, by status (`cancelStockEffect.js`):
   - not loaded: reserved stock is released for other orders;
   - confirmed loaded, in transit or delayed: the vials are held as a return for an Admin to inspect under Stock Allocation;
   - failed delivery: returned vials stay with their return.
2. The server cancels the order in one transaction, records the reason and scope, and moves the stock as above.

**Alternate flow:** a repeated cancel of an already-cancelled order changes nothing.

**Exceptions**
- `order-not-found`: "That order no longer exists."
- `reservation-already-settled`: "This order is cancelled but its stock was already settled differently."
- A missing or empty reason is refused.

**Postconditions:** order `cancelled`; stock released or held for inspection; the Med Rep sees the cancellation.

---

## UC-D14 — Send a failed delivery back to the dispatch queue

| | |
|---|---|
| **Screen** | Shipments → **Return to queue** |
| **Server** | `requeueFailedOrder` (`inventoryWorkflow.js`); approved Dispatcher |
| **Preconditions** | The rider reported the delivery as failed (`delivery_failed`). |
| **Trigger** | The Dispatcher decides to try again. |

**Main flow**
1. The failure record stays.
2. The order returns to `pending_dispatch`, unassigned (the previous rider is kept for reference).
3. Its old vials stay in return-pending for the Admin; the order rejoins allocation with nothing reserved and becomes assignable once it is fully reserved again.

**Alternate flow:** a repeated requeue changes nothing.

**Exceptions**

| Code | Message |
|---|---|
| `order-not-found` | "That order no longer exists." |
| `order-not-failed` | "Only a failed delivery can be returned to the dispatch queue." |
| `legacy-order-not-requeueable` | "This order predates future-order allocation and its stock has been returned. Cancel it and place a new order." |

**Postconditions:** order back in the queue (UC-D01); stock re-allocated by priority.

---

## UC-D15 — Request a destination change

| | |
|---|---|
| **Screen** | Shipments → **Request change** (`DestinationCorrectionDialog.jsx`); the row then shows "Awaiting Med Rep approval" |
| **Server** | `requestOrderDestinationChange` (`destinationOperations.js`); Dispatcher only |
| **Preconditions** | The order's address is wrong or its pin is off; the order's Med Rep is approved. |
| **Trigger** | The Dispatcher picks another address for the same doctor and gives a reason. |

**Main flow**
1. The Dispatcher proposes the address. This **does not** change the order.
2. The Med Rep who placed the order approves or rejects it (`reviewOrderDestinationChange` is Med Rep only).
3. On approval the order's destination and pin change; any saved route must be regenerated (the route shows a regenerate badge).

**Exceptions**

| Code | Message |
|---|---|
| `invalid-revision` | "Refresh the shipment before requesting a change." |
| `order-owner-missing` | "This order has no Med Rep to review a destination change." / "The Med Rep for this order cannot review destination changes. Ask Admin for help." |
| `destination-changed` | "The destination changed. Refresh this shipment and try again." |
| `destination-request-pending` | "A destination request already awaits the Med Rep's decision." |
| `invoice-already-issued` | "An issued invoice already records this destination. Ask Admin to review the order." |
| `destination-unchanged` | "This order already uses that address's current pin. Choose a different address for this doctor." |

**Postconditions:** a pending request awaits the Med Rep.

---

## UC-D16 — Track shipments

| | |
|---|---|
| **Screen** | Shipments (`DispatcherShipments.jsx`) |
| **Preconditions** | Signed in. |
| **Trigger** | The Dispatcher opens Shipments. |

**Main flow**
1. Orders are listed with status, rider, timing chips ("Running late", "Past requested arrival"), and the order's history.
2. From a row the Dispatcher can open UC-D11, UC-D13, UC-D14 or UC-D15.

**Postconditions:** none; read-only apart from the actions above.

---

## UC-D17 — Manage own profile

| | |
|---|---|
| **Screen** | Settings (`DispatcherSettings.jsx`) |
| **Preconditions** | Signed in. |

**Main flow**
1. Settings opens **My profile** (`MyProfile`).
2. The Dispatcher edits their name and phone and presses **Save changes**; the page confirms "Your profile was updated."
3. **Send password reset email** sends a reset link to the account email.

**Business rule:** role and status cannot be changed here; only an Admin changes them through the staff functions, and every change is logged.

---

## What the Dispatcher cannot do

| Action | Who can |
|---|---|
| Change a delivery date (`rescheduleOrderDelivery`) | Admin; the order's Med Rep until the rider leaves |
| Mark an order delivered without the rider's evidence | Nobody. Completion needs the rider inside the clinic geofence (accuracy ≤ 100 m, fix ≤ 3 min old), or an approved offline record (UC-D11) |
| Report a delivery as failed (`reportDeliveryFailure`) | The assigned rider |
| Decide what happens to returned vials (`confirmReturnDisposition`) | Admin |
| Approve a destination change (`reviewOrderDestinationChange`) | The order's Med Rep |
| Add stock, change prices, approve zero-rating, issue invoices, manage staff | Admin |
