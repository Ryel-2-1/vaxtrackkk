import 'dart:async';
import 'package:latlong2/latlong.dart';
import '../models/delivery.dart';
import '../services/route_deviation_alert_service.dart';
import 'deviation_detector.dart';
import 'route_compliance_monitor.dart';
import 'route_utils.dart';

// Pure, widget-free glue for the FREE in-app route-monitoring screen. It reuses
// the existing RouteComplianceMonitor (detection) and RouteDeviationAlertService
// (idempotent Firestore incident) WITHOUT duplicating any detector, alert
// planner, transaction, timestamp, or deterministic-id logic. Nothing here
// imports Flutter, Geolocator, or Firebase runtime, so it is unit-testable with
// no device, network, or Firebase connection.

/// One foreground GPS fix reduced to the fields the compliance monitor needs.
/// The screen maps a Geolocator `Position` to this; tests build it directly.
class GpsSample {
  final double latitude;
  final double longitude;

  /// Reported horizontal accuracy in metres. Samples worse than the detector's
  /// 50 m rule are ignored inside the monitor (no state/counter/distance change).
  final double? accuracyMeters;

  const GpsSample(this.latitude, this.longitude, {this.accuracyMeters});
}

/// The genuine stored compliance route (the dispatcher-saved OpenRouteService
/// polyline) decoded to points. Empty / fewer than two points means there is
/// nothing to measure against.
List<LatLng> compliancePolyline(Delivery delivery) =>
    decodePolyline(delivery.routePolyline);

/// Result of the start-eligibility check for the free in-app monitor. Every
/// unmet requirement contributes a human-readable [blockers] entry so the UI can
/// disable Start and explain exactly why.
class RouteMonitorEligibility {
  final bool canStart;
  final List<String> blockers;

  const RouteMonitorEligibility({
    required this.canStart,
    required this.blockers,
  });

  /// Evaluate start eligibility from REAL data only. Firestore rules remain the
  /// final assignment authority — this is the client-side UX gate:
  ///  * an authenticated rider is required;
  ///  * the delivery must be active (not delivered/cancelled);
  ///  * the delivery must be assigned to THIS rider;
  ///  * destination coordinates must exist;
  ///  * a genuine stored compliance route polyline (>= 2 points) must exist.
  static RouteMonitorEligibility evaluate({
    required Delivery? delivery,
    required String? currentUserUid,
  }) {
    final blockers = <String>[];
    final uid = currentUserUid?.trim() ?? '';

    if (uid.isEmpty) {
      blockers.add('Sign in as the assigned rider to monitor this route.');
    }
    if (delivery == null) {
      blockers.add('No delivery selected.');
      return RouteMonitorEligibility(canStart: false, blockers: blockers);
    }
    if (!delivery.isActive) {
      blockers.add(
        'Monitoring is only available for active deliveries '
        '(this one is ${delivery.statusLabel.toLowerCase()}).',
      );
    }
    final assigned = delivery.assignedRiderId?.trim() ?? '';
    if (uid.isNotEmpty && (assigned.isEmpty || assigned != uid)) {
      blockers.add('This delivery is not assigned to you.');
    }
    if (!delivery.hasClinicCoords) {
      blockers.add('Destination coordinates are not set for this delivery.');
    }
    if (compliancePolyline(delivery).length < 2) {
      blockers.add('No saved route to monitor against yet.');
    }
    return RouteMonitorEligibility(
      canStart: blockers.isEmpty,
      blockers: blockers,
    );
  }
}

/// Build the confirmed identity/display context for one incident from REAL
/// delivery data + the authenticated rider uid. Returns null when identity is
/// incomplete, so the caller never invents an id.
///
///  * `orderId` is the Firestore ORDER document id (`Delivery.id`) — the incident
///    identity and the deterministic alert-doc key.
///  * `orderNumber` stays display-only (never an id).
///  * `riderUid` is the authenticated rider uid.
RouteDeviationContext? buildRouteDeviationContext({
  required Delivery delivery,
  required String? currentUserUid,
}) {
  final uid = currentUserUid?.trim() ?? '';
  if (uid.isEmpty || delivery.id.trim().isEmpty) return null;
  return RouteDeviationContext(
    orderId: delivery.id,
    riderUid: uid,
    orderNumber: delivery.orderNumber,
    clinicName: delivery.clinicName,
    riderName: delivery.assignedRiderName,
  );
}

/// Lifecycle phase of the monitor, for the UI.
enum RouteMonitorPhase { idle, monitoring, stopped }

/// Async dispatch of a confirmed transition to the alert layer. The screen wires
/// these to `RouteDeviationAlertService.recordDeviation` / `recordReturn` (bound
/// to the real context); tests inject capturing fakes.
typedef TransitionDispatch =
    Future<void> Function(GpsSample sample, double distanceMeters);

/// Drives the (reused) [RouteComplianceMonitor] from a stream of [GpsSample]s and
/// forwards confirmed transitions to the (reused) alert layer.
///
/// Decoupled from Geolocator and Firebase: the sample stream and the two
/// dispatch callbacks are injected, so the whole pipeline is deterministically
/// testable. The controller adds ONLY lifecycle/serialization safety — it does
/// not re-implement detection or the alert write.
class RouteMonitorController {
  RouteMonitorController({
    required RouteComplianceMonitor monitor,
    required Stream<GpsSample> Function() sampleStreamFactory,
    required TransitionDispatch onDeviation,
    required TransitionDispatch onReturn,
    this.onChange,
  }) : _monitor = monitor,
       _sampleStreamFactory = sampleStreamFactory,
       _onDeviation = onDeviation,
       _onReturn = onReturn;

  final RouteComplianceMonitor _monitor;
  final Stream<GpsSample> Function() _sampleStreamFactory;
  final TransitionDispatch _onDeviation;
  final TransitionDispatch _onReturn;

  /// Optional UI rebuild hook, invoked after each processed sample / phase
  /// change (never after dispose).
  final void Function()? onChange;

  StreamSubscription<GpsSample>? _sub;

  // Every write is chained here so a deviation and a return can never race.
  Future<void> _chain = Future<void>.value();

  bool _disposed = false;
  RouteMonitorPhase _phase = RouteMonitorPhase.idle;
  GpsSample? _lastSample;
  DeviationEvent? _lastTransition;
  int _dispatchCount = 0;
  String? _lastError;

  RouteComplianceMonitor get monitor => _monitor;
  RouteMonitorPhase get phase => _phase;
  bool get isMonitoring => _phase == RouteMonitorPhase.monitoring;
  bool get isDisposed => _disposed;
  GpsSample? get lastSample => _lastSample;
  DeviationEvent? get lastTransition => _lastTransition;
  bool get isDeviated => _monitor.isDeviated;
  double? get latestDistanceMeters => _monitor.latestDistanceMeters;

  /// Number of transition writes that have completed (for diagnostics/tests).
  int get dispatchCount => _dispatchCount;

  /// Last write error, if any (writes are best-effort; a failure never stops
  /// monitoring).
  String? get lastError => _lastError;

  /// A future that completes once all queued writes have drained.
  Future<void> get pendingWrites => _chain;

  /// Begin monitoring. Idempotent: a second call while already monitoring (or
  /// after dispose) does nothing, so repeated Start taps can never create a
  /// duplicate subscription.
  void start() {
    if (_disposed || _sub != null) return;
    _phase = RouteMonitorPhase.monitoring;
    _sub = _sampleStreamFactory().listen(
      handleSample,
      onError: (_) {}, // never crash monitoring on a GPS error
      cancelOnError: false,
    );
    _notify();
  }

  /// Process one GPS sample. Public so tests can drive the pipeline
  /// deterministically without a real stream. Samples after dispose are ignored;
  /// poor-accuracy samples are ignored inside the monitor (no transition).
  void handleSample(GpsSample sample) {
    if (_disposed) return;
    _lastSample = sample;
    final transition = _monitor.addRawSample(
      LatLng(sample.latitude, sample.longitude),
      accuracyMeters: sample.accuracyMeters,
    );
    if (transition != null) {
      _lastTransition = transition;
      _dispatch(transition, sample, _monitor.latestDistanceMeters ?? 0);
    }
    _notify();
  }

  void _dispatch(DeviationEvent transition, GpsSample sample, double distance) {
    final deviated = transition == DeviationEvent.deviated;
    _chain = _chain.then((_) async {
      if (_disposed) return;
      try {
        if (deviated) {
          await _onDeviation(sample, distance);
        } else {
          await _onReturn(sample, distance);
        }
        _dispatchCount++;
      } catch (e) {
        // Never crash/stop monitoring because an alert write failed.
        _lastError = e.toString();
      }
    });
  }

  /// Stop monitoring by cancelling the GPS subscription. Does NOT feed the
  /// monitor or reset its state, so stopping can never emit a false
  /// deviation/return. Idempotent.
  Future<void> stop() async {
    if (_sub == null) return;
    await _sub!.cancel();
    _sub = null;
    _phase = RouteMonitorPhase.stopped;
    _notify();
  }

  /// Cancel the subscription and mark disposed so any late callback is ignored.
  /// Any in-flight write is allowed to finish; no new work is scheduled.
  Future<void> dispose() async {
    _disposed = true;
    await _sub?.cancel();
    _sub = null;
    await _chain;
  }

  void _notify() {
    if (!_disposed) onChange?.call();
  }
}
