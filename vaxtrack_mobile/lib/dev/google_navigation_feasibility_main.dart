// ISOLATED Google Navigation SDK feasibility + active-route TELEMETRY spike.
//
// Run with:
//   flutter run -t lib/dev/google_navigation_feasibility_main.dart
//
// Dev-only. NOT wired into the production rider app. Does NO Firebase init, NO
// Firestore access, NO external API calls, and uses NO route tokens. Its purpose
// is to prove that google_navigation_flutter 0.10.0 can expose the ACTIVE Google
// route geometry (getRouteSegments) plus the location/reroute events needed for
// route-deviation monitoring, and to feed each road-snapped location into the
// pure-Dart deviation utility (distance only — NO alerts, NO writes).
//
// Import aliases keep the plugin's `LatLng` (gnav.LatLng) distinct from the
// latlong2 `LatLng` (ll.LatLng) that `distanceToPolylineMeters` expects.
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_navigation_flutter/google_navigation_flutter.dart'
    as gnav;
import 'package:latlong2/latlong.dart' as ll;
import '../utils/deviation_utils.dart';
import '../utils/deviation_detector.dart';
import '../utils/route_compliance_monitor.dart';

void main() {
  // Deliberately no Firebase.initializeApp() — this spike must not touch
  // Firebase or Firestore.
  runApp(const _NavFeasibilityApp());
}

class _NavFeasibilityApp extends StatelessWidget {
  const _NavFeasibilityApp();

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Google Navigation Telemetry',
      theme: ThemeData(colorSchemeSeed: Colors.blue, useMaterial3: true),
      home: const NavFeasibilityScreen(),
    );
  }
}

class NavFeasibilityScreen extends StatefulWidget {
  const NavFeasibilityScreen({super.key});

  @override
  State<NavFeasibilityScreen> createState() => _NavFeasibilityScreenState();
}

class _NavFeasibilityScreenState extends State<NavFeasibilityScreen> {
  // Clinic destination (fixed feasibility coordinates).
  static const gnav.LatLng _clinic = gnav.LatLng(
    latitude: 14.5995,
    longitude: 120.9842,
  );

  String _status = 'Initializing…';
  bool _sessionReady = false;
  bool _starting = false;
  bool _navigating = false;

  // --- Active-route telemetry (all in-memory; nothing persisted) ---
  List<ll.LatLng> _activeRoute = <ll.LatLng>[]; // flattened Google route
  int _segmentCount = 0;
  int _pointCount = 0;
  double? _latestDistanceM; // latest road-snapped location -> active route
  int _roadSnappedCount = 0;
  int _rawRoadSnappedCount = 0;
  int _routeChangedCount = 0;
  bool _rawSupported = false;

  // LOCAL-ONLY route-compliance coordinator: keeps the SDK/displayed route
  // distinct from the compliance baseline, and owns the DeviationDetector.
  // Driven by RAW Android navigation locations.
  final RouteComplianceMonitor _monitor = RouteComplianceMonitor();
  String? _lastTransition;

  // Retained subscriptions (cancelled on dispose).
  StreamSubscription<gnav.RoadSnappedLocationUpdatedEvent>? _snapSub;
  StreamSubscription<gnav.RoadSnappedRawLocationUpdatedEvent>? _rawSnapSub;
  StreamSubscription<void>? _rerouteSub;
  StreamSubscription<void>? _routeChangedSub;

  @override
  void initState() {
    super.initState();
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
    // Cancel every listener, stop simulation + guidance, release the session.
    try {
      await _snapSub?.cancel();
    } catch (_) {}
    try {
      await _rawSnapSub?.cancel();
    } catch (_) {}
    try {
      await _rerouteSub?.cancel();
    } catch (_) {}
    try {
      await _routeChangedSub?.cancel();
    } catch (_) {}
    try {
      await gnav.GoogleMapsNavigator.simulator.pauseSimulation();
    } catch (_) {}
    try {
      if (_navigating) await gnav.GoogleMapsNavigator.stopGuidance();
    } catch (_) {}
    try {
      await gnav.GoogleMapsNavigator.cleanup();
    } catch (_) {}
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

    // 2) Google's first-run Navigation Terms (shown normally, never bypassed).
    try {
      final accepted = await gnav.GoogleMapsNavigator.areTermsAccepted();
      if (!accepted) {
        await gnav.GoogleMapsNavigator.showTermsAndConditionsDialog(
          'VaxTrack Navigation Telemetry',
          'VaxTrack',
        );
      }
    } catch (e) {
      _setStatus('Terms dialog error: $e');
      return;
    }

    // 3) Initialize exactly one navigation session.
    try {
      await gnav.GoogleMapsNavigator.initializeNavigationSession();
      _setStatus('Session ready. Press "Start Navigation".');
      if (mounted) setState(() => _sessionReady = true);
    } catch (e) {
      _setStatus('Navigation session init failed: $e');
    }
  }

  // Flatten Google route segments -> one latlong2 polyline, dropping nulls.
  List<ll.LatLng> _flatten(List<gnav.RouteSegment> segments) {
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

  Future<void> _refreshActiveRoute({required bool isRouteChange}) async {
    try {
      final segments = await gnav.GoogleMapsNavigator.getRouteSegments();
      final flat = _flatten(segments);
      // The SDK route is for display only. The compliance baseline is handled
      // separately by the monitor: the initial route is adopted; a route-change
      // is only a CANDIDATE — adopted only when safe, otherwise deferred while
      // the OLD baseline keeps being monitored. A route change never resolves a
      // confirmed deviation and never fires an event by itself.
      if (isRouteChange) {
        _monitor.onRouteChanged(flat);
      } else {
        _monitor.setInitialRoute(flat);
      }
      if (mounted) {
        setState(() {
          _segmentCount = segments.length;
          _activeRoute = flat;
          _pointCount = flat.length;
        });
      }
    } catch (e) {
      _setStatus('getRouteSegments error: $e');
    }
  }

  // Road-snapped location -> distance from the in-memory Google route.
  // Ignores an invalid/empty route. NO alert, NO external write.
  void _onRoadSnapped(gnav.RoadSnappedLocationUpdatedEvent e) {
    double? d = _latestDistanceM;
    if (_activeRoute.length >= 2) {
      d = distanceToPolylineMeters(
        ll.LatLng(e.location.latitude, e.location.longitude),
        _activeRoute,
      );
    }
    if (mounted) {
      setState(() {
        _roadSnappedCount++;
        _latestDistanceM = d;
      });
    }
  }

  // RAW Android navigation location -> the LOCAL deviation detector. Raw (not
  // road-snapped) is used because road-snapped coordinates are snapped onto the
  // route and would understate the true deviation. The raw SDK event carries NO
  // accuracy field, so accuracy is passed as null (unknown) for this isolated
  // simulator test. NO alert, NO Firestore, NO external write.
  void _onRawRoadSnapped(gnav.RoadSnappedRawLocationUpdatedEvent e) {
    final transition = _monitor.addRawSample(
      ll.LatLng(e.location.latitude, e.location.longitude),
      accuracyMeters: null,
    );
    if (transition != null) {
      _lastTransition = transition == DeviationEvent.deviated
          ? 'DEVIATED (local)'
          : 'RETURNED TO ROUTE (local)';
    }
    if (mounted) setState(() => _rawRoadSnappedCount++);
  }

  // Rerouting alone is NOT a deviation. Keep the pre-reroute route so the next
  // road-snapped tick still reports distance from it; the route is replaced only
  // on routeChanged.
  void _onRerouting() {
    // Diagnostic signal only — never creates a deviation or touches the
    // compliance baseline / detector state.
    _monitor.onRerouting();
    if (mounted) setState(() {});
  }

  // Route changed -> re-fetch segments, replace the in-memory route, bump the
  // local revision, and let the next location re-baseline against it.
  void _onRouteChanged() {
    if (mounted) {
      setState(() {
        _routeChangedCount++;
      });
    }
    // Route-change -> the new SDK route is a CANDIDATE compliance route.
    _refreshActiveRoute(isRouteChange: true);
  }

  Future<void> _startNavigation() async {
    if (!_sessionReady || _starting || _navigating) return;
    setState(() => _starting = true);
    _setStatus('Setting destination + computing route…');
    try {
      final destinations = gnav.Destinations(
        waypoints: <gnav.NavigationWaypoint>[
          gnav.NavigationWaypoint.withLatLngTarget(
            title: 'Clinic',
            target: _clinic,
          ),
        ],
        displayOptions: gnav.NavigationDisplayOptions(
          showDestinationMarkers: true,
        ),
      );

      final status = await gnav.GoogleMapsNavigator.setDestinations(
        destinations,
      );
      if (status != gnav.NavigationRouteStatus.statusOk) {
        _setStatus('Route failed: $status');
        return;
      }

      // Telemetry: fetch the ACTIVE Google route geometry + adopt it as the
      // initial compliance baseline.
      await _refreshActiveRoute(isRouteChange: false);

      // Register + retain the location / reroute / route-change listeners.
      _snapSub =
          await gnav.GoogleMapsNavigator.setRoadSnappedLocationUpdatedListener(
            _onRoadSnapped,
          );
      try {
        _rawSnapSub =
            await gnav
                .GoogleMapsNavigator.setRoadSnappedRawLocationUpdatedListener(
              _onRawRoadSnapped,
            );
        _rawSupported = true;
      } catch (_) {
        _rawSupported = false; // Android-only / unsupported on this platform
      }
      _rerouteSub = gnav.GoogleMapsNavigator.setOnReroutingListener(
        _onRerouting,
      );
      _routeChangedSub = gnav.GoogleMapsNavigator.setOnRouteChangedListener(
        _onRouteChanged,
      );

      // Begin turn-by-turn only after this deliberate action.
      await gnav.GoogleMapsNavigator.startGuidance();
      if (mounted) setState(() => _navigating = true);
      _setStatus('Guidance started — telemetry active.');
    } catch (e) {
      _setStatus('Navigation error: $e');
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  // Dev-only: drive the SDK's supported simulation along the CURRENT route.
  Future<void> _runSimulation() async {
    try {
      await gnav.GoogleMapsNavigator.simulator
          .simulateLocationsAlongExistingRoute();
      _setStatus('Simulating along current route…');
    } catch (e) {
      _setStatus('Simulation error: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Google Navigation telemetry test'),
        backgroundColor: Colors.blue,
        foregroundColor: Colors.white,
      ),
      body: Column(
        children: [
          Container(
            width: double.infinity,
            color: Colors.blue.shade50,
            padding: const EdgeInsets.all(12),
            child: Text(
              _status,
              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
            ),
          ),
          _diagnosticsPanel(),
          Expanded(
            child: gnav.GoogleMapsNavigationView(
              onViewCreated: (gnav.GoogleNavigationViewController controller) {
                controller.setMyLocationEnabled(true);
              },
            ),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  Expanded(
                    child: ElevatedButton.icon(
                      onPressed: (_sessionReady && !_starting && !_navigating)
                          ? _startNavigation
                          : null,
                      icon: const Icon(Icons.navigation),
                      label: Text(
                        _navigating ? 'Navigating' : 'Start Navigation',
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: _navigating ? _runSimulation : null,
                      icon: const Icon(Icons.fast_forward),
                      label: const Text('Simulate route'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _diagnosticsPanel() {
    Widget kv(String k, String v) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 1),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(k, style: const TextStyle(fontSize: 11, color: Colors.black54)),
          Text(
            v,
            style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700),
          ),
        ],
      ),
    );
    final dist = _latestDistanceM == null
        ? '—'
        : '${_latestDistanceM!.toStringAsFixed(1)} m';
    final rawDist = _monitor.latestDistanceMeters == null
        ? '—'
        : '${_monitor.latestDistanceMeters!.toStringAsFixed(1)} m';
    final reason = _monitor.candidateDeferReason == CandidateDeferReason.none
        ? '—'
        : _monitor.candidateDeferReason.name;
    return Container(
      width: double.infinity,
      color: const Color(0xFFF1F3F4),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text(
            'LOCAL TEST ONLY — no alerts or Firestore writes',
            style: TextStyle(
              fontSize: 10,
              fontWeight: FontWeight.w800,
              color: Color(0xFFB00020),
            ),
          ),
          const SizedBox(height: 6),
          const Text(
            'Route telemetry',
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 4),
          kv('Route segments', '$_segmentCount'),
          kv('Flattened route points', '$_pointCount'),
          kv('SDK route revision', '${_monitor.sdkRouteRevision}'),
          kv('SDK route points (displayed)', '$_pointCount'),
          kv('Road-snapped distance (diag only)', dist),
          kv('Road-snapped callbacks', '$_roadSnappedCount'),
          kv(
            'Raw road-snapped (${_rawSupported ? "supported" : "n/a"})',
            '$_rawRoadSnappedCount',
          ),
          kv('Rerouting signals', '${_monitor.reroutingSignalCount}'),
          kv('Route-changed callbacks', '$_routeChangedCount'),
          const SizedBox(height: 6),
          const Text(
            'Compliance monitor (RAW location)',
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 4),
          kv(
            'Compliance baseline revision',
            '${_monitor.complianceBaselineRevision}',
          ),
          kv('Compliance baseline points', '${_monitor.baselinePointCount}'),
          kv('Candidate route status', _monitor.candidateStatus.name),
          kv('Candidate defer reason', reason),
          kv('Detector state', _monitor.isDeviated ? 'DEVIATED' : 'on route'),
          kv('Raw distance from baseline', rawDist),
          kv('Pending off-route', '${_monitor.consecutiveOffRoute}'),
          kv('Pending recovery', '${_monitor.consecutiveRecovery}'),
          kv('Deviation events', '${_monitor.deviationEventCount}'),
          kv(
            'Returned-to-route events',
            '${_monitor.returnedToRouteEventCount}',
          ),
          if (_lastTransition != null) kv('Last transition', _lastTransition!),
        ],
      ),
    );
  }
}
