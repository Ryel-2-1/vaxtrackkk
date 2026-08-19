import 'package:latlong2/latlong.dart';
import 'deviation_utils.dart';

/// Confirmed route-following state.
enum DeviationState { onRoute, deviated }

/// A one-shot transition emitted by [DeviationDetector.addSample].
enum DeviationEvent { deviated, returnedToRoute }

/// Deterministic, pure-Dart route-deviation state machine (LOCAL ONLY).
///
/// No Flutter, no Firebase/Firestore, no alerts, no I/O — it just turns a stream
/// of raw location samples (measured against the *current* active route via the
/// existing [distanceToPolylineMeters]) into confirmed on-route / deviated
/// transitions with hysteresis and consecutive-sample confirmation.
///
/// Rules:
///  * start [DeviationState.onRoute];
///  * a valid sample **> [offRouteThresholdMeters]** from the route counts
///    toward deviation; deviation confirms after [confirmationSamples]
///    consecutive such samples;
///  * while deviated, a valid sample **< [recoveryThresholdMeters]** counts
///    toward recovery; return confirms after [confirmationSamples] consecutive
///    such samples;
///  * samples in the hysteresis band (recovery..offRoute, i.e. 100–150 m by
///    default) trigger neither transition and reset the *pending* streak in the
///    current state;
///  * a sample with supplied accuracy worse than [maxAccuracyMeters] is ignored
///    (no state, no counters, no latest-distance update);
///  * a route with fewer than two points ignores the sample safely;
///  * each transition is emitted exactly once (no re-emission while it stays in
///    that state).
class DeviationDetector {
  DeviationDetector({
    this.offRouteThresholdMeters = 150,
    this.recoveryThresholdMeters = 100,
    this.confirmationSamples = 3,
    this.maxAccuracyMeters = 50,
  });

  final double offRouteThresholdMeters;
  final double recoveryThresholdMeters;
  final int confirmationSamples;
  final double maxAccuracyMeters;

  DeviationState _state = DeviationState.onRoute;
  List<LatLng> _route = const <LatLng>[];
  double? _latestDistanceMeters;
  int _offRouteStreak = 0;
  int _recoveryStreak = 0;
  int _deviationEvents = 0;
  int _returnedEvents = 0;

  // --- Diagnostics ---
  DeviationState get state => _state;
  bool get isDeviated => _state == DeviationState.deviated;
  double? get latestDistanceMeters => _latestDistanceMeters;
  int get consecutiveOffRoute => _offRouteStreak;
  int get consecutiveRecovery => _recoveryStreak;
  int get deviationEventCount => _deviationEvents;
  int get returnedToRouteEventCount => _returnedEvents;
  int get routePointCount => _route.length;

  /// Replace the active route (e.g. after a Google route-change re-fetch).
  ///
  /// Resets ONLY the unconfirmed pending streaks — never the confirmed [state]
  /// or the event counts. A route change alone must never create or resolve a
  /// deviation; a confirmed deviation still requires [confirmationSamples]
  /// recovery samples to clear.
  void updateRoute(List<LatLng> route) {
    _route = route;
    _offRouteStreak = 0;
    _recoveryStreak = 0;
  }

  /// Feed one raw location sample. Returns the transition that fired on THIS
  /// sample, or `null` if none. Never returns the same transition twice while
  /// the detector remains in that state.
  DeviationEvent? addSample(LatLng point, {double? accuracyMeters}) {
    // Poor accuracy -> ignore entirely (no state, counters, or distance change).
    if (accuracyMeters != null && accuracyMeters > maxAccuracyMeters) {
      return null;
    }
    // Insufficient route -> ignore safely.
    if (_route.length < 2) {
      return null;
    }

    final double dist = distanceToPolylineMeters(point, _route);
    _latestDistanceMeters = dist;

    if (_state == DeviationState.onRoute) {
      if (dist > offRouteThresholdMeters) {
        _offRouteStreak++;
        _recoveryStreak = 0;
        if (_offRouteStreak >= confirmationSamples) {
          _state = DeviationState.deviated;
          _offRouteStreak = 0;
          _recoveryStreak = 0;
          _deviationEvents++;
          return DeviationEvent.deviated;
        }
      } else {
        // On-route (< recovery) or hysteresis band: not an off-route sample, so
        // it breaks the consecutive off-route streak.
        _offRouteStreak = 0;
      }
      return null;
    } else {
      if (dist < recoveryThresholdMeters) {
        _recoveryStreak++;
        _offRouteStreak = 0;
        if (_recoveryStreak >= confirmationSamples) {
          _state = DeviationState.onRoute;
          _offRouteStreak = 0;
          _recoveryStreak = 0;
          _returnedEvents++;
          return DeviationEvent.returnedToRoute;
        }
      } else {
        // Off-route or hysteresis band: not a recovery sample, so it breaks the
        // consecutive recovery streak.
        _recoveryStreak = 0;
      }
      return null;
    }
  }
}
