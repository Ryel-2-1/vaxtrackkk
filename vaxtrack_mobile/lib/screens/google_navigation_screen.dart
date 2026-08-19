import 'dart:async';
import 'package:flutter/foundation.dart' show kDebugMode;
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_navigation_flutter/google_navigation_flutter.dart';
import 'package:latlong2/latlong.dart' as ll;
import '../theme/app_theme.dart';
import '../services/route_deviation_alert_service.dart';
import '../utils/deviation_detector.dart';
import '../utils/route_compliance_monitor.dart';

/// Reusable in-app Google Navigation screen for a real delivery.
///
/// Given a clinic's coordinates it: requests foreground location permission,
/// handles Google's first-run Navigation Terms, initializes ONE navigation
/// session, renders the Google Navigation widget, and — only after a deliberate
/// "Start guidance" tap — sets the clinic as the destination and starts
/// turn-by-turn.
///
/// LOCAL route-compliance monitoring (Phase 3A): once guidance starts, a single
/// screen-owned Geolocator position stream (which carries accuracy) drives a
/// [RouteComplianceMonitor]. The SDK/displayed route is kept distinct from the
/// compliance baseline, so a Google reroute cannot erase a pending deviation.
/// This is display-only: it writes NOTHING to Firestore/orders/users/alerts and
/// creates no external side effects.
class GoogleNavigationScreen extends StatefulWidget {
  final double clinicLat;
  final double clinicLng;
  final String? clinicName;
  final String? clinicAddress;

  /// Confirmed identity/display context for a route-deviation incident. When
  /// non-null (the real delivery flow), confirmed deviation / return-to-route
  /// transitions upsert ONE idempotent Firestore alert. When null (the
  /// Firebase-free dev harness), the screen stays fully local — zero Firebase
  /// calls.
  final RouteDeviationContext? alertContext;

  const GoogleNavigationScreen({
    super.key,
    required this.clinicLat,
    required this.clinicLng,
    this.clinicName,
    this.clinicAddress,
    this.alertContext,
  });

  @override
  State<GoogleNavigationScreen> createState() => _GoogleNavigationScreenState();
}

class _GoogleNavigationScreenState extends State<GoogleNavigationScreen> {
  String _status = 'Initializing navigation…';
  bool _sessionReady = false;
  bool _starting =
      false; // guards against repeated presses / duplicate sessions
  bool _navigating = false;

  // Destination comes from the constructor (no hardcoded coordinates).
  LatLng get _destination =>
      LatLng(latitude: widget.clinicLat, longitude: widget.clinicLng);

  // LOCAL-ONLY route-compliance coordinator (one per screen / session).
  final RouteComplianceMonitor _monitor = RouteComplianceMonitor();

  // Exactly one screen-owned Geolocator subscription + the two SDK listeners.
  StreamSubscription<Position>? _posSub;
  StreamSubscription<void>? _rerouteSub;
  StreamSubscription<void>? _routeChangedSub;

  double? _latestAccuracyM;
  int _poorAccuracyCount = 0;
  String? _lastTransition;

  // Firestore incident bridge — only created when a real alert context exists,
  // so the Firebase-free harness (null context) never touches Firebase. Writes
  // are serialized through _alertChain so a deviation and a return can never
  // race; failures are swallowed (guidance must never stop for an alert write).
  RouteDeviationAlertService? _alertService;
  Future<void> _alertChain = Future<void>.value();
  String? _lastAlertWrite; // debug-only status/error
  int _alertWriteCount = 0;

  @override
  void initState() {
    super.initState();
    if (widget.alertContext != null) {
      _alertService = RouteDeviationAlertService();
    }
    _bootstrap();
  }

  @override
  void dispose() {
    _cleanup();
    super.dispose();
  }

  void _setStatus(String s) {
    if (mounted) setState(() => _status = s);
  }

  Future<void> _cleanup() async {
    // Cancel the Geolocator + SDK listeners this screen owns, then stop guidance
    // and release the session (preserving the existing teardown).
    try {
      await _posSub?.cancel();
    } catch (_) {}
    try {
      await _rerouteSub?.cancel();
    } catch (_) {}
    try {
      await _routeChangedSub?.cancel();
    } catch (_) {}
    try {
      if (_navigating) {
        await GoogleMapsNavigator.stopGuidance();
      }
      await GoogleMapsNavigator.cleanup();
    } catch (_) {
      // Best-effort teardown — never throw from dispose.
    }
  }

  Future<void> _bootstrap() async {
    // 1) Foreground location permission (reuse the existing geolocator dep).
    try {
      LocationPermission perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) {
        perm = await Geolocator.requestPermission();
      }
      if (perm == LocationPermission.denied ||
          perm == LocationPermission.deniedForever) {
        _setStatus('Location permission denied — cannot navigate.');
        return;
      }
    } catch (e) {
      _setStatus('Permission error: $e');
      return;
    }

    // 2) Google's first-run Navigation Terms & Conditions (shown normally).
    try {
      final accepted = await GoogleMapsNavigator.areTermsAccepted();
      if (!accepted) {
        await GoogleMapsNavigator.showTermsAndConditionsDialog(
          'VaxTrack Navigation',
          'VaxTrack',
        );
      }
    } catch (e) {
      _setStatus('Terms dialog error: $e');
      return;
    }

    // 3) Initialize exactly one navigation session.
    try {
      await GoogleMapsNavigator.initializeNavigationSession();
      _setStatus('Ready. Tap "Start guidance" to begin.');
      if (mounted) setState(() => _sessionReady = true);
    } catch (e) {
      _setStatus('Navigation session init failed: $e');
    }
  }

  // Flatten Google route segments -> one latlong2 polyline, dropping nulls.
  List<ll.LatLng> _flatten(List<RouteSegment> segments) {
    final out = <ll.LatLng>[];
    for (final seg in segments) {
      final pts = seg.latLngs;
      if (pts == null) continue;
      for (final p in pts) {
        if (p == null) continue;
        out.add(ll.LatLng(p.latitude, p.longitude));
      }
    }
    return out;
  }

  // Fetch + flatten the SDK route and hand it to the monitor as either the
  // initial baseline or a route-change candidate (the monitor decides accept vs
  // defer; the screen never replaces the compliance baseline directly).
  Future<void> _refreshRoute({required bool isRouteChange}) async {
    try {
      final segments = await GoogleMapsNavigator.getRouteSegments();
      final flat = _flatten(segments);
      if (isRouteChange) {
        _monitor.onRouteChanged(flat);
      } else {
        _monitor.setInitialRoute(flat);
      }
      if (mounted) setState(() {});
    } catch (_) {
      // Best-effort; compliance simply waits for a valid baseline.
    }
  }

  // Google started rerouting — diagnostic signal only.
  void _onRerouting() {
    _monitor.onRerouting();
    if (mounted) setState(() {});
  }

  // Google replaced its route — treat the new route as a compliance candidate.
  void _onRouteChanged() {
    _refreshRoute(isRouteChange: true);
  }

  // Start LOCAL compliance processing only once the session is up, guidance has
  // started, and a valid (>= 2 point) baseline exists. Exactly one Geolocator
  // subscription is ever created.
  void _maybeStartComplianceStream() {
    if (_posSub != null) return;
    if (!_navigating ||
        !_monitor.hasBaseline ||
        _monitor.baselinePointCount < 2) {
      return;
    }
    _posSub = Geolocator.getPositionStream(
      locationSettings: const LocationSettings(
        accuracy: LocationAccuracy.bestForNavigation,
        distanceFilter: 15,
      ),
    ).listen(_onPosition, onError: (_) {}, cancelOnError: false);
  }

  // Real Geolocator position (carries accuracy) -> compliance monitor. Raw GPS,
  // NOT road-snapped SDK coordinates. Accuracy worse than the detector's 50 m
  // rule is ignored inside the detector.
  void _onPosition(Position pos) {
    final double acc = pos.accuracy;
    final transition = _monitor.addRawSample(
      ll.LatLng(pos.latitude, pos.longitude),
      accuracyMeters: acc,
    );
    if (transition != null) {
      _lastTransition = transition == DeviationEvent.deviated
          ? 'DEVIATED (local)'
          : 'RETURNED (local)';
      // Capture the deviation distance NOW (the sample above just updated it).
      _dispatchAlert(transition, pos, _monitor.latestDistanceMeters);
    }
    if (mounted) {
      setState(() {
        _latestAccuracyM = acc;
        if (acc > _monitor.detector.maxAccuracyMeters) _poorAccuracyCount++;
      });
    }
  }

  // Serialize the (exactly-once) deviation / return writes onto a single chain
  // so they can never race. Monitor state is already updated and is NEVER
  // rolled back on a write failure; a failure only updates the debug status.
  void _dispatchAlert(
    DeviationEvent transition,
    Position pos,
    double? distanceMeters,
  ) {
    final ctx = widget.alertContext;
    final svc = _alertService;
    if (ctx == null || svc == null) return; // local-only: zero Firebase calls
    final double dist = distanceMeters ?? 0;
    final bool deviated = transition == DeviationEvent.deviated;
    _alertChain = _alertChain.then((_) async {
      try {
        if (deviated) {
          await svc.recordDeviation(
            context: ctx,
            latitude: pos.latitude,
            longitude: pos.longitude,
            distanceMeters: dist,
            accuracyMeters: pos.accuracy,
          );
          _setAlertStatus('deviation synced');
        } else {
          await svc.recordReturn(
            context: ctx,
            latitude: pos.latitude,
            longitude: pos.longitude,
            distanceMeters: dist,
            accuracyMeters: pos.accuracy,
          );
          _setAlertStatus('return synced');
        }
      } catch (e) {
        // Never crash / stop guidance because an alert write failed.
        _setAlertStatus('write failed: $e');
      }
    });
  }

  void _setAlertStatus(String s) {
    _alertWriteCount++;
    if (mounted) setState(() => _lastAlertWrite = s);
  }

  Future<void> _startGuidance() async {
    if (!_sessionReady || _starting || _navigating) return;
    setState(() => _starting = true);
    _setStatus('Setting destination + computing route…');
    try {
      final destinations = Destinations(
        waypoints: <NavigationWaypoint>[
          NavigationWaypoint.withLatLngTarget(
            title: widget.clinicName?.isNotEmpty == true
                ? widget.clinicName!
                : 'Clinic',
            target: _destination,
          ),
        ],
        displayOptions: NavigationDisplayOptions(showDestinationMarkers: true),
      );

      final status = await GoogleMapsNavigator.setDestinations(destinations);
      if (status != NavigationRouteStatus.statusOk) {
        _setStatus('Route failed: $status');
        return;
      }

      // Compliance baseline = the initial Google route geometry.
      await _refreshRoute(isRouteChange: false);

      // Retain the Google rerouting + route-changed listeners.
      _rerouteSub = GoogleMapsNavigator.setOnReroutingListener(_onRerouting);
      _routeChangedSub = GoogleMapsNavigator.setOnRouteChangedListener(
        _onRouteChanged,
      );

      // Begin turn-by-turn only after this deliberate rider action.
      await GoogleMapsNavigator.startGuidance();
      if (mounted) setState(() => _navigating = true);
      _setStatus('Guidance started.');

      // Start local compliance processing only when the baseline is valid.
      _maybeStartComplianceStream();
    } catch (e) {
      _setStatus('Navigation error: $e');
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  // Display-only local visual state (no alert, no persistence).
  Color _stateColor() {
    if (_monitor.isDeviated) {
      return _monitor.consecutiveRecovery > 0 ? Colors.blue : Colors.red;
    }
    return _monitor.consecutiveOffRoute > 0 ? Colors.amber : Colors.green;
  }

  @override
  Widget build(BuildContext context) {
    final subtitle = widget.clinicAddress?.isNotEmpty == true
        ? widget.clinicAddress!
        : (widget.clinicName ?? 'Selected clinic');

    return Scaffold(
      appBar: AppBar(
        title: Text(
          widget.clinicName?.isNotEmpty == true
              ? widget.clinicName!
              : 'Google Navigation',
        ),
        backgroundColor: AppColors.primary,
        foregroundColor: Colors.white,
      ),
      body: Column(
        children: [
          Container(
            width: double.infinity,
            color: AppColors.background,
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  subtitle,
                  style: const TextStyle(
                    fontSize: 12,
                    color: AppColors.textLight,
                  ),
                ),
                const SizedBox(height: 4),
                Row(
                  children: [
                    if (_navigating) ...[
                      // Display-only compliance state dot.
                      Container(
                        width: 10,
                        height: 10,
                        decoration: BoxDecoration(
                          color: _stateColor(),
                          shape: BoxShape.circle,
                        ),
                      ),
                      const SizedBox(width: 6),
                    ],
                    Expanded(
                      child: Text(
                        _status,
                        style: const TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          Expanded(
            child: GoogleMapsNavigationView(
              onViewCreated: (GoogleNavigationViewController controller) {
                controller.setMyLocationEnabled(true);
              },
            ),
          ),
          if (kDebugMode) _debugPanel(),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: SizedBox(
                width: double.infinity,
                child: ElevatedButton.icon(
                  onPressed: (_sessionReady && !_starting && !_navigating)
                      ? _startGuidance
                      : null,
                  icon: const Icon(Icons.assistant_navigation),
                  label: Text(
                    _navigating ? 'Guidance active' : 'Start guidance',
                  ),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.primary,
                    foregroundColor: Colors.white,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  // Compact debug-only diagnostics (kDebugMode). Never shown in release.
  Widget _debugPanel() {
    final c = _stateColor();
    final reason = _monitor.candidateDeferReason == CandidateDeferReason.none
        ? '—'
        : _monitor.candidateDeferReason.name;
    final dist = _monitor.latestDistanceMeters == null
        ? '—'
        : '${_monitor.latestDistanceMeters!.toStringAsFixed(0)}m';
    final acc = _latestAccuracyM == null
        ? '—'
        : '${_latestAccuracyM!.toStringAsFixed(0)}m';
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: const Color(0xFFF8F9FA),
        border: Border(left: BorderSide(color: c, width: 5)),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      child: DefaultTextStyle(
        style: const TextStyle(fontSize: 10, color: Colors.black87),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 10,
                  height: 10,
                  decoration: BoxDecoration(color: c, shape: BoxShape.circle),
                ),
                const SizedBox(width: 6),
                const Text(
                  'LOCAL MONITOR ONLY — no alerts or Firestore writes',
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w800,
                    color: Color(0xFFB00020),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 2),
            Wrap(
              spacing: 12,
              runSpacing: 1,
              children: [
                Text('state: ${_monitor.isDeviated ? "DEVIATED" : "on route"}'),
                Text('dist: $dist'),
                Text('acc: $acc'),
                Text('poor-acc: $_poorAccuracyCount'),
                Text('off: ${_monitor.consecutiveOffRoute}'),
                Text('rec: ${_monitor.consecutiveRecovery}'),
                Text('dev: ${_monitor.deviationEventCount}'),
                Text('ret: ${_monitor.returnedToRouteEventCount}'),
                Text('sdkRev: ${_monitor.sdkRouteRevision}'),
                Text('baseRev: ${_monitor.complianceBaselineRevision}'),
                Text('validRev: ${_monitor.validSampleRevision}'),
                Text('candAt: ${_monitor.candidateCreatedAtSampleRevision}'),
                Text('cand: ${_monitor.candidateStatus.name}/$reason'),
                Text(
                  'alertCtx: ${widget.alertContext == null ? "none (local)" : "on"}',
                ),
                Text('writes: $_alertWriteCount'),
                if (_lastTransition != null) Text('last: $_lastTransition'),
                if (_lastAlertWrite != null) Text('alert: $_lastAlertWrite'),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
