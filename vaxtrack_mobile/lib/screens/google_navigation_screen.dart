import 'dart:async';
import 'package:flutter/foundation.dart' show kDebugMode;
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_navigation_flutter/google_navigation_flutter.dart';
import 'package:latlong2/latlong.dart' as ll;
import 'package:url_launcher/url_launcher.dart';
import '../theme/app_theme.dart';
import '../services/route_deviation_alert_service.dart';
import '../utils/deviation_detector.dart';
import '../utils/navigation_init_controller.dart';
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
  // Guidance-phase status line (shown once the session is ready). Pre-ready
  // status text comes from the init phase (see _headerStatus).
  String _status = 'Ready. Tap "Start guidance" to begin.';
  bool _starting =
      false; // guards against repeated presses / duplicate sessions
  bool _navigating = false;

  // Consent + session-initialization state machine. Runs the official Google
  // Navigation Terms flow before initializeNavigationSession(), guards against
  // duplicate initialization / dialogs, and drives the loading / declined /
  // failed / ready UI. Created in initState; started after the first frame.
  late final NavigationInitController _init;

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
    _init = NavigationInitController(
      ensurePermission: _ensurePermission,
      areTermsAccepted: GoogleMapsNavigator.areTermsAccepted,
      // Official Google Navigation consent dialog — the SDK persists the result;
      // we never simulate or auto-accept it.
      showTerms: () => GoogleMapsNavigator.showTermsAndConditionsDialog(
        'VaxTrack Rider Navigation',
        '3MGS Pharma Inc.',
      ),
      initSession: () => GoogleMapsNavigator.initializeNavigationSession(),
      disposeSession: () => GoogleMapsNavigator.cleanup(),
      // Clears the SDK's terms-accepted flag when init reports termsNotAccepted,
      // so the next "Review navigation terms" tap re-shows the native dialog.
      resetTerms: () => GoogleMapsNavigator.resetTermsAccepted(),
      // A late "terms not accepted" from init is treated as a decline (so the
      // rider can Review terms), not a generic failure.
      isTermsError: (e) =>
          e is SessionInitializationException &&
          e.code == SessionInitializationError.termsNotAccepted,
      onChange: () {
        if (mounted) setState(() {});
      },
      onError: (e) {
        if (kDebugMode) debugPrint('[GoogleNavigation] init failed: $e');
      },
      // Debug-only stage logging for the consent/init flow (no keys/secrets).
      onLog: (m) {
        if (kDebugMode) debugPrint('[GoogleNavigation] $m');
      },
    );
    // Start ONLY after the first frame, when the Android activity is attached —
    // initializing from initState/build runs too early and makes the Terms
    // dialog fail to register, which is the confirmed termsNotAccepted cause.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _init.start();
    });
  }

  @override
  void dispose() {
    // Mark disposed first so no async continuation updates state afterward.
    _init.markDisposed();
    _cleanup();
    super.dispose();
  }

  void _setStatus(String s) {
    if (mounted) setState(() => _status = s);
  }

  /// Foreground location permission (reuse the existing geolocator dep).
  Future<bool> _ensurePermission() async {
    try {
      LocationPermission perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) {
        perm = await Geolocator.requestPermission();
      }
      if (perm == LocationPermission.denied ||
          perm == LocationPermission.deniedForever) {
        return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> _cleanup() async {
    // Cancel the Geolocator + SDK listeners this screen owns.
    try {
      await _posSub?.cancel();
    } catch (_) {}
    try {
      await _rerouteSub?.cancel();
    } catch (_) {}
    try {
      await _routeChangedSub?.cancel();
    } catch (_) {}
    // Only stop guidance / release the session when THIS screen owns an
    // initialized session — never clean up a session we did not create (avoids
    // double cleanup and interfering when init never succeeded). If init is
    // still in flight, the controller releases the session itself once it
    // completes and sees the disposed flag.
    if (!_init.ownsSession) return;
    try {
      if (_navigating) {
        await GoogleMapsNavigator.stopGuidance();
      }
      await GoogleMapsNavigator.cleanup();
    } catch (_) {
      // Best-effort teardown — never throw from dispose.
    }
  }

  // Re-run the consent + initialization flow ("Review navigation terms"). The
  // controller guards against concurrent attempts, so a rapid double-tap can
  // never start two initializations or show two Terms dialogs.
  Future<void> _reviewTerms() {
    if (kDebugMode) debugPrint('[GoogleNavigation] retry tapped');
    return _init.retry();
  }

  // External Google Maps fallback used from the init-failure panel. Same URL
  // format as the delivery screen's handoff; failures are surfaced, not silent.
  Future<void> _openExternalMaps() async {
    final Uri uri = Uri.parse(
      'https://www.google.com/maps/dir/?api=1'
      '&destination=${widget.clinicLat},${widget.clinicLng}&travelmode=driving',
    );
    try {
      final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
      if (!ok && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Could not open Google Maps — no maps app is available.'),
          ),
        );
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Could not open Google Maps on this device.'),
          ),
        );
      }
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
    if (_init.phase != NavInitPhase.ready || _starting || _navigating) return;
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
                        _headerStatus(),
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
          // The platform navigation view is created ONLY after the session has
          // initialized successfully — never under a preparing/declined/failed
          // state (which would show a blank interactive map).
          if (_init.phase == NavInitPhase.ready) ...[
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
                    onPressed: (!_starting && !_navigating)
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
          ] else
            Expanded(child: _phasePanel()),
        ],
      ),
    );
  }

  // Header status line, driven by the init phase (so it never sticks on
  // "Initializing navigation…"). Guidance messages take over once ready.
  String _headerStatus() {
    switch (_init.phase) {
      case NavInitPhase.preparing:
      case NavInitPhase.idle:
        return 'Preparing navigation…';
      case NavInitPhase.awaitingTermsDecision:
        return 'Review the navigation terms to continue';
      case NavInitPhase.declined:
        return 'Navigation terms not accepted';
      case NavInitPhase.failed:
        return 'In-app navigation unavailable';
      case NavInitPhase.ready:
        return _status;
    }
  }

  // Non-ready body: an explicit loading / awaiting-terms / declined / failed
  // panel, so the screen is never an indefinitely blank map or a spinner stuck
  // behind the native dialog.
  Widget _phasePanel() {
    switch (_init.phase) {
      case NavInitPhase.awaitingTermsDecision:
        return _awaitingTermsPanel();
      case NavInitPhase.declined:
        return _declinedPanel();
      case NavInitPhase.failed:
        return _failedPanel();
      case NavInitPhase.preparing:
      case NavInitPhase.idle:
      case NavInitPhase.ready:
        return _loadingPanel();
    }
  }

  // Shown while the native Terms dialog is expected to be on screen. NOT a
  // spinner (the dialog is user-driven and may stay up while the rider reads) —
  // just a stable, quiet message behind the dialog. The map is never rendered.
  Widget _awaitingTermsPanel() {
    return const Center(
      child: Padding(
        padding: EdgeInsets.all(24),
        child: Text(
          'Please review and accept Google’s navigation terms to continue.',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 14, color: AppColors.textDark),
        ),
      ),
    );
  }

  // "Preparing navigation…" — shown while checking permission/Terms or showing
  // the Terms dialog. No interactive map is exposed underneath.
  Widget _loadingPanel() {
    return const Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          SizedBox(
            width: 26,
            height: 26,
            child: CircularProgressIndicator(strokeWidth: 2.5),
          ),
          SizedBox(height: 14),
          Text(
            'Preparing navigation…',
            style: TextStyle(fontSize: 14, color: AppColors.textDark),
          ),
        ],
      ),
    );
  }

  // Rider declined / closed the Terms (or init reported termsNotAccepted). No
  // session was initialized. Offers Review terms, Google Maps, and Back.
  Widget _declinedPanel() {
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.assignment_late_outlined,
              size: 40, color: AppColors.textLight),
          const SizedBox(height: 12),
          const Text(
            'Google’s navigation terms must be accepted before using in-app '
            'navigation.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 14, color: AppColors.textDark),
          ),
          const SizedBox(height: 20),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton.icon(
              onPressed: _init.isBusy ? null : _reviewTerms,
              icon: const Icon(Icons.fact_check_outlined),
              label: const Text('Review navigation terms'),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.primary,
                foregroundColor: Colors.white,
              ),
            ),
          ),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              onPressed: _openExternalMaps,
              icon: const Icon(Icons.map_outlined),
              label: const Text('Open in Google Maps'),
            ),
          ),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: TextButton(
              onPressed: () => Navigator.of(context).maybePop(),
              child: const Text('Back to delivery'),
            ),
          ),
        ],
      ),
    );
  }

  // Initialization failed for a non-terms reason (e.g. Maps key / SDK config).
  // Keeps the friendly fallback; the raw error is shown only in debug builds.
  Widget _failedPanel() {
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.navigation_outlined,
              size: 40, color: AppColors.textLight),
          const SizedBox(height: 12),
          const Text(
            'In-app Google Navigation is unavailable right now. You can still '
            'navigate using the Google Maps app.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 14, color: AppColors.textDark),
          ),
          const SizedBox(height: 20),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton.icon(
              onPressed: _openExternalMaps,
              icon: const Icon(Icons.map_outlined),
              label: const Text('Open in Google Maps'),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.primary,
                foregroundColor: Colors.white,
              ),
            ),
          ),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton(
              onPressed: () => Navigator.of(context).maybePop(),
              child: const Text('Back to delivery'),
            ),
          ),
          if (kDebugMode && _init.lastError != null) ...[
            const SizedBox(height: 12),
            Text(
              'Debug: ${_init.lastError}',
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 10, color: AppColors.textLight),
            ),
          ],
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
