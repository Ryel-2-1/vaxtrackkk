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
