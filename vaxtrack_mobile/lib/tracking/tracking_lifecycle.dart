import 'dart:math' as math;

import 'location_write_policy.dart';
import 'tracking_contract.dart';

/// The minimum an order must say for tracking decisions. Built from a
/// `Delivery` (whose `status` is already normalized) or directly in tests.
class TrackedOrder {
  final String id;
  final String status;
  final String? assignedRiderId;

  const TrackedOrder({
    required this.id,
    required this.status,
    required this.assignedRiderId,
  });
}

/// What the rider app should be doing right now.
class TrackingPlan {
  /// Report location at all?
  final TrackingMode mode;

  /// Orders that justify tracking (assigned to this rider, still active).
  final List<String> activeOrderIds;

  /// True when the order being navigated is no longer navigable for this
  /// rider — the client ends its session with [kEndReasonTrackingStopped]
  /// (the server also ends it, with the precise reason).
  final bool endNavigation;

  const TrackingPlan({
    required this.mode,
    required this.activeOrderIds,
    required this.endNavigation,
  });
}

/// Decide tracking from the rider's CURRENT orders (the live assigned-orders
/// stream) and the order being navigated, if any.
///
///  * no order in [kTrackedOrderStatuses] assigned to [riderUid] → off;
///  * navigating an order still in [kNavigableOrderStatuses] → navigating;
///  * otherwise → tracking (and a stale navigation is ended).
///
/// Opening a screen never changes this — only assignments and statuses do.
TrackingPlan planTracking({
  required String riderUid,
  required List<TrackedOrder> orders,
  String? navigatingOrderId,
}) {
  final mine = orders.where((o) => o.assignedRiderId == riderUid).toList();
  final active = mine
      .where((o) => kTrackedOrderStatuses.contains(o.status))
      .map((o) => o.id)
      .toList()
    ..sort();
  var navigationValid = false;
  if (navigatingOrderId != null) {
    for (final o in mine) {
      if (o.id == navigatingOrderId &&
          kNavigableOrderStatuses.contains(o.status)) {
        navigationValid = true;
      }
    }
  }
  final mode = active.isEmpty
      ? TrackingMode.off
      : navigationValid
          ? TrackingMode.navigating
          : TrackingMode.tracking;
  return TrackingPlan(
    mode: mode,
    activeOrderIds: active,
    endNavigation: navigatingOrderId != null && !navigationValid,
  );
}

/// Why Start Navigation is (not) available for one order. [routeAvailable] is
/// informational: navigation still starts without a stored route (the live
/// position is shared), but no deviation is ever computed for it.
class NavigationEligibility {
  final bool canStart;
  final List<String> blockers;
  final bool routeAvailable;

  const NavigationEligibility({
    required this.canStart,
    required this.blockers,
    required this.routeAvailable,
  });
}

NavigationEligibility navigationEligibility({
  required TrackedOrder? order,
  required String? riderUid,
  required bool routeAvailable,
}) {
  final blockers = <String>[];
  final uid = riderUid?.trim() ?? '';
  if (uid.isEmpty) blockers.add('Sign in as the assigned rider to navigate.');
  if (order == null) {
    blockers.add('No delivery selected.');
  } else {
    if (uid.isNotEmpty && order.assignedRiderId != uid) {
      blockers.add('This delivery is not assigned to you.');
    }
    if (!kNavigableOrderStatuses.contains(order.status)) {
      blockers.add('Navigation starts once the delivery is in transit.');
    }
  }
  return NavigationEligibility(
    canStart: blockers.isEmpty,
    blockers: blockers,
    routeAvailable: routeAvailable,
  );
}

/// Location access, as the device reports it.
enum LocationAccess { granted, denied, deniedForever, serviceDisabled }

/// What the tracking UI shows. Every non-tracking state is recoverable from
/// the app (retry / open settings) — nothing crashes or silently stops.
enum TrackingStatus {
  /// No active delivery: nothing is shared.
  idle,

  /// Tracking is needed; the rider has not been asked yet. The app explains
  /// why BEFORE the system prompt is shown.
  needsPermission,

  /// The rider declined; asking again is possible.
  permissionDenied,

  /// The rider declined permanently; only app settings can change it.
  permissionBlocked,

  /// Device location is switched off.
  locationOff,

  /// Sharing location for active deliveries.
  tracking,

  /// Sharing location while navigating one delivery.
  navigating,

  /// Location could not be read (stream error); retry is possible.
  error,

  /// A delivery became active while the app was in the background. Android
  /// does not let location sharing start from the background, so it starts
  /// when the rider opens the app.
  waitingForApp,
}

/// Map a permission check to the status the UI shows when tracking is needed.
TrackingStatus statusForAccess(LocationAccess access, {required bool asked}) {
  switch (access) {
    case LocationAccess.granted:
      return TrackingStatus.tracking;
    case LocationAccess.serviceDisabled:
      return TrackingStatus.locationOff;
    case LocationAccess.deniedForever:
      return TrackingStatus.permissionBlocked;
    case LocationAccess.denied:
      return asked ? TrackingStatus.permissionDenied : TrackingStatus.needsPermission;
  }
}

const String _idAlphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/// A new navigation-session id: 20 random [A-Za-z0-9] characters (matches the
/// rules' ^[A-Za-z0-9_-]{8,64}$).
String newNavigationSessionId([math.Random? random]) {
  final r = random ?? math.Random.secure();
  return List.generate(20, (_) => _idAlphabet[r.nextInt(_idAlphabet.length)])
      .join();
}

/// Route-deviation state as the RIDER sees it. Mirrors
/// `deviationDisplayState` in functions/src/riderTracking.js; the server
/// decides, the app only displays.
enum DeviationDisplay {
  /// Not navigating this delivery (or the server has not seen the session yet).
  notNavigating,

  /// Navigating, but the order has no saved route: deviation is never computed.
  routeUnavailable,

  /// Navigating and within the route corridor.
  onRoute,

  /// More than the off-route distance away, not yet for the confirm time.
  pendingDeviation,

  /// Confirmed off route (an alert is open on the server).
  deviating,
}

/// Map the server's riderDeviationStates/{uid} document to what the screen
/// shows for [sessionId]. A state left over from an EARLIER session (the
/// server has not processed the new one yet) is never shown as current.
DeviationDisplay deviationDisplayFor(Map<String, dynamic>? state, {required String? sessionId}) {
  if (state == null || sessionId == null) return DeviationDisplay.notNavigating;
  if (state['sessionId'] != sessionId || state['sessionState'] != 'navigating') {
    return DeviationDisplay.notNavigating;
  }
  if (state['routeStatus'] != 'available') return DeviationDisplay.routeUnavailable;
  if (state['phase'] == 'deviating') return DeviationDisplay.deviating;
  if (state['pendingOffSinceMs'] != null) return DeviationDisplay.pendingDeviation;
  return DeviationDisplay.onRoute;
}

/// Rider-facing labels (also asserted by tests).
const Map<DeviationDisplay, String> kDeviationDisplayLabels = {
  DeviationDisplay.notNavigating: 'Not navigating',
  DeviationDisplay.routeUnavailable: 'Route not available',
  DeviationDisplay.onRoute: 'On route',
  DeviationDisplay.pendingDeviation: 'Off route — checking',
  DeviationDisplay.deviating: 'Route deviation reported',
};
