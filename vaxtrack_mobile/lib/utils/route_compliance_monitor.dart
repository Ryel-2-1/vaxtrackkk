import 'package:latlong2/latlong.dart';
import 'deviation_detector.dart';
import 'deviation_utils.dart';

/// Whether the most recent Google route-change candidate was adopted.
enum CandidateStatus { none, accepted, deferred }

/// Why the most recent candidate route was deferred (or invalid).
enum CandidateDeferReason {
  none,
  deviated,
  pendingOffRoute,
  farFromBaseline,
  invalidRoute,
}

/// LOCAL-ONLY coordinator that keeps two routes distinct:
///
///  * the **SDK navigation route** — Google may replace this freely for
///    navigation / rerouting; and
///  * the **compliance baseline route** — the route VaxTrack currently measures
///    the rider against to decide deviation.
///
/// The problem this fixes: naively calling `updateRoute()` on every Google
/// route-change resets the pending off-route streak, so a reroute after sample
/// 1 or 2 would stop a real deviation from ever reaching three samples. Here a
/// new Google route is only a *candidate*; it is adopted as the compliance
/// baseline only when it is safe to do so, and otherwise deferred while the old
/// baseline keeps being monitored.
///
/// No Flutter, no Firebase/Firestore, no alerts, no I/O.
class RouteComplianceMonitor {
  RouteComplianceMonitor({
    DeviationDetector? detector,
    this.candidateMaxDistanceMeters = 150,
  }) : _detector = detector ?? DeviationDetector();

  final DeviationDetector _detector;

  /// A candidate route is only safe to adopt when the rider's latest raw
  /// position is within this distance of the *current* compliance baseline.
  final double candidateMaxDistanceMeters;

  List<LatLng> _baseline = const <LatLng>[];
  LatLng? _lastRawPoint; // latest usable raw sample (for candidate checks)
  bool _hasBaseline = false;
  int _sdkRouteRevision = 0;
  int _complianceBaselineRevision = 0;
  int _reroutingSignals = 0;
  CandidateStatus _candidateStatus = CandidateStatus.none;
  CandidateDeferReason _deferReason = CandidateDeferReason.none;

  // --- Diagnostics (detector passthroughs + coordinator state) ---
  DeviationDetector get detector => _detector;
  DeviationState get detectorState => _detector.state;
  bool get isDeviated => _detector.isDeviated;
  int get consecutiveOffRoute => _detector.consecutiveOffRoute;
  int get consecutiveRecovery => _detector.consecutiveRecovery;
  int get deviationEventCount => _detector.deviationEventCount;
  int get returnedToRouteEventCount => _detector.returnedToRouteEventCount;
  double? get latestDistanceMeters => _detector.latestDistanceMeters;

  int get sdkRouteRevision => _sdkRouteRevision;
  int get complianceBaselineRevision => _complianceBaselineRevision;
  int get baselinePointCount => _baseline.length;
  bool get hasBaseline => _hasBaseline;
  int get reroutingSignalCount => _reroutingSignals;
  CandidateStatus get candidateStatus => _candidateStatus;
  CandidateDeferReason get candidateDeferReason => _deferReason;

  /// Adopt the first valid Google route as the compliance baseline. This is the
  /// initial route, NOT a route-change, so the SDK route revision is unchanged.
  /// A route with fewer than two points is rejected safely (no baseline).
  void setInitialRoute(List<LatLng> route) {
    if (route.length < 2) {
      _candidateStatus = CandidateStatus.deferred;
      _deferReason = CandidateDeferReason.invalidRoute;
      return;
    }
    if (!_hasBaseline) {
      _adopt(route);
      // The initial baseline is not a "candidate".
      _candidateStatus = CandidateStatus.none;
      _deferReason = CandidateDeferReason.none;
    }
  }

  /// Handle a Google route-change. The new SDK route is a CANDIDATE compliance
  /// route: the SDK route revision is incremented, then the candidate is
  /// accepted or deferred per the rules below. This NEVER emits a deviation and
  /// NEVER resolves a confirmed one by itself.
  ///
  /// Accept only when ALL hold: detector is `onRoute`, no pending off-route
  /// streak, and the rider's latest raw position is within
  /// [candidateMaxDistanceMeters] of the current baseline (or startup, before a
  /// baseline / any usable sample). Otherwise defer.
  void onRouteChanged(List<LatLng> candidate) {
    _sdkRouteRevision++;

    if (candidate.length < 2) {
      _defer(CandidateDeferReason.invalidRoute);
      return;
    }
    // Startup: adopt the first usable route as the baseline.
    if (!_hasBaseline) {
      _adopt(candidate);
      _candidateStatus = CandidateStatus.accepted;
      _deferReason = CandidateDeferReason.none;
      return;
    }
    // Defer while a deviation is confirmed — never let a reroute resolve it.
    if (_detector.isDeviated) {
      _defer(CandidateDeferReason.deviated);
      return;
    }
    // Defer while an off-route streak is pending — protect the pending
    // deviation so it can still reach three samples against the old baseline.
    if (_detector.consecutiveOffRoute > 0) {
      _defer(CandidateDeferReason.pendingOffRoute);
      return;
    }
    // Defer if the rider's latest raw position is far from the current baseline.
    if (_lastRawPoint != null && _baseline.length >= 2) {
      final d = distanceToPolylineMeters(_lastRawPoint!, _baseline);
      if (d > candidateMaxDistanceMeters) {
        _defer(CandidateDeferReason.farFromBaseline);
        return;
      }
    }
    // Safe -> adopt as the new compliance baseline.
    _adopt(candidate);
    _candidateStatus = CandidateStatus.accepted;
    _deferReason = CandidateDeferReason.none;
  }

  /// Feed a raw location sample. Measured by the detector against the current
  /// COMPLIANCE baseline (not the SDK route). Returns the transition, if any.
  DeviationEvent? addRawSample(LatLng point, {double? accuracyMeters}) {
    // Record the latest usable raw point (mirror the detector's accuracy gate)
    // for the candidate-distance check on the next route-change.
    if (accuracyMeters == null ||
        accuracyMeters <= _detector.maxAccuracyMeters) {
      _lastRawPoint = point;
    }
    return _detector.addSample(point, accuracyMeters: accuracyMeters);
  }

  /// Google started rerouting. Diagnostic signal only — it must never create a
  /// deviation or touch the compliance baseline / detector state.
  void onRerouting() {
    _reroutingSignals++;
  }

  void _adopt(List<LatLng> route) {
    _baseline = route;
    _detector.updateRoute(route); // pending streaks are 0 whenever we adopt
    _hasBaseline = true;
    _complianceBaselineRevision++;
  }

  void _defer(CandidateDeferReason reason) {
    // Retain the old baseline; do NOT touch the detector, so the pending
    // off-route streak and any confirmed deviation both survive. No event.
    _candidateStatus = CandidateStatus.deferred;
    _deferReason = reason;
  }
}
