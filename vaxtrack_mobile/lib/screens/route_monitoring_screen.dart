import 'dart:async';

import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/delivery.dart';
import '../services/delivery_service.dart';
import '../services/rider_tracking_service.dart';
import '../theme/app_theme.dart';
import '../tracking/tracking_contract.dart';
import '../tracking/tracking_lifecycle.dart';
import '../utils/deviation_utils.dart';
import '../utils/google_maps_url.dart';
import '../utils/map_fit.dart';
import '../utils/route_screen_state.dart';
import '../utils/safe_log.dart';
import '../utils/saved_route_plan.dart';
import '../utils/trip_route.dart';
import '../widgets/tracking_status_banner.dart';

/// The VaxTrack route for one delivery, on a free OpenStreetMap map.
///
/// It shows the saved VaxTrack plan — the route dispatch planned for a
/// motorcycle, chosen by [SavedRoutePlan] exactly as the server chooses its
/// deviation baseline — with the next stop, the rider's GPS and the route
/// status. It is not turn-by-turn: "Turn-by-turn in Google Maps" hands off to
/// Google, which picks its own roads, and is labelled as such.
///
/// Start opens a navigation session (riderNavigationSessions/{uid}) through the
/// app-wide [riderTracking] controller, which then shares location more often.
/// Whether the rider is off the plan — more than 500 m from it for 3 minutes —
/// is decided on the SERVER, which also writes the alert. This screen shows the
/// server's decision; the distance next to it is for the rider's information.
///
/// The order is followed live, so a route dispatch re-plans while the rider is
/// here replaces the line on the map (and says so) — the screen never keeps
/// drawing a route the server no longer measures against.
///
/// Leaving the screen does NOT stop navigation (it continues, with the
/// foreground-service notification, until the rider taps Stop or the delivery
/// ends). Only one delivery is navigated at a time: starting another replaces
/// it. When a trip stop is finished, navigation carries on to the next stop by
/// itself, and an open screen moves on with it.
class RouteMonitoringScreen extends StatefulWidget {
  final Delivery delivery;

  const RouteMonitoringScreen({super.key, required this.delivery});

  @override
  State<RouteMonitoringScreen> createState() => _RouteMonitoringScreenState();
}

class _RouteMonitoringScreenState extends State<RouteMonitoringScreen> {
  /// The order as last delivered by the live feed (the pushed copy until then).
  late Delivery _delivery = widget.delivery;
  Delivery get d => _delivery;

  /// The rider's deliveries from the same feed: trip stops for the next-stop
  /// line, the map and the Google Maps hand-off. Null until the first snapshot.
  List<Delivery>? _deliveries;

  /// The order left the rider's list (finished, cancelled or reassigned).
  bool _gone = false;
  bool _feedError = false;

  // Replaced when the screen follows navigation on to the next stop: that
  // stop's plan is a starting point, not a change to this one.
  PlanChangeTracker _planChanges = PlanChangeTracker();
  PlanChange _planChange = PlanChange.none;

  final _mapController = MapController();

  /// Firebase Auth's current user, read each time it is needed — never cached
  /// for the screen's lifetime. Auth is the authority on who is signed in; the
  /// tracking controller decides whether it is attached to that rider yet.
  String? get _uid => FirebaseAuth.instance.currentUser?.uid;
  Stream<Map<String, dynamic>?>? _serverState;
  StreamSubscription<List<Delivery>>? _orderSub;
  // GPS age is shown relative to now; re-render so "no fix for N min"
  // appears even when no new fix arrives.
  Timer? _clock;
  bool _busy = false;
  bool _mapReady = false;

  static const LatLng _fallbackCenter = LatLng(14.5995, 120.9842);

  SavedRoutePlan get _plan => SavedRoutePlan.of(d);

  // The server decides whether the stored route is the authoritative baseline
  // for this session. While navigating, its "unavailable" verdict wins: the
  // line and the distance are hidden, never shown as a basis for deviation.
  bool _routeShown(DeviationDisplay display) =>
      _plan.usable && display != DeviationDisplay.routeUnavailable;

  @override
  void initState() {
    super.initState();
    _planChanges.observe(_plan.fingerprint);
    final uid = _uid;
    if (uid != null) {
      _serverState = FirestoreTrackingStore().deviationState(uid);
      _orderSub = DeliveryService().riderDeliveries(uid).listen(_onDeliveries, onError: (Object error, StackTrace stack) {
        logSuppressedError('RouteMonitoringScreen', 'order feed', error, stack);
        if (mounted) setState(() => _feedError = true);
      });
    }
    _clock = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted) setState(() {});
    });
    riderTracking.addListener(_followNextStop);
  }

  /// This stop was finished and navigation carried on to the trip's next
  /// stop (see [nextTripStopAfter]): the screen moves on with it, so the rider
  /// never has to go back and tap Start.
  void _followNextStop() {
    final nav = riderTracking.navigation;
    if (!mounted || nav == null || nav.continuedFrom != d.id || nav.orderId == d.id) return;
    Delivery? next;
    for (final candidate in _deliveries ?? const <Delivery>[]) {
      if (candidate.id == nav.orderId) next = candidate;
    }
    if (next == null) return; // the feed has not delivered it yet; _onDeliveries retries
    final finishedName = _destinationName;
    setState(() {
      _delivery = next!;
      _gone = false;
      _planChanges = PlanChangeTracker()..observe(_plan.fingerprint);
      _planChange = PlanChange.none;
    });
    _snack('$finishedName done. Now on your way to $_destinationName.');
    WidgetsBinding.instance.addPostFrameCallback((_) => _fit());
  }

  void _onDeliveries(List<Delivery> deliveries) {
    if (!mounted) return;
    Delivery? fresh;
    for (final candidate in deliveries) {
      if (candidate.id == d.id) fresh = candidate;
    }
    setState(() {
      _feedError = false;
      _deliveries = deliveries;
      _gone = fresh == null;
      if (fresh != null) {
        _delivery = fresh;
        final change = _planChanges.observe(_plan.fingerprint);
        if (change != PlanChange.none) _planChange = change;
      }
    });
    if (_planChange != PlanChange.none) WidgetsBinding.instance.addPostFrameCallback((_) => _fit());
    _followNextStop();
  }

  @override
  void dispose() {
    riderTracking.removeListener(_followNextStop);
    _clock?.cancel();
    _orderSub?.cancel();
    _mapController.dispose();
    super.dispose();
  }

  bool get _navigatingThis => riderTracking.navigation?.orderId == d.id;
  bool get _navigatingOther => riderTracking.navigation != null && !_navigatingThis;

  NavigationEligibility get _eligibility => navigationEligibility(
        order: TrackedOrder(id: d.id, status: d.status, assignedRiderId: d.assignedRiderId),
        riderUid: _uid,
        routeAvailable: _plan.usable,
      );

  Future<void> _start() async {
    if (_busy) return;
    setState(() => _busy = true);
    // The uid at the moment of the tap (not when the screen opened).
    final error = await riderTracking.startNavigation(d.id, authUid: _uid);
    if (!mounted) return;
    setState(() => _busy = false);
    if (error != null) _snack(error);
  }

  Future<void> _stop() async {
    if (_busy) return;
    setState(() => _busy = true);
    await riderTracking.stopNavigation();
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _openGoogleMaps() async {
    final handoff = googleHandoffFor(d, _deliveries);
    final uri = handoff.uri;
    if (handoff.message != null) _snack(handoff.message!);
    if (uri == null) return;
    try {
      if (await canLaunchUrl(uri) && await launchUrl(uri, mode: LaunchMode.externalApplication)) return;
      _snack('Could not open Google Maps — no maps app is available. Keep following the plan on this map.');
    } catch (_) {
      _snack('Could not open Google Maps on this device. Keep following the plan on this map.');
    }
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  /// The rider's own latest fix, only while navigating this delivery.
  LatLng? get _riderPoint {
    final fix = riderTracking.lastFix;
    if (!_navigatingThis || fix == null) return null;
    return LatLng(fix.latitude, fix.longitude);
  }

  LatLng? get _destinationPoint => d.hasClinicCoords ? LatLng(d.clinicLat!, d.clinicLng!) : null;

  /// The trip's later unfinished stops, in the planned order.
  List<Delivery> get _laterStops {
    final all = _deliveries;
    if (all == null) return const [];
    final stops = remainingTripFrom(d, all).stops;
    return stops.length > 1 ? stops.sublist(1) : const [];
  }

  void _fit() {
    if (!_mapReady) return;
    // Extent-based, not count-based — see [resolveMapFit].
    final fit = resolveMapFit(<LatLng>[..._plan.points, ?_riderPoint, ?_destinationPoint]);
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

  String get _destinationName =>
      (d.destinationName ?? '').trim().isNotEmpty ? d.destinationName!.trim() : d.clinicName;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('VaxTrack route · ${d.orderNumber}')),
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
                _stopHeader(),
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

  // Where the rider is going, readable at a glance: this stop, its place in the
  // trip, the entrance notes, and what comes after it.
  Widget _stopHeader() {
    final next = nextStopFor(d, _deliveries ?? const []);
    final eta = (d.stopEtaText ?? '').trim();
    final notes = (d.destinationAccessNotes ?? '').trim();
    return Container(
      width: double.infinity,
      color: AppColors.surface,
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            [next.position ?? 'Destination', if (d.isOnTrip && eta.isNotEmpty) 'planned $eta'].join(' · '),
            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.textLight),
          ),
          const SizedBox(height: 2),
          Text(
            _destinationName,
            key: const Key('routeDestinationName'),
            style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: AppColors.textDark),
          ),
          if (d.clinicAddress.trim().isNotEmpty)
            Text(d.clinicAddress.trim(), style: const TextStyle(fontSize: 14, color: AppColors.textMedium)),
          if (notes.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text('Entrance: $notes', style: const TextStyle(fontSize: 13, color: AppColors.textMedium)),
            ),
          if (next.after != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                'Then: ${next.after!.clinicName}',
                style: const TextStyle(fontSize: 12, color: AppColors.textLight),
              ),
            ),
        ],
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
        return AppColors.info;
    }
  }

  Widget _map(DeviationDisplay display) {
    final rider = _riderPoint;
    final dest = _destinationPoint;
    final plan = _plan;
    final later = _laterStops;
    return Stack(
      children: [
        FlutterMap(
          mapController: _mapController,
          options: MapOptions(
            initialCenter: rider ?? dest ?? (_routeShown(display) ? plan.points.first : _fallbackCenter),
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
                polylines: [Polyline(points: plan.points, color: AppColors.primary, strokeWidth: 6)],
              ),
            MarkerLayer(
              markers: [
                for (var i = 0; i < later.length; i++)
                  if (later[i].hasClinicCoords)
                    Marker(
                      point: LatLng(later[i].clinicLat!, later[i].clinicLng!),
                      width: 22,
                      height: 22,
                      child: _numberedDot('${(later[i].stopSequence ?? i + 2)}'),
                    ),
                if (dest != null)
                  Marker(point: dest, width: 26, height: 26, child: _dot(const Color(0xFFB45309))),
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
        if (_routeShown(display))
          Positioned(
            top: 10,
            left: 10,
            child: _mapChip(plan.isTrip ? 'Line: VaxTrack plan (whole trip)' : 'Line: VaxTrack plan'),
          ),
        Positioned(
          bottom: 12,
          right: 12,
          child: FloatingActionButton.small(
            heroTag: 'route_monitor_recenter',
            tooltip: 'Show the whole route',
            backgroundColor: Colors.white,
            foregroundColor: AppColors.primary,
            onPressed: _fit,
            child: const Icon(Icons.center_focus_strong),
          ),
        ),
      ],
    );
  }

  Widget _mapChip(String text) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        decoration: BoxDecoration(
          color: Colors.white.withValues(alpha: 0.92),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: AppColors.border),
        ),
        child: Text(text, style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: AppColors.textDark)),
      );

  Widget _dot(Color color) => Container(
        decoration: BoxDecoration(
          color: color,
          shape: BoxShape.circle,
          border: Border.all(color: Colors.white, width: 3),
          boxShadow: const [BoxShadow(color: Colors.black38, blurRadius: 4)],
        ),
      );

  Widget _numberedDot(String label) => Container(
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: AppColors.textLight,
          shape: BoxShape.circle,
          border: Border.all(color: Colors.white, width: 2),
        ),
        child: Text(label, style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w700, color: Colors.white)),
      );

  Widget _bottomPanel(DeviationDisplay display, {required bool serverError, String? serverRouteReason}) {
    final plan = _plan;
    final eligibility = _eligibility;
    // Server and app chose the same baseline (see SavedRoutePlan); when the
    // server still refuses it, its reason is the one shown.
    final serverProblem = display == DeviationDisplay.routeUnavailable
        ? kRoutePlanProblemCodes.entries.where((e) => e.value == serverRouteReason).map((e) => e.key).firstOrNull
        : null;
    final routeText = !plan.usable
        ? '${plan.label} Your location is still shared, but your route is not checked.'
        : display == DeviationDisplay.routeUnavailable
            ? '${serverProblem == null ? 'The saved route cannot be used right now.' : kRoutePlanProblemMessages[serverProblem]!} '
                'Your route is not checked.'
            : plan.label;
    final advice = kOffRouteAdvice[display];
    return SafeArea(
      top: false,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.55),
        child: Container(
          width: double.infinity,
          color: AppColors.background,
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (_planChange != PlanChange.none) _planChangeBanner(),
                if (_gone)
                  _callout(
                    Icons.info_outline,
                    'This delivery is no longer on your list — it was finished, cancelled or reassigned.',
                    AppColors.info,
                  ),
                if (_feedError)
                  _note(Icons.sync_problem, 'Live updates paused. The plan shown may be out of date; it refreshes when the connection returns.'),
                // Permission / location-off states, with their recovery actions.
                TrackingStatusBanner(controller: riderTracking),
                _note(plan.usable && display != DeviationDisplay.routeUnavailable ? Icons.two_wheeler : Icons.alt_route, routeText,
                    key: const Key('routePlanStatus')),
                if (_navigatingThis) _statusRow(display),
                if (advice != null) _callout(Icons.warning_amber_rounded, advice, AppColors.warning),
                if (_navigatingThis) _gpsRow(),
                if (_navigatingThis && serverError)
                  _note(Icons.error_outline, 'Route status could not be loaded. Your location is still shared.'),
                if (_navigatingOther)
                  _note(Icons.info_outline, 'You are on the route for another delivery. Starting here replaces it.'),
                const SizedBox(height: 10),
                if (!eligibility.canStart && !_navigatingThis) _blockers(eligibility.blockers),
                if (eligibility.canStart || _navigatingThis) _controls(),
                const SizedBox(height: 10),
                SizedBox(
                  width: double.infinity,
                  child: OutlinedButton.icon(
                    key: const Key('routeScreenGoogleDirections'),
                    onPressed: (d.hasClinicCoords || d.clinicAddress.trim().isNotEmpty) ? _openGoogleMaps : null,
                    icon: const Icon(Icons.map_outlined),
                    label: const Text('Turn-by-turn in Google Maps'),
                    style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(46)),
                  ),
                ),
                const Padding(
                  padding: EdgeInsets.only(top: 4),
                  child: Text(
                    '$googleRouteNote VaxTrack keeps checking your position against the plan.',
                    style: TextStyle(fontSize: 11, color: AppColors.textLight),
                  ),
                ),
                SizedBox(
                  width: double.infinity,
                  child: TextButton.icon(
                    key: const Key('backToDeliveryDetails'),
                    onPressed: () => Navigator.of(context).maybePop(),
                    icon: const Icon(Icons.arrow_back),
                    label: const Text('Back to delivery details'),
                  ),
                ),
                const Text(
                  'Keeps running with a notification if you leave this screen or lock the phone, '
                  'until you tap Stop or your last stop is done — after each stop it moves on to the next '
                  'one by itself. VaxTrack reports you off route when you are '
                  'over $kDeviationOffRouteMeters m from the plan for ${kDeviationConfirmSeconds ~/ 60} '
                  'minutes. This screen does not give turn-by-turn directions. Map: free OpenStreetMap.',
                  style: TextStyle(fontSize: 11, color: AppColors.textLight),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _planChangeBanner() => Container(
        width: double.infinity,
        margin: const EdgeInsets.only(bottom: 6),
        padding: const EdgeInsets.fromLTRB(12, 4, 4, 4),
        decoration: BoxDecoration(color: AppColors.infoBg, borderRadius: BorderRadius.circular(10)),
        child: Row(
          children: [
            const Icon(Icons.update, size: 18, color: AppColors.info),
            const SizedBox(width: 8),
            Expanded(
              child: Text(kPlanChangeMessages[_planChange]!,
                  key: const Key('planChangeMessage'),
                  style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textDark)),
            ),
            IconButton(
              tooltip: 'Dismiss',
              icon: const Icon(Icons.close, size: 18),
              onPressed: () => setState(() => _planChange = PlanChange.none),
            ),
          ],
        ),
      );

  Widget _statusRow(DeviationDisplay display) {
    final rider = _riderPoint;
    final distance = (rider != null && _routeShown(display)) ? distanceToPolylineMeters(rider, _plan.points) : null;
    // Grey until the server has a verdict: not navigating yet, or no fix of
    // this session measured.
    final color = display == DeviationDisplay.notNavigating || display == DeviationDisplay.checking
        ? AppColors.textLight
        : _riderColor(display);
    final label = display == DeviationDisplay.notNavigating
        ? 'Started — waiting for route status'
        : kDeviationDisplayLabels[display]!;
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Row(
        children: [
          Container(width: 12, height: 12, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
          const SizedBox(width: 8),
          Expanded(child: Text(label, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700))),
          if (distance != null)
            Text('${distance.round()} m from plan', style: const TextStyle(fontSize: 12, color: AppColors.textLight)),
        ],
      ),
    );
  }

  Widget _gpsRow() {
    final gps = gpsStatusFor(fix: riderTracking.lastFix, now: DateTime.now(), sharing: riderTracking.isSharing);
    final icon = switch (gps.state) {
      GpsState.good => Icons.gps_fixed,
      GpsState.weak || GpsState.waiting => Icons.gps_not_fixed,
      GpsState.lost || GpsState.notSharing => Icons.gps_off,
    };
    return _note(icon, gps.message, key: const Key('gpsStatus'));
  }

  Widget _note(IconData icon, String text, {Key? key}) => Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 16, color: AppColors.textLight),
            const SizedBox(width: 8),
            Expanded(child: Text(text, key: key, style: const TextStyle(fontSize: 13, color: AppColors.textDark))),
          ],
        ),
      );

  Widget _callout(IconData icon, String text, Color color) => Container(
        width: double.infinity,
        margin: const EdgeInsets.only(top: 6),
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: color.withValues(alpha: 0.4)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 18, color: color),
            const SizedBox(width: 8),
            Expanded(child: Text(text, style: const TextStyle(fontSize: 13, color: AppColors.textDark))),
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
          const Text('Cannot start yet', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          ...blockers.map((b) => _note(Icons.info_outline, b)),
        ],
      ),
    );
  }

  // One clear primary action: Start while not on this route, Stop while on it.
  Widget _controls() {
    final on = _navigatingThis;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ElevatedButton.icon(
          key: Key(on ? 'stopVaxTrackRoute' : 'startVaxTrackRoute'),
          onPressed: _busy ? null : (on ? _stop : _start),
          icon: Icon(on ? Icons.stop : Icons.play_arrow),
          label: Text(on ? 'Stop' : 'Start VaxTrack route', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
          style: ElevatedButton.styleFrom(
            backgroundColor: on ? AppColors.urgent : AppColors.primary,
            foregroundColor: Colors.white,
            minimumSize: const Size.fromHeight(54),
          ),
        ),
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text(
            on
                ? 'Sharing your location with dispatch. Stop ends sharing for this delivery.'
                : 'Shares your location with dispatch until you tap Stop or the delivery ends.',
            style: const TextStyle(fontSize: 11, color: AppColors.textLight),
          ),
        ),
      ],
    );
  }
}
