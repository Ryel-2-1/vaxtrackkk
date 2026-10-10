import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/delivery.dart';
import '../services/rider_tracking_service.dart';
import '../theme/app_theme.dart';
import '../tracking/tracking_contract.dart';
import '../tracking/tracking_lifecycle.dart';
import '../utils/deviation_utils.dart';
import '../utils/map_fit.dart';
import '../utils/route_monitor.dart';
import '../utils/safe_log.dart';
import '../widgets/tracking_status_banner.dart';

/// Start / stop Navigation for one delivery on a free OpenStreetMap map.
///
/// The Rider app only REPORTS: Start Navigation opens a navigation session
/// (riderNavigationSessions/{uid}) through the app-wide [riderTracking]
/// controller, which then shares location more often. Whether the rider is off
/// route — more than 500 m from the saved route for 3 minutes — is decided on
/// the SERVER, which also writes the alert. This screen shows the server's
/// decision; the distance it shows next to it is for the rider's information.
///
/// Leaving the screen does NOT stop navigation (it continues, with the
/// foreground-service notification, until the rider taps Stop or the delivery
/// ends). Only one delivery is navigated at a time: starting another replaces
/// it.
class RouteMonitoringScreen extends StatefulWidget {
  final Delivery delivery;

  const RouteMonitoringScreen({super.key, required this.delivery});

  @override
  State<RouteMonitoringScreen> createState() => _RouteMonitoringScreenState();
}

class _RouteMonitoringScreenState extends State<RouteMonitoringScreen> {
  Delivery get d => widget.delivery;

  final _mapController = MapController();

  late final List<LatLng> _route;
  late final String? _uid;
  Stream<Map<String, dynamic>?>? _serverState;
  bool _busy = false;
  bool _mapReady = false;

  static const LatLng _fallbackCenter = LatLng(14.5995, 120.9842);

  bool get _routeAvailable => _route.length >= 2;

  // The server decides whether the stored route is authoritative (current
  // assignment and destination). While navigating, its "unavailable" verdict
  // wins: the line and the distance are hidden, never shown as a basis for
  // deviation.
  bool _routeShown(DeviationDisplay display) =>
      _routeAvailable && display != DeviationDisplay.routeUnavailable;

  static const Map<String, String> _routeReasons = {
    'missing': 'no saved route for this delivery',
    'malformed': 'the saved route could not be read',
    'generated_before_assignment': 'the saved route was made before this delivery was assigned to you',
    'destination_changed': 'the destination changed after the route was saved',
  };

  @override
  void initState() {
    super.initState();
    _uid = FirebaseAuth.instance.currentUser?.uid;
    // The GENUINE stored route (dispatcher-saved), never a generated one.
    _route = compliancePolyline(d);
    final uid = _uid;
    if (uid != null) _serverState = FirestoreTrackingStore().deviationState(uid);
  }

  @override
  void dispose() {
    _mapController.dispose();
    super.dispose();
  }

  bool get _navigatingThis => riderTracking.navigation?.orderId == d.id;
  bool get _navigatingOther => riderTracking.navigation != null && !_navigatingThis;

  NavigationEligibility get _eligibility => navigationEligibility(
        order: TrackedOrder(id: d.id, status: d.status, assignedRiderId: d.assignedRiderId),
        riderUid: _uid,
        routeAvailable: _routeAvailable,
      );

  Future<void> _start() async {
    if (_busy) return;
    setState(() => _busy = true);
    final error = await riderTracking.startNavigation(d.id);
    if (!mounted) return;
    setState(() => _busy = false);
    if (error != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error)));
    }
  }

  Future<void> _stop() async {
    if (_busy) return;
    setState(() => _busy = true);
    await riderTracking.stopNavigation();
    if (mounted) setState(() => _busy = false);
  }

  /// The rider's own latest fix, only while navigating this delivery.
  LatLng? get _riderPoint {
    final fix = riderTracking.lastFix;
    if (!_navigatingThis || fix == null) return null;
    return LatLng(fix.latitude, fix.longitude);
  }

  LatLng? get _destinationPoint =>
      d.hasClinicCoords ? LatLng(d.clinicLat!, d.clinicLng!) : null;

  void _fit() {
    if (!_mapReady) return;
    // Extent-based, not count-based — see [resolveMapFit].
    final fit = resolveMapFit(<LatLng>[..._route, ?_riderPoint, ?_destinationPoint]);
    try {
      switch (fit.kind) {
        case MapFitKind.none:
          break;
        case MapFitKind.center:
          _mapController.move(fit.center!, fit.zoom!);
        case MapFitKind.bounds:
          _mapController.fitCamera(
            CameraFit.bounds(
              bounds: LatLngBounds.fromPoints(fit.boundsPoints),
              padding: const EdgeInsets.all(40),
              maxZoom: kMaxFitZoom,
            ),
          );
      }
    } catch (error, stack) {
      logSuppressedError('RouteMonitoringScreen', 'camera fit skipped', error, stack);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Navigation · ${d.orderNumber}')),
      body: AnimatedBuilder(
        animation: riderTracking,
        builder: (context, _) => StreamBuilder<Map<String, dynamic>?>(
          stream: _serverState,
          builder: (context, snap) {
            final display = _navigatingThis
                ? deviationDisplayFor(snap.data, sessionId: riderTracking.navigation?.sessionId)
                : DeviationDisplay.notNavigating;
            return Column(
              children: [
                Expanded(child: _map(display)),
                _bottomPanel(
                  display,
                  serverError: snap.hasError,
                  serverRouteReason: snap.data?['routeUnavailableReason'] as String?,
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  Color _riderColor(DeviationDisplay display) {
    switch (display) {
      case DeviationDisplay.deviating:
        return Colors.red;
      case DeviationDisplay.pendingDeviation:
        return Colors.orange.shade800;
      default:
        return AppColors.primary;
    }
  }

  Widget _map(DeviationDisplay display) {
    final rider = _riderPoint;
    final dest = _destinationPoint;
    return Stack(
      children: [
        FlutterMap(
          mapController: _mapController,
          options: MapOptions(
            initialCenter: rider ?? dest ?? (_routeShown(display) ? _route.first : _fallbackCenter),
            initialZoom: 14,
            onMapReady: () {
              _mapReady = true;
              WidgetsBinding.instance.addPostFrameCallback((_) => _fit());
            },
          ),
          children: [
            TileLayer(
              urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
              userAgentPackageName: 'com.example.vaxtrack_mobile',
              maxZoom: 19,
            ),
            if (_routeShown(display))
              PolylineLayer(
                polylines: [Polyline(points: _route, color: AppColors.primary, strokeWidth: 5)],
              ),
            MarkerLayer(
              markers: [
                if (dest != null)
                  Marker(point: dest, width: 22, height: 22, child: _dot(const Color(0xFFB45309))),
                if (rider != null)
                  Marker(point: rider, width: 24, height: 24, child: _dot(_riderColor(display))),
              ],
            ),
            RichAttributionWidget(
              attributions: [
                TextSourceAttribution(
                  'OpenStreetMap contributors',
                  onTap: () => launchUrl(
                    Uri.parse('https://openstreetmap.org/copyright'),
                    mode: LaunchMode.externalApplication,
                  ),
                ),
              ],
            ),
          ],
        ),
        Positioned(
          bottom: 12,
          right: 12,
          child: FloatingActionButton.small(
            heroTag: 'route_monitor_recenter',
            backgroundColor: Colors.white,
            foregroundColor: AppColors.primary,
            onPressed: _fit,
            child: const Icon(Icons.center_focus_strong),
          ),
        ),
      ],
    );
  }

  Widget _dot(Color color) => Container(
        decoration: BoxDecoration(
          color: color,
          shape: BoxShape.circle,
          border: Border.all(color: Colors.white, width: 3),
          boxShadow: const [BoxShadow(color: Colors.black38, blurRadius: 4)],
        ),
      );

  Widget _bottomPanel(DeviationDisplay display, {required bool serverError, String? serverRouteReason}) {
    final routeNote = !_routeAvailable
        ? 'no saved route for this delivery'
        : display == DeviationDisplay.routeUnavailable
            ? (_routeReasons[serverRouteReason] ?? 'the saved route cannot be used')
            : null;
    final eligibility = _eligibility;
    return SafeArea(
      top: false,
      child: Container(
        width: double.infinity,
        color: AppColors.background,
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Permission / location-off states, with their recovery actions.
            TrackingStatusBanner(controller: riderTracking),
            if (routeNote != null)
              _note(Icons.alt_route, 'Route not available — $routeNote, so route deviation is not monitored. Ask dispatch to generate the route.'),
            if (_navigatingThis) _statusRow(display),
            if (_navigatingThis && serverError)
              _note(Icons.error_outline, 'Route status could not be loaded. Your location is still shared.'),
            if (_navigatingOther)
              _note(Icons.info_outline, 'You are navigating another delivery. Starting here replaces it.'),
            const SizedBox(height: 10),
            if (!eligibility.canStart && !_navigatingThis) _blockers(eligibility.blockers),
            if (eligibility.canStart || _navigatingThis) _controls(),
            const SizedBox(height: 8),
            const Text(
              'Navigation keeps running if you leave this screen or lock the phone, '
              'with a notification, until you tap Stop or the delivery ends. '
              'Route deviation is checked by VaxTrack (over $kDeviationOffRouteMeters m from the '
              'route for ${kDeviationConfirmSeconds ~/ 60} minutes). Uses free OpenStreetMap.',
              style: TextStyle(fontSize: 11, color: AppColors.textLight),
            ),
          ],
        ),
      ),
    );
  }

  Widget _statusRow(DeviationDisplay display) {
    final rider = _riderPoint;
    final distance = (rider != null && _routeShown(display)) ? distanceToPolylineMeters(rider, _route) : null;
    final color = display == DeviationDisplay.notNavigating ? AppColors.textLight : _riderColor(display);
    final label = display == DeviationDisplay.notNavigating
        ? 'Navigation started — waiting for route status'
        : kDeviationDisplayLabels[display]!;
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        children: [
          Container(width: 12, height: 12, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
          const SizedBox(width: 8),
          Expanded(child: Text(label, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700))),
          if (distance != null)
            Text('${distance.round()} m from route', style: const TextStyle(fontSize: 12, color: AppColors.textLight)),
        ],
      ),
    );
  }

  Widget _note(IconData icon, String text) => Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 15, color: AppColors.textLight),
            const SizedBox(width: 8),
            Expanded(child: Text(text, style: const TextStyle(fontSize: 12, color: AppColors.textDark))),
          ],
        ),
      );

  Widget _blockers(List<String> blockers) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Navigation unavailable', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          ...blockers.map((b) => _note(Icons.info_outline, b)),
        ],
      ),
    );
  }

  Widget _controls() {
    return Row(
      children: [
        Expanded(
          child: ElevatedButton.icon(
            onPressed: (_navigatingThis || _busy) ? null : _start,
            icon: const Icon(Icons.navigation),
            label: const Text('Start Navigation'),
            style: ElevatedButton.styleFrom(backgroundColor: AppColors.primary, foregroundColor: Colors.white),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: ElevatedButton.icon(
            onPressed: (_navigatingThis && !_busy) ? _stop : null,
            icon: const Icon(Icons.stop),
            label: const Text('Stop'),
            style: ElevatedButton.styleFrom(backgroundColor: AppColors.urgent, foregroundColor: Colors.white),
          ),
        ),
      ],
    );
  }
}
