import 'package:latlong2/latlong.dart';
import 'deviation_detector.dart';
import 'deviation_utils.dart';

/// Whether / how the most recent Google route-change candidate was handled.
///
///  * [none] — no route-change has happened yet (only the initial baseline).
///  * [awaitingFreshSample] — a candidate arrived and is being HELD until the
///    first valid GPS sample received AFTER it has evaluated the rider against
///    the OLD baseline. The baseline is untouched while awaiting.
///  * [accepted] — a fresh valid sample decided the candidate was safe and it
///    became the new compliance baseline.
///  * [deferred] — a fresh valid sample (or an invalid candidate) decided the
///    candidate was unsafe; the OLD baseline is retained.
enum CandidateStatus { none, awaitingFreshSample, accepted, deferred }

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
/// Two problems this fixes, both LOCAL-ONLY (no Flutter, no Firebase/Firestore,
/// no alerts, no I/O):
///
///  1. (Phase 2B) Naively calling `updateRoute()` on every Google route-change
///     reset the pending off-route streak, so a reroute after sample 1 or 2
///     would stop a real deviation from ever reaching three samples.
///
///  2. (Phase 3B) Google's route-change callback can arrive BEFORE the fresh
///     off-route GPS position. If the candidate were decided immediately, the
///     monitor would judge it against a STALE on-route sample, accept the new
///     route, and move the compliance baseline before the deviation could be
///     measured. So a non-initial candidate is never decided on arrival: it is
///     held as `awaitingFreshSample` and decided only once the first valid GPS
///     sample received AFTER it has first been measured against the OLD
///     baseline. If the rider is stationary the candidate simply keeps waiting
///     (never auto-accepted on a timer) while Google's displayed route still
///     updates normally.
class RouteComplianceMonitor {
  RouteComplianceMonitor({
    DeviationDetector? detector,
    this.candidateMaxDistanceMeters = 150,
  }) : _detector = detector ?? DeviationDetector();

  final DeviationDetector _detector;

  /// A candidate route is only safe to adopt when the rider's latest fresh
  /// valid position is within this distance of the *current* (old) compliance
  /// baseline.
  final double candidateMaxDistanceMeters;

  List<LatLng> _baseline = const <LatLng>[];
  bool _hasBaseline = false;
  int _sdkRouteRevision = 0;
  int _complianceBaselineRevision = 0;
  int _reroutingSignals = 0;

  // Monotonic count of USABLE location samples processed (baseline >= 2 points,
  // accuracy absent or <= detector's max, finite distance). Poor-accuracy or
  // pre-baseline samples never advance it, so they can never unlock a candidate.
  int _validSampleRevision = 0;

  // The newest held candidate + the valid-sample revision at the moment it
  // arrived. It is decided by the FIRST usable sample whose revision exceeds
  // this (i.e. a fresh valid fix received AFTER the route change).
  List<LatLng>? _pendingCandidate;
  int _candidateCreatedAtSampleRevision = 0;

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

  /// Monotonic count of usable location samples processed so far.
  int get validSampleRevision => _validSampleRevision;

  /// The [validSampleRevision] captured when the pending candidate arrived. The
  /// candidate is decided by the first usable sample whose revision exceeds it.
  int get candidateCreatedAtSampleRevision => _candidateCreatedAtSampleRevision;

  /// Whether a candidate route is currently held awaiting a fresh valid sample.
  bool get hasPendingCandidate => _pendingCandidate != null;

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
  /// route. This ALWAYS increments the SDK route revision, and — for a valid,
  /// non-initial candidate — HOLDS it (`awaitingFreshSample`) without touching
  /// the compliance baseline or the detector. It never emits a deviation and
  /// never resolves a confirmed one. The accept/defer decision is deferred to
  /// [addRawSample], made only against the OLD baseline after a fresh valid fix.
  ///
  /// If multiple route-changes arrive before a fresh sample, each still bumps
  /// the SDK revision and the NEWEST candidate replaces the older pending one;
  /// the baseline stays put and one later fresh sample evaluates the newest.
  void onRouteChanged(List<LatLng> candidate) {
    _sdkRouteRevision++;

    // An invalid candidate never disturbs the baseline and never enters the
    // awaiting-fresh-sample gate.
    if (candidate.length < 2) {
      _pendingCandidate = null;
      _candidateStatus = CandidateStatus.deferred;
      _deferReason = CandidateDeferReason.invalidRoute;
      return;
    }

    // Startup: with no baseline yet, the first valid route becomes the baseline
    // immediately — there is nothing to protect and no rider fix to defer to.
    if (!_hasBaseline) {
      _adopt(candidate);
      _pendingCandidate = null;
      _candidateStatus = CandidateStatus.accepted;
      _deferReason = CandidateDeferReason.none;
      return;
    }

    // Non-initial route change: NEVER decide now against a possibly-stale
    // sample. Hold the newest candidate and wait for the first valid GPS sample
    // that arrives AFTER this event (see [addRawSample]). The baseline is left
    // unchanged and the detector's pending streak / confirmed state untouched.
    _pendingCandidate = candidate;
    _candidateCreatedAtSampleRevision = _validSampleRevision;
    _candidateStatus = CandidateStatus.awaitingFreshSample;
    _deferReason = CandidateDeferReason.none;
  }

  /// Feed a raw location sample. It is ALWAYS measured by the detector against
  /// the current (old) COMPLIANCE baseline FIRST — so its off-route / recovery
  /// counters update before any candidate decision. Then, if the sample is
  /// usable and a candidate is being held, the held candidate is decided against
  /// that just-updated OLD-baseline state. Returns the detector transition (from
  /// the OLD baseline), if any.
  DeviationEvent? addRawSample(LatLng point, {double? accuracyMeters}) {
    // 1) Evaluate the rider against the OLD baseline first.
    final event = _detector.addSample(point, accuracyMeters: accuracyMeters);

    // 2) Only a usable fix advances the sample revision and may unlock a
    //    candidate. A poor-accuracy or pre-baseline sample must not.
    if (_isUsableSample(point, accuracyMeters)) {
      _validSampleRevision++;
      if (_pendingCandidate != null &&
          _validSampleRevision > _candidateCreatedAtSampleRevision) {
        _decidePendingCandidate();
      }
    }
    return event;
  }

  /// Google started rerouting. Diagnostic signal only — it must never create a
  /// deviation, touch the baseline / detector, or unlock a candidate.
  void onRerouting() {
    _reroutingSignals++;
  }

  // A sample is usable for candidate-gating when accuracy is acceptable, a real
  // baseline exists, and the distance calculation is finite.
  bool _isUsableSample(LatLng point, double? accuracyMeters) {
    if (accuracyMeters != null &&
        accuracyMeters > _detector.maxAccuracyMeters) {
      return false;
    }
    if (_baseline.length < 2) return false;
    final d = distanceToPolylineMeters(point, _baseline);
    return d.isFinite;
  }

  // Decide the held candidate using the just-processed fresh sample's OLD-
  // baseline result. Accept only when on-route, no pending off-route streak, and
  // within [candidateMaxDistanceMeters] of the old baseline; otherwise defer.
  void _decidePendingCandidate() {
    final candidate = _pendingCandidate;
    if (candidate == null) return;

    if (_detector.isDeviated) {
      _deferPending(CandidateDeferReason.deviated);
      return;
    }
    if (_detector.consecutiveOffRoute > 0) {
      _deferPending(CandidateDeferReason.pendingOffRoute);
      return;
    }
    final d = _detector.latestDistanceMeters;
    if (d != null && d > candidateMaxDistanceMeters) {
      _deferPending(CandidateDeferReason.farFromBaseline);
      return;
    }

    // Safe -> adopt the candidate as the new compliance baseline.
    _adopt(candidate);
    _pendingCandidate = null;
    _candidateStatus = CandidateStatus.accepted;
    _deferReason = CandidateDeferReason.none;
  }

  void _adopt(List<LatLng> route) {
    _baseline = route;
    _detector.updateRoute(route); // pending streaks are 0 whenever we adopt
    _hasBaseline = true;
    _complianceBaselineRevision++;
  }

  void _deferPending(CandidateDeferReason reason) {
    // Retain the old baseline; do NOT touch the detector, so the pending
    // off-route streak and any confirmed deviation both survive. No event. The
    // single fresh-sample evaluation is complete, so the candidate is dropped.
    _pendingCandidate = null;
    _candidateStatus = CandidateStatus.deferred;
    _deferReason = reason;
  }
}
