import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/delivery.dart';
import '../services/route_deviation_alert_service.dart';
import '../theme/app_theme.dart';
import '../utils/route_compliance_monitor.dart';
import '../utils/route_monitor.dart';

/// FREE in-app route-monitoring screen (no paid Google Navigation SDK, no
/// MAPS_API_KEY, no billing, no Navigation Terms).
///
/// It renders the delivery on a flutter_map / OpenStreetMap map and, once the
/// rider explicitly taps Start, drives the existing [RouteComplianceMonitor]
/// from a foreground Geolocator stream. Confirmed deviation / return transitions
/// are forwarded — via [RouteMonitorController] — to the existing
/// [RouteDeviationAlertService], which writes the ONE idempotent
/// `route_deviation_{orderId}_{riderUid}` incident. No detector, alert planner,
/// transaction, timestamp, or id logic is re-implemented here.
///
/// Foreground-only: monitoring runs solely while this screen is on top. There is
/// no background location and no claim of monitoring while an external maps app
/// is open.
class RouteMonitoringScreen extends StatefulWidget {
  final Delivery delivery;

  const RouteMonitoringScreen({super.key, required this.delivery});

  @override
  State<RouteMonitoringScreen> createState() => _RouteMonitoringScreenState();
}

class _RouteMonitoringScreenState extends State<RouteMonitoringScreen> {
  Delivery get d => widget.delivery;

  final _mapController = MapController();

  late final RouteComplianceMonitor _monitor;
  late final RouteMonitorEligibility _eligibility;
  late final List<LatLng> _baseline;

  RouteMonitorController? _controller;
  RouteDeviationContext? _ctx;
  String? _uid;
  bool _mapReady = false;

  static const LatLng _fallbackCenter = LatLng(14.5995, 120.9842);

  @override
  void initState() {
    super.initState();
    _uid = FirebaseAuth.instance.currentUser?.uid;
    _baseline = compliancePolyline(d);
    _eligibility = RouteMonitorEligibility.evaluate(
      delivery: d,
      currentUserUid: _uid,
    );

    // Reuse the existing monitor; its compliance baseline is the GENUINE stored
    // route polyline (dispatcher-saved), never a generated one.
    _monitor = RouteComplianceMonitor();
    if (_baseline.length >= 2) {
      _monitor.setInitialRoute(_baseline);
    }

    // Confirmed identity from REAL data. Null when identity is incomplete, which
    // also keeps the controller (and Start) unavailable.
    _ctx = buildRouteDeviationContext(delivery: d, currentUserUid: _uid);
    final ctx = _ctx;
    if (ctx != null) {
      final svc = RouteDeviationAlertService();
      _controller = RouteMonitorController(
        monitor: _monitor,
        sampleStreamFactory: _sampleStream,
        onDeviation: (s, dist) => svc.recordDeviation(
          context: ctx,
          latitude: s.latitude,
          longitude: s.longitude,
          distanceMeters: dist,
          accuracyMeters: s.accuracyMeters,
        ),
        onReturn: (s, dist) => svc.recordReturn(
          context: ctx,
          latitude: s.latitude,
          longitude: s.longitude,
          distanceMeters: dist,
          accuracyMeters: s.accuracyMeters,
        ),
        onChange: _onControllerChange,
      );
    }
  }

  @override
  void dispose() {
    // Leaving the screen stops monitoring: cancel the GPS subscription and mark
    // the controller disposed so no late callback runs, then release the map.
    _controller?.dispose();
    _mapController.dispose();
    super.dispose();
  }

  void _onControllerChange() {
    if (mounted) setState(() {});
  }

  // Foreground-only Geolocator stream mapped to the pure GpsSample the monitor
  // consumes. Created ONLY when the controller subscribes (after Start).
  Stream<GpsSample> _sampleStream() {
    return Geolocator.getPositionStream(
      locationSettings: const LocationSettings(
        accuracy: LocationAccuracy.bestForNavigation,
        distanceFilter: 10,
      ),
    ).map(
      (p) => GpsSample(p.latitude, p.longitude, accuracyMeters: p.accuracy),
    );
  }

  Future<bool> _ensurePermission() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) return false;
      var perm = await Geolocator.checkPermission();
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

  Future<void> _start() async {
    final c = _controller;
    if (c == null || !_eligibility.canStart || c.isMonitoring) return;
    final granted = await _ensurePermission();
    if (!granted) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Location permission is required to monitor the route.',
            ),
          ),
        );
      }
      return;
    }
    c.start();
  }

  Future<void> _stop() async {
    await _controller?.stop();
    if (mounted) setState(() {});
  }

  LatLng? get _riderPoint {
    final s = _controller?.lastSample;
    if (s != null) return LatLng(s.latitude, s.longitude);
    final last = d.lastLocation;
    if (last != null) return LatLng(last.latitude, last.longitude);
    return null;
  }

  LatLng? get _destinationPoint =>
      d.hasClinicCoords ? LatLng(d.clinicLat!, d.clinicLng!) : null;

  LatLng get _initialCenter =>
      _riderPoint ?? _destinationPoint ?? _fallbackCenter;

  Color get _stateColor {
    final c = _controller;
    if (c == null) return AppColors.textLight;
    return c.isDeviated ? Colors.red : Colors.green;
  }

  void _fit() {
    final pts = <LatLng>[..._baseline, ?_riderPoint, ?_destinationPoint];
    if (pts.length < 2 || !_mapReady) return;
    try {
      _mapController.fitCamera(
        CameraFit.bounds(
          bounds: LatLngBounds.fromPoints(pts),
          padding: const EdgeInsets.all(40),
        ),
      );
    } catch (_) {
      // Ignore if not laid out yet.
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Route Monitoring · ${d.orderNumber}')),
      body: Column(
        children: [
          Expanded(child: _map()),
          _bottomPanel(),
        ],
      ),
    );
  }

  Widget _map() {
    return Stack(
      children: [
        FlutterMap(
          mapController: _mapController,
          options: MapOptions(
            initialCenter: _initialCenter,
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
            if (_baseline.length > 1)
              PolylineLayer(
                polylines: [
                  Polyline(
                    points: _baseline,
                    color: AppColors.primary,
                    strokeWidth: 5,
                  ),
                ],
              ),
            MarkerLayer(markers: _markers()),
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

  List<Marker> _markers() {
    final markers = <Marker>[];
    final rider = _riderPoint;
    final dest = _destinationPoint;
    if (dest != null) {
      markers.add(
        Marker(
          point: dest,
          width: 22,
          height: 22,
          child: _dot(const Color(0xFFB45309)), // amber destination
        ),
      );
    }
    if (rider != null) {
      markers.add(
        Marker(point: rider, width: 24, height: 24, child: _dot(_stateColor)),
      );
    }
    return markers;
  }

  Widget _dot(Color color) => Container(
    decoration: BoxDecoration(
      color: color,
      shape: BoxShape.circle,
      border: Border.all(color: Colors.white, width: 3),
      boxShadow: const [BoxShadow(color: Colors.black38, blurRadius: 4)],
    ),
  );

  Widget _bottomPanel() {
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
            _statusRow(),
            const SizedBox(height: 10),
            if (!_eligibility.canStart) _blockersBox(),
            if (_eligibility.canStart) _controlsRow(),
            const SizedBox(height: 8),
            const Text(
              'Monitoring runs only while this screen is open — leaving this '
              'screen stops it. Uses free OpenStreetMap; no Google Navigation '
              'required. Location is not tracked in the background.',
              style: TextStyle(fontSize: 11, color: AppColors.textLight),
            ),
          ],
        ),
      ),
    );
  }

  Widget _statusRow() {
    final c = _controller;
    final monitoring = c?.isMonitoring ?? false;
    final deviated = c?.isDeviated ?? false;
    final dist = c?.latestDistanceMeters;
    final statusText = !monitoring
        ? (c?.phase == RouteMonitorPhase.stopped
              ? 'Monitoring stopped'
              : 'Not monitoring')
        : (deviated ? 'Off route' : 'On route');
    return Row(
      children: [
        Container(
          width: 12,
          height: 12,
          decoration: BoxDecoration(
            color: monitoring ? _stateColor : AppColors.textLight,
            shape: BoxShape.circle,
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            statusText,
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
          ),
        ),
        Text(
          dist == null ? 'Distance —' : '${dist.round()} m from route',
          style: const TextStyle(fontSize: 12, color: AppColors.textLight),
        ),
      ],
    );
  }

  Widget _blockersBox() {
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
          const Text(
            'Monitoring unavailable',
            style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 6),
          ..._eligibility.blockers.map(
            (b) => Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(
                    Icons.info_outline,
                    size: 14,
                    color: AppColors.textLight,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      b,
                      style: const TextStyle(
                        fontSize: 12,
                        color: AppColors.textDark,
                      ),
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

  Widget _controlsRow() {
    final monitoring = _controller?.isMonitoring ?? false;
    return Row(
      children: [
        Expanded(
          child: ElevatedButton.icon(
            onPressed: monitoring ? null : _start,
            icon: const Icon(Icons.play_arrow),
            label: const Text('Start Route Monitoring'),
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.primary,
              foregroundColor: Colors.white,
            ),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: ElevatedButton.icon(
            onPressed: monitoring ? _stop : null,
            icon: const Icon(Icons.stop),
            label: const Text('Stop Monitoring'),
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.urgent,
              foregroundColor: Colors.white,
            ),
          ),
        ),
      ],
    );
  }
}
