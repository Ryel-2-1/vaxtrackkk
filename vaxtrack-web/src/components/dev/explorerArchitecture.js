export const NODES = [
  {
    id: "web", label: "React + Vite", detail: "Web client", description: "Role-specific portals load Firestore views and call the backend for protected workflows.",
    listeners: ["Firebase Auth state", "Role-scoped onSnapshot subscriptions"],
    config: ["VITE_FIREBASE_PROJECT_ID", "VITE_APPCHECK_RECAPTCHA_SITE_KEY"],
    files: ["vaxtrack-web/src/main.jsx", "vaxtrack-web/src/App.jsx", "vaxtrack-web/src/firebase.js", "vaxtrack-web/src/services/liveSnapshot.js"],
  },
  {
    id: "rider", label: "Flutter Rider", detail: "Android client", description: "The Rider app captures GPS, follows saved stop order, and queues offline delivery evidence.",
    listeners: ["Geolocator position stream", "Active orders", "Navigation session", "Connectivity changes"],
    config: ["Tracking mode: tracking, navigating or returning", "Navigation heartbeat: 30 seconds", "Fixture time advances by 30 seconds per GPS tick"],
    files: ["vaxtrack_mobile/lib/services/rider_tracking_service.dart", "vaxtrack_mobile/lib/tracking/location_write_policy.dart", "vaxtrack_mobile/lib/offline/offline_delivery_queue.dart"],
  },
  {
    id: "auth", label: "Firebase Auth", detail: "Identity & roles", description: "The web app uses Firebase Auth and approved role records. The explorer runs handler authorization against synthetic user records.",
    listeners: ["onAuthStateChanged in the web app", "users/{uid} role and status"],
    config: ["Explorer actors: approved Admin, Med Rep, Dispatcher and Riders", "Lab transport: local HTTP"],
    files: ["vaxtrack-web/src/firebase.js", "vaxtrack-web/src/services/authorization.js", "vaxtrack-web/firestore.rules"],
  },
  {
    id: "firestore", label: "Cloud Firestore", detail: "Data & realtime sync", description: "Orders, inventory, reservations, Rider locations and alerts are stored in Firestore. The inspector relays emulator onSnapshot events.",
    listeners: ["orders by fixture Med Rep", "inventory by fixture vaccine", "riderLocations, riderNavigationSessions and riderDeviationStates", "riderDispatchStates and rider alerts"],
    config: ["Project: demo-vaxtrack-explorer", "Emulator: 127.0.0.1:8293", "Web realtime transport: Firestore listeners"],
    files: ["vaxtrack-web/src/services/deliveryService.js", "vaxtrack-web/src/services/riderTrackingService.js", "vaxtrack-web/firestore.rules", "vaxtrack-web/firebase.system-explorer.json"],
  },
  {
    id: "functions", label: "Cloud Functions", detail: "Transactions & events", description: "Node handlers validate checkout, reserve inventory, assign riders, finalize dispatch, and settle delivered stock. This lab calls the same handlers against the emulator.",
    listeners: ["createOrderWithReservation", "assignRiderToOrder and finalizeRiderDispatch", "trackRiderLocation document trigger", "markOrderDeliveredWithInventoryConsumption"],
    config: ["Production callable region: asia-southeast1", "Simulation bridge invokes handlers directly", "App Check applies on the deployed callable transport"],
    files: ["vaxtrack-web/functions/index.js", "vaxtrack-web/functions/src/operations.js", "vaxtrack-web/functions/src/allocation.js", "vaxtrack-web/functions/src/riderDispatchOps.js"],
  },
  {
    id: "routing", label: "Trip planner", detail: "Matrix & stop order", description: "Production ranks requested arrivals, waiting and motorcycle travel time. This lab feeds a synthetic matrix into that planner. Fleet balancing and load-center calculation are lab models.",
    listeners: ["Cargo Loading · Plan trip", "Delivery Monitoring · Re-optimize route"],
    config: ["VITE_MOTORCYCLE_ROUTING_URL", "Production routing: Valhalla motorcycle routing", "Exhaustive stop-order search through 7 stops"],
    files: ["vaxtrack-web/src/services/timeAwareRouting.js", "vaxtrack-web/src/services/routeService.js", "vaxtrack-web/src/components/dispatch/DeparturePlanner.jsx", "vaxtrack-web/scripts/system-explorer/engine.mjs"],
  },
  {
    id: "tracking", label: "Live tracking", detail: "GPS, maps & deviation", description: "The server evaluates recent Firestore GPS samples against the saved route. The browser renders rider positions and dispatch alerts.",
    listeners: ["riderLocations/{uid} document writes", "riderNavigationSessions/{uid}", "Delivery Monitoring snapshot feeds"],
    config: ["Deviation: over 500 m for 3 minutes", "Recovery: under 400 m for 2 minutes", "VITE_GOOGLE_MAPS_API_KEY presence is used by the production map selector"],
    files: ["vaxtrack-web/functions/src/riderTrackingOps.js", "vaxtrack-web/functions/src/riderTracking.js", "vaxtrack-web/src/pages/dispatcher/DispatcherGeofence.jsx", "vaxtrack-web/src/services/mapProvider.js"],
  },
  {
    id: "push", label: "FCM + Storage", detail: "Notifications & evidence", description: "Rider notifications use Firebase Cloud Messaging. Storage holds delivery photos. Lab completion records synthetic proof metadata for the actual completion transaction.",
    listeners: ["FirebaseMessaging.onMessage", "riderPushTokens", "Order-write notification trigger"],
    config: ["FIREBASE_STORAGE_BUCKET is configured with the Firebase app", "Explorer evidence: synthetic metadata", "Explorer notifications: traced in-app alerts"],
    files: ["vaxtrack_mobile/lib/services/push_service.dart", "vaxtrack_mobile/lib/services/image_upload_service.dart", "vaxtrack-web/functions/src/deliveryEvidence.js", "vaxtrack-web/storage.rules"],
  },
];
