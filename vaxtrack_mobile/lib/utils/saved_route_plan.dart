import 'package:latlong2/latlong.dart';

import '../models/delivery.dart';
import 'route_utils.dart';

/// The Dispatcher's saved route for one delivery: THE VaxTrack plan.
///
/// One selector for every Rider screen that draws or describes a route, and
/// the same choice the server makes for route-deviation monitoring
/// (`routeForOrder` in functions/src/riderTracking.js). What the rider sees as
/// "the plan" is therefore exactly what deviation alerts measure against:
///
///  * a stop on a planned trip (`tripId` + `stopSequence > 0`) with a saved
///    `tripPolyline` uses the whole-trip route; anything else uses the order's
///    own `routePolyline`;
///  * a route saved before this assignment, or for an older destination, is
///    not the plan any more and is never drawn as one.
///
/// test/fixtures/saved_route_plan_cases.json is run against both this and the
/// server, so the two cannot drift apart silently.
///
/// Directions from Google Maps are NOT this plan — Google computes its own
/// route — and nothing here describes them.
///
/// Pure: no Flutter or Firebase imports.

/// The provider and profile the web saves for a verified motorcycle route
/// (vaxtrack-web/src/services/routeMetadata.js).
const String kVerifiedRouteProvider = 'valhalla';
const String kVerifiedRouteProfile = 'motorcycle-no-expressways-v1';

enum RoutePlanSource { trip, order }

/// Why there is no usable plan. Same codes the server writes as
/// `routeUnavailableReason` on the rider's deviation state.
enum RoutePlanProblem { missing, malformed, generatedBeforeAssignment, destinationChanged }

const Map<RoutePlanProblem, String> kRoutePlanProblemCodes = {
  RoutePlanProblem.missing: 'missing',
  RoutePlanProblem.malformed: 'malformed',
  RoutePlanProblem.generatedBeforeAssignment: 'generated_before_assignment',
  RoutePlanProblem.destinationChanged: 'destination_changed',
};

/// Rider-facing explanation and recovery for each problem.
const Map<RoutePlanProblem, String> kRoutePlanProblemMessages = {
  RoutePlanProblem.missing:
      'Dispatch has not planned a route for this delivery yet. Ask dispatch to plan it.',
  RoutePlanProblem.malformed:
      'The saved route could not be read. Ask dispatch to plan it again.',
  RoutePlanProblem.generatedBeforeAssignment:
      'The saved route was planned before this delivery was assigned to you. '
      'Ask dispatch to plan it again.',
  RoutePlanProblem.destinationChanged:
      'The destination changed after the route was planned. Ask dispatch to plan it again.',
};

class SavedRoutePlan {
  const SavedRoutePlan._({
    required this.source,
    required this.encodedPolyline,
    required this.points,
    required this.problem,
    required this.motorcycleChecked,
    required this.distanceMeters,
    required this.durationSeconds,
    required this.fingerprint,
  });

  /// Which saved route was chosen (also when it turned out unusable).
  final RoutePlanSource source;

  /// The saved encoded route (precision 5) and its geometry; null / empty
  /// unless [usable].
  final String? encodedPolyline;
  final List<LatLng> points;

  /// Why the plan cannot be used; null when it can.
  final RoutePlanProblem? problem;

  /// The web saved THIS geometry as a Valhalla motorcycle route whose
  /// highway / toll road / ferry flags were checked. Never true for an unusable
  /// plan: nothing is claimed about a route the rider is not shown.
  final bool motorcycleChecked;

  /// Whole trip for a trip plan, this delivery's leg for an order plan.
  final int? distanceMeters;
  final int? durationSeconds;

  /// Changes whenever dispatch saves a different route; equal plans compare
  /// equal. Null when there is no usable plan.
  final String? fingerprint;

  bool get usable => problem == null;
  bool get isTrip => source == RoutePlanSource.trip;

  factory SavedRoutePlan.of(Delivery d) {
    final onTrip = (d.tripId ?? '').isNotEmpty && (d.stopSequence ?? 0) > 0;
    final useTrip = onTrip && (d.tripPolyline ?? '').isNotEmpty;
    final source = useTrip ? RoutePlanSource.trip : RoutePlanSource.order;
    final encoded = useTrip ? d.tripPolyline : d.routePolyline;

    SavedRoutePlan unusable(RoutePlanProblem problem) => SavedRoutePlan._(
          source: source,
          encodedPolyline: null,
          points: const [],
          problem: problem,
          motorcycleChecked: false,
          distanceMeters: null,
          durationSeconds: null,
          fingerprint: null,
        );

    if (encoded == null || encoded.isEmpty) return unusable(RoutePlanProblem.missing);
    final points = decodePolyline(encoded);
    if (points.length < 2) return unusable(RoutePlanProblem.malformed);

    final generated = useTrip ? d.tripGeneratedAt : d.routeGeneratedAt;
    final assigned = d.assignedAt;
    if (generated == null || assigned == null || generated.isBefore(assigned)) {
      return unusable(RoutePlanProblem.generatedBeforeAssignment);
    }
    if (useTrip) {
      // Trips carry no destination revision: a correction after the trip was
      // planned makes it stale.
      final corrected = d.destinationCorrectedAt;
      if (corrected != null && generated.isBefore(corrected)) {
        return unusable(RoutePlanProblem.destinationChanged);
      }
    } else if ((d.routeDestinationRevision ?? 0) != (d.destinationRevision ?? 0)) {
      return unusable(RoutePlanProblem.destinationChanged);
    }

    return SavedRoutePlan._(
      source: source,
      encodedPolyline: encoded,
      points: List.unmodifiable(points),
      problem: null,
      motorcycleChecked: useTrip
          ? d.tripRouteProvider == kVerifiedRouteProvider && d.tripRouteProfile == kVerifiedRouteProfile
          : d.routeProvider == kVerifiedRouteProvider && d.routeProfile == kVerifiedRouteProfile,
      distanceMeters: useTrip ? d.tripDistanceMeters : d.routeDistanceMeters,
      durationSeconds: useTrip ? d.tripDurationSeconds : d.routeDurationSeconds,
      fingerprint: '${source.name}:${encoded.length}:${encoded.hashCode}',
    );
  }

  /// One line naming the plan and exactly what was checked about it.
  String get label {
    final p = problem;
    if (p != null) return kRoutePlanProblemMessages[p]!;
    final scope = isTrip ? 'whole trip' : 'this delivery';
    return motorcycleChecked
        ? 'VaxTrack plan ($scope) · motorcycle route from dispatch, checked for '
            'highway, toll road and ferry flags when it was planned.'
        : 'VaxTrack plan ($scope) · older route, not checked for motorcycles. '
            'Ask dispatch to plan it again.';
  }
}
