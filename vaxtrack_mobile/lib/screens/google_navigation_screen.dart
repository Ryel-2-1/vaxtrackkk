import 'dart:async';
import 'package:flutter/foundation.dart' show kDebugMode;
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_navigation_flutter/google_navigation_flutter.dart';
import 'package:url_launcher/url_launcher.dart';
import '../theme/app_theme.dart';
import '../utils/google_maps_url.dart';
import '../utils/google_navigation_route.dart';
import '../utils/navigation_init_controller.dart';

/// In-app Google Navigation for one destination — DEV HARNESS ONLY.
///
/// Not reachable from the production app (no screen or route opens it; see
/// test/navigation_honesty_test.dart). The Navigation SDK needs a billed Maps
/// project, and it cannot follow VaxTrack's saved motorcycle route: it takes
/// waypoints and routing preferences, or a token from Google's own Routes APIs,
/// never an outside polyline, and it reroutes with Google's logic. So:
///
///  * it asks Google for TWO-WHEELER routing avoiding highways, toll roads and
///    ferries, and refuses (no car fallback) when Google cannot do that;
///  * everything it shows is labelled as Google's directions, never as the
///    VaxTrack plan or as checked;
///  * it runs NO route-deviation check of its own and writes nothing — the
///    server measures deviation against the saved plan, and riders cannot
///    write alerts anyway.
///
/// Given a destination it requests foreground location permission, handles
/// Google's first-run Navigation Terms, initializes ONE navigation session, and
/// — only after a deliberate "Start Google directions" tap — sets the
/// destination and starts turn-by-turn.
class GoogleNavigationScreen extends StatefulWidget {
  final double clinicLat;
  final double clinicLng;
  final String? clinicName;
  final String? clinicAddress;

  const GoogleNavigationScreen({
    super.key,
    required this.clinicLat,
    required this.clinicLng,
    this.clinicName,
    this.clinicAddress,
  });

  @override
  State<GoogleNavigationScreen> createState() => _GoogleNavigationScreenState();
}

class _GoogleNavigationScreenState extends State<GoogleNavigationScreen> {
  // Guidance-phase status line (shown once the session is ready). Pre-ready
  // status text comes from the init phase (see _headerStatus).
  String _status = 'Ready. Tap "Start Google directions" to begin.';
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

  // Google's rerouting signal — shown, never acted on.
  StreamSubscription<void>? _rerouteSub;
  bool _googleRerouted = false;

  @override
  void initState() {
    super.initState();
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
    // Cancel the SDK listener this screen owns.
    try {
      await _rerouteSub?.cancel();
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

  // External Google Maps fallback used from the init-failure panel. Same
  // motorcycle-mode URL as the delivery screen's handoff (one shared builder);
  // failures are surfaced, not silent.
  Future<void> _openExternalMaps() async {
    final Uri uri = googleMapsDestinationUrl(widget.clinicLat, widget.clinicLng);
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

  Future<void> _startGuidance() async {
    if (_init.phase != NavInitPhase.ready || _starting || _navigating) return;
    setState(() => _starting = true);
    _setStatus('Asking Google for motorcycle directions…');
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
        // Motorcycle routing without the roads the VaxTrack plan rejects.
        // Google treats these as preferences; VaxTrack cannot verify its route.
        routingOptions: RoutingOptions(
          travelMode: NavigationTravelMode.twoWheeler,
          avoidHighways: kGoogleAvoidHighways,
          avoidTolls: kGoogleAvoidTolls,
          avoidFerries: kGoogleAvoidFerries,
        ),
      );

      final status = await GoogleMapsNavigator.setDestinations(destinations);
      final problem = googleRouteStatusMessage(status.name);
      if (problem != null) {
        // No retry in another travel mode: never a car route.
        _setStatus(problem);
        return;
      }

      _rerouteSub = GoogleMapsNavigator.setOnReroutingListener(() {
        if (mounted) setState(() => _googleRerouted = true);
      });

      // Begin turn-by-turn only after this deliberate rider action.
      await GoogleMapsNavigator.startGuidance();
      if (mounted) setState(() => _navigating = true);
      _setStatus('Google directions started.');
    } catch (e) {
      if (kDebugMode) debugPrint('[GoogleNavigation] start failed: $e');
      _setStatus('Google directions could not start. Follow the VaxTrack route.');
    } finally {
      if (mounted) setState(() => _starting = false);
    }
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
                Text(
                  _headerStatus(),
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 4),
                const Text(
                  kGoogleDirectionsLabel,
                  style: TextStyle(fontSize: 12, color: AppColors.textDark),
                ),
                if (_googleRerouted)
                  const Text(
                    'Google changed its route. The VaxTrack plan did not change.',
                    style: TextStyle(fontSize: 12, color: AppColors.textLight),
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
                      _navigating ? 'Google directions active' : 'Start Google directions',
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
  //
  // It also carries an escape hatch: if the native dialog never presents (the
  // usual symptom of a missing/unauthorized Maps key, where showTerms() hangs),
  // the rider is not trapped — they can still fall back to external Google Maps
  // or return to the delivery. These controls don't dismiss the native dialog;
  // they sit behind it and only matter when it fails to appear.
  Widget _awaitingTermsPanel() {
    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.fact_check_outlined,
              size: 40, color: AppColors.textLight),
          const SizedBox(height: 12),
          const Text(
            'Please review and accept Google’s navigation terms to continue.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 14, color: AppColors.textDark),
          ),
          const SizedBox(height: 8),
          const Text(
            'If no terms dialog appears, in-app navigation isn’t available on '
            'this build yet — use Google Maps instead.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, color: AppColors.textLight),
          ),
          const SizedBox(height: 20),
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
}
