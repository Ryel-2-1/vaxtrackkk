import '../models/delivery.dart';
import '../tracking/location_write_policy.dart';
import '../tracking/tracking_contract.dart';
import '../tracking/tracking_lifecycle.dart';
import 'google_maps_url.dart';
import 'trip_route.dart';

/// Pure state for the VaxTrack route screen (RouteMonitoringScreen) and the
/// Google Maps hand-off. No Flutter or Firebase imports, so every rider-facing
/// state is unit-tested directly.

// ---------------------------------------------------------------- GPS

enum GpsState { notSharing, waiting, good, weak, lost }

class GpsStatus {
  const GpsStatus(this.state, this.message);
  final GpsState state;
  final String message;

  /// The server can use this position for the route check.
  bool get usableForRouteCheck => state == GpsState.good;
}

/// What the rider is told about GPS. Thresholds are the server's: a fix less
/// accurate than [kDeviationMaxAccuracyMeters] is ignored by the route check,
/// and one older than [kFreshMs] no longer says where the rider is.
GpsStatus gpsStatusFor({required LocationFix? fix, required DateTime now, required bool sharing}) {
  if (!sharing) {
    return const GpsStatus(GpsState.notSharing, 'Location not shared yet. Tap Start to share it with dispatch.');
  }
  if (fix == null) return const GpsStatus(GpsState.waiting, 'Waiting for GPS…');
  final ageMs = now.difference(fix.capturedAt).inMilliseconds;
  if (ageMs > kFreshMs) {
    final minutes = (ageMs / 60000).floor();
    return GpsStatus(
      GpsState.lost,
      'No GPS fix for $minutes min. Move to open sky; the map shows your last position.',
    );
  }
  final accuracy = fix.accuracyMeters.round();
  if (fix.accuracyMeters > kDeviationMaxAccuracyMeters) {
    return GpsStatus(
      GpsState.weak,
      'GPS weak (±$accuracy m). VaxTrack skips positions less accurate than '
      '$kDeviationMaxAccuracyMeters m.',
    );
  }
  return GpsStatus(GpsState.good, 'GPS good (±$accuracy m)');
}

// ---------------------------------------------------------------- next stop

class NextStop {
  const NextStop({required this.position, required this.after});

  /// "Stop 2 of 4" on a planned trip, else null.
  final String? position;

  /// The stop to ride to after this one, in the planned order, if any.
  final Delivery? after;
}

/// Where [current] sits in its trip and what follows it. Delivered, failed and
/// cancelled stops are skipped, exactly as the Google Maps hand-off skips them.
NextStop nextStopFor(Delivery current, List<Delivery> deliveries) {
  final seq = current.stopSequence ?? 0;
  final count = current.tripStopCount ?? 0;
  final position = current.isOnTrip && count > 0 ? 'Stop $seq of $count' : null;
  final remaining = remainingTripFrom(current, deliveries).stops;
  return NextStop(position: position, after: remaining.length > 1 ? remaining[1] : null);
}

// ---------------------------------------------------------------- off route

/// What to do when the server reports the rider off the plan. The plan does
/// not reroute by itself: only dispatch can save a new one.
const Map<DeviationDisplay, String> kOffRouteAdvice = {
  DeviationDisplay.pendingDeviation:
      'You are more than $kDeviationOffRouteMeters m from the VaxTrack plan. Return to the '
      'route line. If the road is blocked, call dispatch — they can plan a new route.',
  DeviationDisplay.deviating:
      'Dispatch has been alerted that you left the plan. Return to the route line, '
      'or call dispatch to plan a new route.',
};

// ---------------------------------------------------------------- re-planning

/// How the saved plan changed since the screen last looked.
enum PlanChange { none, planned, replanned, withdrawn }

const Map<PlanChange, String> kPlanChangeMessages = {
  PlanChange.planned: 'Dispatch planned a route. The map now shows it.',
  PlanChange.replanned: 'Dispatch updated your route. The map now shows the new plan.',
  PlanChange.withdrawn: 'The saved route can no longer be used. Ask dispatch to plan it again.',
};

/// Watches the plan's fingerprint across live order updates. The first value
/// seen is the starting point, never a change.
class PlanChangeTracker {
  bool _seen = false;
  String? _last;

  PlanChange observe(String? fingerprint) {
    if (!_seen) {
      _seen = true;
      _last = fingerprint;
      return PlanChange.none;
    }
    final before = _last;
    _last = fingerprint;
    if (before == fingerprint) return PlanChange.none;
    if (before == null) return PlanChange.planned;
    if (fingerprint == null) return PlanChange.withdrawn;
    return PlanChange.replanned;
  }
}

// ---------------------------------------------------------------- Google Maps

/// One Google Maps hand-off: the link to open and what to tell the rider.
class GoogleHandoff {
  const GoogleHandoff(this.uri, this.message);

  /// Null when there is nowhere to send the rider.
  final Uri? uri;
  final String? message;
}

/// The hand-off for [d]. On a planned trip it opens THIS stop and then the
/// trip's other unfinished stops in the planned order (from [deliveries]);
/// otherwise this stop's pin, or an address search without one. Google picks
/// the roads in every case — the link carries stops, never the saved route.
GoogleHandoff googleHandoffFor(Delivery d, List<Delivery>? deliveries) {
  if (d.isOnTrip && d.hasClinicCoords && deliveries != null) {
    final trip = remainingTripFrom(d, deliveries);
    if (trip.stops.length > 1) {
      return GoogleHandoff(
        googleMapsMultiStopUrl(trip.stops),
        trip.truncated
            ? 'Opening the next ${trip.stops.length} stops in Google Maps (its limit). '
                'Open it again from a later stop for the rest.'
            : 'Opening ${trip.stops.length} stops in Google Maps, in the planned order.',
      );
    }
  }
  if (d.hasClinicCoords) return GoogleHandoff(googleMapsDestinationUrl(d.clinicLat!, d.clinicLng!), null);
  if (d.clinicAddress.trim().isNotEmpty) {
    return GoogleHandoff(
      Uri.https('www.google.com', '/maps/search/', {'api': '1', 'query': d.clinicAddress.trim()}),
      'No destination pin from dispatch — Google Maps will search by the clinic address.',
    );
  }
  return const GoogleHandoff(null, 'No destination available to open in Google Maps.');
}
