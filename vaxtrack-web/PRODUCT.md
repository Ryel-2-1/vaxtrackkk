# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

<!-- This repo is the VaxTrack React web portal. The Rider app is a separate
Flutter mobile companion in a sibling repo; it is real operating context but not
a design surface of this project. -->

## Users

VaxTrack's users are the operational staff who run a vaccine cold-chain delivery
operation, working as one connected chain rather than in isolation. The real-world
scenario is staffed by **logistics personnel and pharmacy professionals
(pharmacists)** — pharmacists own vaccine handling and stock integrity; logistics
staff own movement and delivery.

The web portal serves three staff roles; a fourth works on the mobile companion:

- **Sales Representative** — places vaccine orders on behalf of clinics and tracks
  their own orders through delivery.
- **Dispatcher** — assigns riders to orders, prepares cargo loading, and monitors
  active shipments and live rider location.
- **Admin** — oversees vaccine inventory (batches, expiry, cold storage), clinics,
  riders, deliveries, alerts, invoices, and analytics.
- **Rider** (Flutter mobile companion, not this repo) — receives assigned
  deliveries, advances status, captures proof of delivery, and streams GPS location.

Situation: a central distribution hub delivering temperature-sensitive vaccines to
partner clinics in the Philippines (Metro Manila context), under time and
temperature pressure — vaccines are expiry-bound and spoil outside their cold range.

## Product Purpose

VaxTrack manages the end-to-end delivery of temperature-sensitive vaccines from a
central hub to clinics, keeping cold-chain condition, batch/expiry, and delivery
status visible and synchronized across every role in real time. Success is vaccines
reaching clinics on time and within cold-chain integrity, with a complete auditable
trail — assignment, status transitions, and proof of delivery — and no lost or
spoiled stock.

## Positioning

VaxTrack's meaningfully different concern is **vaccine cold-chain integrity**, not
generic parcel logistics. Temperature, batch, and expiry are tracked alongside
movement; the vaccine *order* (not an abstract shipment) is the single source of
truth; and the whole order → dispatch → delivery → proof chain stays synchronized
across roles. A neighboring generic-delivery product could copy the routing, but not
the vaccine-safety framing that organizes the entire system. (Mapping technology
varies by surface — see Operating Context — and is not itself the positioning;
cold-chain integrity is.)

## Operating Context

- **Network:** a central hub (e.g., a Metro Manila hub) delivering to partner clinics;
  motorcycle riders carry out deliveries; dispatchers coordinate; admins and
  pharmacists manage inventory and cold storage.
- **Core workflow:** Sales Rep places an order → Dispatcher assigns a rider and
  confirms cargo loading → Rider delivers → proof of delivery is captured → state is
  reflected across Admin, Sales Rep, and Dispatcher views in real time.
- **Canonical delivery status flow:** `pending_dispatch → assigned → loading →
  in_transit → delivered`, with branches `delayed` (recoverable) and `cancelled`
  (terminal). These are fixed; new statuses are not introduced.
- **Materials & records:** vaccine batches (SKU, batch ID, expiry date, storage
  temperature), clinics (with optional coordinates), orders, invoices, alerts, and
  proof-of-delivery photos.
- **Live monitoring:** rider GPS location, a geofence around the destination clinic,
  and a dispatcher-generated route + ETA.
- **Mapping technology differs by surface:** the **web portal** (Dispatcher live map,
  geofence, and route/ETA display) renders with **OpenStreetMap (Leaflet) +
  OpenRouteService**; the separate **Flutter Rider app** uses **Google Maps
  Navigation** for embedded turn-by-turn guidance during a delivery.

## Capabilities and Constraints

- Real-time, role-gated platform on Firebase (Auth + Firestore). The `orders`
  collection is the **single source of truth for deliveries** — there is no separate
  deliveries collection.
- Status values are gated and consistent across web and mobile; account status is
  `approved | pending | rejected | disabled` (never "active"/"inactive" as a stored
  value). Production Firestore security rules are deployed (approved-user, role-scoped,
  field-level write allowlists).
- **Web-portal mapping** (live tracking, geofence, manual clinic coordinates, and
  route/ETA) uses **OpenStreetMap (Leaflet) + OpenRouteService** — no Google Maps,
  Mapbox, or paid geocoding key *on the web*. VaxTrack as a whole is **not** a single
  free-map stack: the **Flutter Rider app** relies on **Google Maps Navigation** for
  its embedded turn-by-turn delivery guidance.
- **Open / deferred product facts (do not treat as done):**
  - Firebase Storage is not yet provisioned (a Blaze-plan decision), so proof of
    delivery currently uses a temporary HTTPS-URL fallback rather than a
    camera → Storage photo upload.
  - Clinic geocoding via a paid API, automatic route-deviation alerts, and
    background/killed-app rider tracking are deferred.
  - The **shared web UI foundation is mid-consolidation** — a common look is being
    unified across roles and is **not yet fully consistent** across Admin, Sales Rep,
    and Dispatcher. The current pilot surfaces are the Admin **Dashboard, Analytics,
    and Inventory**. Remaining UI inconsistencies, legacy global CSS, and known layout
    defects are current-state issues, **not** intended design.

## Brand Commitments

- **Name:** "VaxTrack" (binding).
- **Setting:** the Philippines / Metro Manila cold-chain scenario is part of the
  product's identity.
- **Roles:** Admin, Sales Representative, Dispatcher, and Rider are the product's
  structural roles.
- Voice/tone has not been explicitly defined by the owner; future work should not
  invent a brand voice, personality, or slogan as if confirmed.

## Evidence on Hand

- A working end-to-end implementation backed by real Firestore data and test accounts
  (real orders, clinics, riders, and inventory), with the core order → dispatch →
  delivery → proof flow exercised across all roles.
- A companion Flutter Rider app (register → admin approval → login → deliver → proof)
  verified against the same backend.
- Reference docs in `docs/`: `VaxTrack-Test-Case-Tracker.md` (system test cases),
  `VaxTrack-Admin-Test-Case-Tracker.md`, and `VaxTrack-Maps-Routing-Plan.md`.
- **No real customers, adoption metrics, testimonials, pricing, or commercial
  deployment exist yet** — this is an academic capstone. Future work must not fabricate
  these; they can be added only once true, if/when VaxTrack becomes a real product.

## Product Principles

1. **Cold-chain integrity is the reason to exist.** Temperature, batch, and expiry are
   first-class throughout the product, never afterthoughts bolted onto generic delivery.
2. **One synchronized truth.** The vaccine order is the single source of truth; every
   role sees the same real-time state; status transitions are auditable and never
   silently rewritten.
3. **Honesty over decoration.** Show real data and real states — including empty,
   blocked, and deferred ones — and never fabricate maps, metrics, customers, or claims
   the operation cannot back.
4. **A focused surface per role.** Each role gets the view its job in the delivery chain
   needs (staff on web, riders on mobile), not one crowded screen for everyone.
5. **Production-credible on a lean stack.** A capstone today, but built to
   real-operation standards — security rules, resilient fallbacks, and no paid-API
   dependencies — so it can graduate into a real product.
