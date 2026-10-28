/// Rider live tracking — the constants the Rider app shares with the server.
///
/// Mirrors vaxtrack-web/functions/src/riderTracking.js (the authoritative
/// contract) and firestore.rules. The web test suite parses this file and
/// compares it with the JavaScript constants, so the two cannot drift.
///
/// The Rider app only REPORTS its position and which order it is navigating.
/// Every route-deviation decision, alert and event is made on the server.
library;

/// A rider reports location while assigned to at least one order in one of
/// these statuses. Delivered, cancelled and failed orders never keep tracking on.
const List<String> kTrackedOrderStatuses = [
  'assigned',
  'loading',
  'in_transit',
  'delayed',
];

/// Start Navigation (route-deviation monitoring) is possible only for an order
/// the rider is moving now.
const List<String> kNavigableOrderStatuses = ['in_transit', 'delayed'];

/// Firestore collections (see firestore.rules).
const String kRiderLocationsCollection = 'riderLocations';
const String kNavigationSessionsCollection = 'riderNavigationSessions';
const String kDeviationStatesCollection = 'riderDeviationStates';

/// The server-owned Rider trip state (functions/src/riderDispatch.js): the
/// AUTHORITY on whether a Rider is out on a trip or returning to the hub.
const String kRiderDispatchStatesCollection = 'riderDispatchStates';
const String kTripStateOnTrip = 'on_trip';
const String kTripStateReturning = 'returning_to_hub';
const String kTripStateAvailable = 'available_at_hub';

/// With no active order, a Rider keeps sharing location while the server
/// says the trip is still out (on_trip — the moment between the last order
/// finishing and the trip settling) or returning to the hub. Only an
/// authorized return confirmation (→ available_at_hub) or sign-out stops it;
/// arrival is never inferred from coordinates.
const List<String> kHubBoundTripStates = ['on_trip', 'returning_to_hub'];

/// riderLocations document contract.
const int kLocationSchemaVersion = 1;
const String kLocationSource = 'geolocator';

/// Reasons the CLIENT may give when it ends its own navigation session. The
/// server ends sessions with other reasons (completed, cancelled, reassigned…).
const String kEndReasonRiderStopped = 'rider_stopped';
const String kEndReasonSignedOut = 'signed_out';
const String kEndReasonTrackingStopped = 'tracking_stopped';

/// Display freshness, measured from the fix's capture time.
const int kFreshMs = 2 * 60 * 1000;
const int kOfflineMs = 10 * 60 * 1000;

/// Server deviation rule (display only on the device; the server decides).
const int kDeviationOffRouteMeters = 500;
const int kDeviationReturnMeters = 400;
const int kDeviationConfirmSeconds = 180;
const int kDeviationReturnConfirmSeconds = 120;
const int kDeviationMaxAccuracyMeters = 100;

/// Navigation continuity (functions/src/riderTracking.js, CONFIRMED
/// CONTINUITY). A session started with this version promises the server a
/// confirmation (lastNavigationFixAt) for every qualifying tagged fix, which is
/// what lets the server tell a live session from an abandoned one no matter
/// in which order its location triggers run.
const int kNavigationContinuityVersion = 1;

/// A fix stored more than this long after it was captured does not qualify
/// (the server's DEVIATION_RULES.maxFixAgeMs and firestore.rules).
const int kMaxFixAgeSeconds = 60;
