# VaxTrack Maps/Routing Foundation Plan

> Planning document only. No source code changes yet.
> Date: 2026-06-30

---

> ## ⚠️ SUPERSEDED — read this first (updated 2026-07-23)
>
> This is an **early aspirational plan**, kept for history. It does **not** reflect
> what is actually built. The project has since **decided to avoid paid/billing-sensitive
> APIs**, so the recommendations below (Google Maps as primary renderer, Google
> Directions/Geocoding) are **not** the implemented stack.
>
> **Actually implemented today (see CLAUDE.md for the source of truth):**
> - **Map display:** **Leaflet + OpenStreetMap tiles** on Dispatcher Geofence — **no API key, no billing.** (A CSP `img-src` allowance for `tile.openstreetmap.org` is the only config it needs.)
> - **Rider GPS → Firestore:** implemented and runtime-verified (continuous foreground tracking, `geolocator`).
> - **Proof of delivery:** temporary **manual HTTPS URL fallback** (Firebase Storage not provisioned — a Blaze decision, deferred).
>
> **NOT implemented (deferred, no code):** Google Maps API, Google Geocoding API,
> Mapbox, OpenRouteService (routing/VRP), Google OR-Tools, clinic geocoding,
> destination markers, geofence detection, route deviation, ETA/routing.
>
> The "What is implemented vs. future" table near the bottom has been corrected to
> match reality; the narrative sections above it are the **original** proposal and
> should be read as "one option we considered," not as current fact.

---

## 1. Recommended Stack

| Component | Recommended Tool | Fallback / Future |
|---|---|---|
| **Admin Web Map** | Google Maps JavaScript API | — |
| **Dispatcher Web Map** | Google Maps JavaScript API (same) | — |
| **Rider Flutter Map** | Google Maps Flutter plugin (`google_maps_flutter`) | — |
| **Routing / Directions** | Google Directions API (via Maps SDK) | OpenRouteService Directions API |
| **Route Optimization (VRP)** | OpenRouteService Optimization API (free tier) | OR-Tools on Cloud Functions (future) |
| **Real-time Location Tracking** | Firebase Firestore `onSnapshot` | — |
| **Device GPS** | Flutter `geolocator` + `location` packages | — |
| **Geofencing / Deviation Detection** | Client-side distance calculation (Haversine) | Firebase Functions trigger (future) |

---

## 2. Why This Stack

**Google Maps API is the primary map renderer for both platforms** because:
- Single API key works for both React (JS API) and Flutter (`google_maps_flutter`)
- The Philippines has excellent Google Maps coverage, including street-level data, traffic, and geocoding for Filipino addresses
- Google Directions API provides route polylines, ETA, and distance — no separate routing service needed for navigation
- The `google_maps_flutter` plugin is the most mature Flutter map package with built-in marker, polyline, and camera support
- Capstone panelists will immediately recognize Google Maps — no need to explain why you chose an obscure alternative

**OpenRouteService handles route optimization** because:
- It has a free Optimization API endpoint that solves the Vehicle Routing Problem (VRP) — exactly what the paper describes
- No backend server required: it's a REST API call with JSON input/output
- Free tier: 500 optimization requests/day — more than enough for a capstone demo
- OR-Tools is a Python/C++ library that requires a backend server — overkill for a prototype and adds deployment complexity

**Firebase Firestore handles real-time tracking** because:
- Already integrated in both web and mobile apps
- `onSnapshot` provides sub-second real-time updates — rider writes location, admin sees it instantly
- No WebSocket server or MQTT broker to deploy and maintain
- Security rules control who can read/write location data

**Why not just one API?**
- Google Maps shows maps and provides directions, but has no built-in VRP solver
- OpenRouteService solves VRP but its map tiles are OpenStreetMap — less polished for Philippines addresses
- Firebase isn't a map service but is the only component that provides real-time sync
- Each tool does one thing well; the combination covers all requirements without overlap

---

## 3. API / Tool Comparison Table

| Criteria | Google Maps API | OpenRouteService | OR-Tools | Firebase Firestore | Leaflet/OSM |
|---|---|---|---|---|---|
| **Best use in VaxTrack** | Map display, directions, geocoding | Route optimization (VRP) | Advanced VRP (future) | Real-time rider location | — Not recommended |
| **Pros** | Best PH coverage, familiar UI, works in React + Flutter | Free VRP API, no backend needed | Most powerful VRP solver | Already integrated, real-time | Free, no API key |
| **Cons** | Costs money after free tier | Slower tile rendering, less PH detail | Requires Python backend | Not a map service | Poor PH address data, no directions |
| **Free tier** | $200/month credit (~28k map loads + 40k direction calls) | 500 optimization/day, 2000 directions/day | Free (open source) but needs hosting | Spark plan: 50k reads/day | Unlimited |
| **Cost risk** | Low for capstone (~$0 with credit) | None | Hosting cost if deployed | Low for capstone | None |
| **Difficulty** | Medium — well-documented | Low for API calls | High — needs backend | Low — already using it | Medium |
| **React web fit** | Excellent (`@react-google-maps/api` or `@vis.gl/react-google-maps`) | API-only (no map widget) | API-only | Excellent | Good (`react-leaflet`) |
| **Flutter fit** | Excellent (`google_maps_flutter`) | API-only | API-only | Excellent (`cloud_firestore`) | Poor (no mature plugin) |
| **Capstone defense** | Strong — industry standard | Strong — demonstrates VRP knowledge | Strong on paper, hard to demo | Strong — real-time is impressive | Weak — looks basic |

**Verdict:** Google Maps + OpenRouteService + Firebase is the optimal capstone stack. OR-Tools is documented as a future enhancement. Leaflet/OSM is not recommended — it adds no value when Google Maps is already in use.

---

## 4. Firestore Data Model Proposal

### 4a. `orders` collection (extend existing documents)

These fields are **added** to existing order documents. No new collection needed.

```
orders/{orderId}
  // --- existing fields (do not change) ---
  orderNumber:        string
  clinicName:         string
  vaccineName:        string
  quantity:           number
  status:             string          // "pending" | "assigned" | "in_transit" | "delayed" | "delivered"
  createdAt:          timestamp

  // --- new fields for maps/routing ---
  pickupLocation:     map
    address:          string          // "VaxTrack Warehouse, Taguig City"
    lat:              number          // 14.5176
    lng:              number          // 121.0509
  dropoffLocation:    map
    address:          string          // "Makati Medical Center, Makati City"
    lat:              number          // 14.5649
    lng:              number          // 121.0146
  assignedRiderId:    string | null   // users/{uid} reference
  assignedRiderName:  string | null
  routePolyline:      string | null   // Google encoded polyline string
  estimatedDistance:   number | null   // meters
  estimatedDuration:  number | null   // seconds
  dispatchedAt:       timestamp | null
  deliveredAt:        timestamp | null
```

### 4b. `riderLocations` collection (NEW)

Separate from `users` to avoid high-frequency writes to the user document. Each rider has one document, updated every 10–15 seconds during active delivery.

```
riderLocations/{riderId}
  lat:                    number        // current latitude
  lng:                    number        // current longitude
  heading:                number | null // degrees (0-360), from device compass
  speed:                  number | null // m/s, from GPS
  accuracy:               number | null // meters, GPS accuracy
  updatedAt:              timestamp     // server timestamp
  activeOrderId:          string | null // which order is being delivered
  isOnline:               boolean       // rider app is active
```

### 4c. `routeAssignments` collection (NEW — optional, Phase 6)

Only needed if implementing multi-stop route optimization. Each document represents an optimized route for one rider on one day.

```
routeAssignments/{assignmentId}
  riderId:              string
  riderName:            string
  date:                 string          // "2026-06-30"
  stops:                array
    [0]:                map
      orderId:          string
      clinicName:       string
      lat:              number
      lng:              number
      sequence:         number          // optimized order (1, 2, 3...)
      status:           string          // "pending" | "completed" | "skipped"
  totalDistance:         number          // meters (from optimization API)
  totalDuration:        number          // seconds
  optimizedPolyline:    string | null   // full route encoded polyline
  createdAt:            timestamp
```

### 4d. `alerts` collection (extend for geofence)

Add these fields to existing alert documents when type is `route_deviation`:

```
alerts/{alertId}
  // --- existing fields ---
  type:               string          // "route_deviation"
  title:              string
  message:            string
  status:             string          // "active" | "resolved"
  createdAt:          timestamp

  // --- new fields for deviation ---
  orderId:            string | null
  riderId:            string | null
  deviationDistance:   number | null   // meters from planned route
  riderLocation:      map | null
    lat:              number
    lng:              number
```

---

## 5. Phase-by-Phase Implementation Plan

### Phase 1: Basic Static Map Display

**Goal:** Show a Google Map on the Admin Dashboard replacing the current CSS-only decorative map.

**Files affected:**
- `vaxtrack-web/package.json` — add `@vis.gl/react-google-maps`
- `vaxtrack-web/src/pages/admin/AdminDashboard.jsx` — replace `.v2-live-map` div with Google Map component
- `vaxtrack-web/src/pages/admin/AdminDashboard.css` — adjust map container styles
- `vaxtrack-web/.env` — add `VITE_GOOGLE_MAPS_API_KEY`
- `vaxtrack-web/.env.example` — document the key

**Required API:** Google Maps JavaScript API (enable in Google Cloud Console)

**Expected output:**
- Interactive Google Map centered on Metro Manila (14.5995, 120.9842)
- Zoom/pan controls work
- Map replaces the static CSS illustration
- No markers yet

**Risk level:** Low — no Firestore changes, no Flutter changes

**Testing checklist:**
- [ ] Map renders without console errors
- [ ] Map is interactive (zoom, pan, tilt)
- [ ] API key is not committed to git (in `.env`, `.gitignore` covers it)
- [ ] Build succeeds (`npm run build`)
- [ ] No regression on other Dashboard features (metrics, alerts, sidebar)

---

### Phase 2: Show Order Destinations and Route Polyline

**Goal:** Display delivery destination markers on the Admin map. When an order is selected, show the route polyline from warehouse to clinic.

**Files affected:**
- `vaxtrack-web/src/pages/admin/AdminDashboard.jsx` — add markers from orders data
- `vaxtrack-web/src/pages/admin/Deliveries.jsx` — optional: add "View on Map" action
- `vaxtrack-web/src/services/deliveryService.js` — no change (already subscribes to orders)
- Firestore: add `pickupLocation` and `dropoffLocation` to test order documents

**Required API:** Google Maps JavaScript API + Google Directions API

**Expected output:**
- Markers appear on map for each active order's dropoff location
- Clicking a marker shows clinic name and order info
- Route polyline drawn between warehouse and destination
- Color-coded markers by order status (blue = in transit, red = delayed)

**Risk level:** Medium — requires adding lat/lng to Firestore order docs manually for testing

**Testing checklist:**
- [ ] Markers appear for orders that have `dropoffLocation`
- [ ] Orders without location data degrade gracefully (no marker, no crash)
- [ ] Route polyline renders correctly
- [ ] Marker info window shows correct order details
- [ ] Directions API quota not exceeded during testing

---

### Phase 3: Flutter Rider GPS Updates to Firestore

**Goal:** Rider's Flutter app reads device GPS and writes location to `riderLocations/{riderId}` every 10–15 seconds during active delivery.

**Files affected:**
- `vaxtrack_mobile/pubspec.yaml` — add `geolocator`, `google_maps_flutter`, `location`
- `vaxtrack_mobile/lib/main.dart` — split into multiple files or add location service
- `vaxtrack_mobile/lib/services/location_service.dart` — NEW: GPS stream + Firestore write
- `vaxtrack_mobile/android/app/src/main/AndroidManifest.xml` — location permissions
- `vaxtrack_mobile/ios/Runner/Info.plist` — location usage descriptions
- Firestore: `riderLocations` collection created automatically on first write

**Required API:** Flutter `geolocator` package + Firestore

**Expected output:**
- Rider taps "Start Delivery" → GPS tracking begins
- Location written to `riderLocations/{riderId}` every 10–15 seconds
- Rider taps "Complete Delivery" → GPS tracking stops, `isOnline` set to false
- Battery-efficient: uses `LocationAccuracy.high` only during delivery

**Risk level:** Medium-High — requires device testing (emulator GPS simulation), Android/iOS permissions

**Testing checklist:**
- [ ] Location permission requested on first launch
- [ ] GPS coordinates update in Firestore (check Firebase Console)
- [ ] `updatedAt` timestamp is correct
- [ ] Tracking stops when delivery completes
- [ ] App doesn't drain battery when not delivering (no background GPS)
- [ ] Works on Android emulator with simulated location

---

### Phase 4: Admin Live Tracking Using Firestore

**Goal:** Admin Dashboard map shows rider's real-time position, updated via Firestore `onSnapshot`.

**Files affected:**
- `vaxtrack-web/src/services/riderLocationService.js` — NEW: `subscribeRiderLocation(riderId, callback)`
- `vaxtrack-web/src/pages/admin/AdminDashboard.jsx` — subscribe to rider location, update marker position
- `vaxtrack-web/src/pages/admin/AdminDashboard.css` — rider marker animation

**Required API:** Firebase Firestore `onSnapshot` + Google Maps JS API

**Expected output:**
- Rider marker moves on Admin map as rider's GPS updates in Firestore
- Marker shows rider name tooltip on hover
- "Recenter Rider" button works (camera follows rider)
- Multiple riders visible if multiple active

**Risk level:** Medium — depends on Phase 3 working correctly

**Testing checklist:**
- [ ] Rider marker appears when `riderLocations/{riderId}` document exists
- [ ] Marker position updates within 2 seconds of Firestore write
- [ ] Marker disappears or grays out when rider goes offline
- [ ] No memory leak from `onSnapshot` subscription (cleanup on unmount)
- [ ] Works with multiple riders simultaneously

---

### Phase 5: Deviation / Geofence Alerts

**Goal:** Detect when a rider deviates more than 500m from the planned route and create a Firestore alert.

**Files affected:**
- `vaxtrack-web/src/utils/geoUtils.js` — NEW: `haversineDistance(lat1, lng1, lat2, lng2)`, `isPointNearPolyline(point, polyline, thresholdMeters)`
- `vaxtrack-web/src/services/riderLocationService.js` — add deviation check on each location update
- `vaxtrack-web/src/services/alertService.js` — use existing `resolveAlert` when rider returns to route
- `vaxtrack-web/src/pages/admin/AdminDashboard.jsx` — show deviation warning on map

**Required API:** None (pure math — Haversine formula)

**Expected output:**
- When rider location is >500m from planned polyline → alert created in `alerts` collection
- Admin Dashboard shows red deviation indicator on map
- Alert auto-resolves when rider returns within threshold
- Existing Alerts page shows deviation alerts

**Risk level:** Medium — math is straightforward but needs good test data

**Testing checklist:**
- [ ] Deviation detected when rider is >500m from route
- [ ] No false positive when rider is on route
- [ ] Alert created in Firestore with correct `deviationDistance`
- [ ] Alert resolves when rider returns to route
- [ ] Dashboard deviation banner uses real alert data (not hardcoded)

---

### Phase 6: Route Optimization (VRP)

**Goal:** Dispatcher can optimize delivery sequence for a rider with multiple stops using OpenRouteService Optimization API.

**Files affected:**
- `vaxtrack-web/src/services/routeOptimizationService.js` — NEW: calls ORS Optimization API
- `vaxtrack-web/src/pages/dispatcher/` — add "Optimize Route" button to assignment flow
- `vaxtrack-web/.env` — add `VITE_ORS_API_KEY`
- Firestore: `routeAssignments` collection

**Required API:** OpenRouteService Optimization API (free key from openrouteservice.org)

**Expected output:**
- Dispatcher selects multiple orders + one rider → clicks "Optimize Route"
- API returns optimal stop sequence minimizing travel time
- Optimized route displayed on map with numbered stops
- Route saved to `routeAssignments` collection

**Risk level:** High — most complex phase, depends on all previous phases

**Testing checklist:**
- [ ] ORS API returns valid optimization result
- [ ] Stop sequence changes from input order to optimized order
- [ ] Optimized polyline renders correctly on map
- [ ] Route assignment saved to Firestore
- [ ] Works with 2–8 stops (capstone demo range)
- [ ] Graceful error if ORS API is down or quota exceeded

---

## 6. Capstone Defense Explanation

### Why Google Maps API?

"We use Google Maps as our primary map renderer because it provides the best coverage of Philippine roads, addresses, and landmarks. The same API key works for both our React admin web portal and our Flutter rider mobile app. Google Maps also includes the Directions API, which gives us route polylines, estimated travel time, and distance — essential for showing delivery routes to both admin and rider."

### Why Firebase for real-time rider location?

"Firebase Firestore's `onSnapshot` feature provides real-time data synchronization. When a rider's GPS updates their location in Firestore, the admin dashboard receives the update within 1–2 seconds without polling or WebSocket servers. This is the same infrastructure we already use for orders and alerts, so adding location tracking required no additional backend deployment."

### Why OpenRouteService for route optimization?

"Our system implements the Vehicle Routing Problem (VRP) — optimizing the delivery sequence for a rider with multiple clinic stops to minimize travel time and distance. OpenRouteService provides a free REST API that solves VRP directly. We send the list of delivery locations and rider starting point, and the API returns the optimal stop order. This avoids deploying a separate optimization server."

### Why not OR-Tools?

"OR-Tools by Google is the most powerful open-source VRP solver, but it's a Python/C++ library that requires a backend server. For our capstone prototype, the OpenRouteService API achieves the same result with a simple HTTP request. OR-Tools would be the correct choice for a production system handling hundreds of riders and thousands of deliveries daily — we document this as a scalability enhancement."

### What is implemented vs. future enhancement?

**Corrected 2026-07-23 to match the actual codebase** (the earlier values in this
table were aspirational template placeholders, not real status):

| Feature | Actual Status |
|---|---|
| Web map renderer | **Implemented — Leaflet + OpenStreetMap** on Dispatcher Geofence (NOT Google Maps; no API key) |
| Google Maps on Admin Dashboard | **NOT implemented** — no Google Maps anywhere; no Admin map |
| Delivery destination markers | **NOT implemented** — deferred (clinics have no coordinates yet) |
| Route polyline (warehouse → clinic) | **NOT implemented** — deferred |
| Rider GPS tracking to Firestore | **Implemented** — continuous foreground tracking, runtime-verified 2026-07-23 |
| Dispatcher live rider tracking | **Implemented (position only)** — rider marker on the Leaflet map from `orders.lastLocation` |
| Admin live rider tracking | **NOT implemented** — no Admin map |
| Route deviation alerts | **NOT implemented** — deferred (needs routing + clinic coords) |
| Multi-stop route optimization (ORS) | **NOT implemented** — deferred (no OpenRouteService key) |
| OR-Tools backend solver | **NOT implemented** — future/optional |
| Turn-by-turn navigation in Flutter | **NOT implemented** — future |
| Historical route playback | **NOT implemented** — future |
| Traffic-aware routing | **NOT implemented** — future |
| Proof-of-delivery photo | **Temporary manual HTTPS URL fallback** — Firebase Storage upload deferred (Blaze) |

---

## 7. Risks and Cost Notes

### Google Maps API

- **Free tier:** $200/month credit applied automatically to all Google Maps Platform products
- **Estimated capstone usage:** ~500 map loads + ~200 direction requests/month = ~$5 → fully covered by free credit
- **Risk:** If API key leaks, someone could rack up charges. Mitigate: restrict key to your domain in Google Cloud Console, never commit `.env` to git
- **Action required:** Create a Google Cloud project, enable Maps JavaScript API + Directions API + Maps SDK for Android/iOS, create an API key, restrict it

### OpenRouteService

- **Free tier:** 500 optimization requests/day, 2000 directions/day — more than enough
- **Risk:** API can be slow (2–5 seconds for optimization). Show loading state.
- **Action required:** Register at openrouteservice.org, get free API key

### Firebase Firestore

- **Spark (free) plan:** 50k reads/day, 20k writes/day
- **Rider location writes:** 1 rider × 4 writes/min × 60 min = 240 writes/hour — well within limits
- **Risk:** If 10+ riders are active simultaneously during demo, watch write quota. Capstone demo typically has 1–3 riders → no issue.

### OR-Tools

- **Cost:** Free (open source), but requires hosting (Cloud Functions or Cloud Run)
- **Risk:** Adds deployment complexity and Python runtime to a JavaScript/Dart project
- **Recommendation:** Document only. Do not implement unless panelists specifically ask for it and you have time.

### Flutter Location Permissions

- **Risk:** Android 12+ and iOS require foreground service notification for GPS while app is open. Background location requires additional permissions and review.
- **Recommendation:** Use foreground-only location (while app is open). Do not implement background tracking — it complicates both code and app store review.

---

## 8. Next Recommended Implementation Phase

**Start with Phase 1: Basic Static Map Display on Admin Dashboard.**

Why:
- Lowest risk — no Firestore changes, no Flutter changes, no new API dependencies beyond the map
- Immediately visible improvement to the admin UI (replaces CSS-only map)
- Validates the Google Maps API key setup before building on it
- Can be completed in a single session

Prerequisites before starting:
1. Create a Google Cloud project (or use existing Firebase project `vaxtrack-bef1b`)
2. Enable "Maps JavaScript API" in Google Cloud Console
3. Create an API key and restrict it to `localhost:5176` for dev
4. Create `.env` file with `VITE_GOOGLE_MAPS_API_KEY=your_key_here`

---

## API Key Setup Checklist

| API | Where to get | Key env variable | Restrict to |
|---|---|---|---|
| Google Maps JS API | console.cloud.google.com → APIs & Services | `VITE_GOOGLE_MAPS_API_KEY` | HTTP referrer: `localhost:5176/*` (dev), your domain (prod) |
| Google Directions API | Same project, enable additional API | Same key | Same |
| Google Maps SDK (Android) | Same project, enable additional API | `android/app/src/main/AndroidManifest.xml` | Android app SHA-1 |
| Google Maps SDK (iOS) | Same project, enable additional API | `ios/Runner/AppDelegate.swift` | iOS bundle ID |
| OpenRouteService | openrouteservice.org/dev/#/signup | `VITE_ORS_API_KEY` | None (free tier) |
