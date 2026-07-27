import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';
import '../services/location_service.dart';
import '../theme/app_theme.dart';
import '../utils/route_utils.dart';

/// In-app navigation map for a delivery, using FREE OpenStreetMap tiles via
/// flutter_map (no API key, no billing). Draws the rider marker, the clinic
/// destination marker (when coordinates exist), and the dispatcher-generated
/// route polyline (when one exists). No routing API is called — the route is
/// read from Firestore. A recenter button re-fetches the rider's position.
/// OpenStreetMap attribution is shown as required by the tile usage policy.
class DeliveryMap extends StatefulWidget {
  final LatLng? initialRider; // from delivery.lastLocation (may be stale)
  final LatLng? clinic; // from clinicLat/clinicLng
  final String? routePolyline; // encoded polyline (precision 5)
  final double height;

  const DeliveryMap({
    super.key,
    this.initialRider,
    this.clinic,
    this.routePolyline,
    this.height = 280,
  });

  @override
  State<DeliveryMap> createState() => _DeliveryMapState();
}

class _DeliveryMapState extends State<DeliveryMap> {
  final _location = LocationService();
  final _mapController = MapController();
  LatLng? _rider;
  bool _ready = false;

  // Fallback camera center (Metro Manila) when there is no rider/clinic point.
  static const LatLng _fallbackCenter = LatLng(14.5995, 120.9842);

  @override
  void initState() {
    super.initState();
    _rider = widget.initialRider;
    // Best-effort fresh position; failures (permission off) keep the initial.
    _refreshRider(animate: false);
  }

  @override
  void dispose() {
    _mapController.dispose();
    super.dispose();
  }

  Future<void> _refreshRider({bool animate = true}) async {
    try {
      final pos = await _location.getCurrentPosition();
      if (!mounted || pos == null) return;
      setState(() => _rider = LatLng(pos.latitude, pos.longitude));
      if (animate && _ready) _mapController.move(_rider!, 16);
    } catch (_) {
      // Best-effort only — never disrupt the delivery flow.
    }
  }

  List<LatLng> get _routePoints => decodePolyline(widget.routePolyline);

  LatLng get _initialCenter => _rider ?? widget.clinic ?? _fallbackCenter;

  void _fit() {
    final pts = <LatLng>[..._routePoints, ?_rider, ?widget.clinic];
    if (pts.length < 2 || !_ready) return;
    try {
      _mapController.fitCamera(
        CameraFit.bounds(
          bounds: LatLngBounds.fromPoints(pts),
          padding: const EdgeInsets.all(40),
        ),
      );
    } catch (_) {
      // Ignore if the map isn't laid out yet.
    }
  }

  List<Marker> _markers() {
    final markers = <Marker>[];
    if (_rider != null) {
      markers.add(Marker(
        point: _rider!,
        width: 22,
        height: 22,
        child: _dot(AppColors.primary),
      ));
    }
    if (widget.clinic != null) {
      markers.add(Marker(
        point: widget.clinic!,
        width: 22,
        height: 22,
        child: _dot(const Color(0xFFB45309)), // amber destination
      ));
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

  @override
  Widget build(BuildContext context) {
    final route = _routePoints;
    return ClipRRect(
      borderRadius: BorderRadius.circular(12),
      child: SizedBox(
        height: widget.height,
        child: Stack(
          children: [
            FlutterMap(
              mapController: _mapController,
              options: MapOptions(
                initialCenter: _initialCenter,
                initialZoom: 14,
                onMapReady: () {
                  _ready = true;
                  WidgetsBinding.instance.addPostFrameCallback((_) => _fit());
                },
              ),
              children: [
                TileLayer(
                  urlTemplate:
                      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                  userAgentPackageName: 'com.example.vaxtrack_mobile',
                  maxZoom: 19,
                ),
                if (route.length > 1)
                  PolylineLayer(
                    polylines: [
                      Polyline(
                        points: route,
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
                heroTag: 'delivery_map_recenter',
                backgroundColor: Colors.white,
                foregroundColor: AppColors.primary,
                onPressed: () => _refreshRider(animate: true),
                child: const Icon(Icons.my_location),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
