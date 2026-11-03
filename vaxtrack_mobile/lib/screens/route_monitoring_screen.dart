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
import '../tracking/location_write_policy.dart';
import '../tracking/tracking_lifecycle.dart';
import '../utils/deviation_utils.dart';
import '../utils/google_maps_url.dart';
import '../utils/map_fit.dart';
import '../utils/route_progress.dart';
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

  // Decoded once per order update (the live feed hands a new Delivery), not on
  // every rebuild: the screen rebuilds on every location fix.
  Delivery? _planOf;
  SavedRoutePlan? _planCache;
  SavedRoutePlan get _plan {
    if (!identical(_planOf, d)) {
      _planOf = d;
      _planCache = SavedRoutePlan.of(d);
    }
    return _planCache!;
  }

  /// The plan segment the rider was last placed on (route_progress.dart).
  int _splitHint = -1;

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
              padding: const EdgeInsets.fromLTRB(40, 140, 60, 50),
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
      appBar: AppBar(
        title: Text('VaxTrack route · ${d.orderNumber}'),
        actions: [
          IconButton(
            key: const Key('routeScreenHelp'),
            tooltip: 'How route monitoring works',
            icon: const Icon(Icons.info_outline),
            onPressed: _showHelp,
          ),
        ],
      ),
      body: LayoutBuilder(
        builder: (context, constraints) {
          // Landscape phones and tablets: the map beside the panel, not above.
          final wide = constraints.maxWidth >= 700;
          return AnimatedBuilder(
            animation: riderTracking,
            builder: (context, _) => StreamBuilder<Map<String, dynamic>?>(
              stream: _serverState,
              builder: (context, snap) {
                final display = _navigatingThis
                    ? deviationDisplayFor(snap.data, sessionId: riderTracking.navigation?.sessionId)
                    : DeviationDisplay.notNavigating;
                final map = RepaintBoundary(child: _map(display));
                final panel = _bottomPanel(
                  display,
                  serverError: snap.hasError,
                  serverRouteReason: snap.data?['routeUnavailableReason'] as String?,
                );
                if (wide) {
                  return Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Expanded(child: map),
                      SizedBox(width: 380, child: ColoredBox(color: AppColors.background, child: panel)),
                    ],
                  );
                }
                return Column(children: [Expanded(child: map), panel]);
              },
            ),
          );
        },
      ),
    );
  }

  // Where the rider is going, readable at a glance, floating on the map: this
  // stop, its place in the trip, how far it is, the entrance notes, and what
  // comes after it.
  Widget _nextStopCard() {
    final next = nextStopFor(d, _deliveries ?? const []);
    final eta = (d.stopEtaText ?? '').trim();
    final notes = (d.destinationAccessNotes ?? '').trim();
    final rider = _riderPoint;
    final dest = _destinationPoint;
    final away = rider != null && dest != null ? '${shortDistance(straightLineMeters(rider, dest))} away' : null;
    final top = [next.position ?? 'Destination', if (d.isOnTrip && eta.isNotEmpty) 'planned $eta'].join(' · ');
    final sub = [?away, if (d.clinicAddress.trim().isNotEmpty) d.clinicAddress.trim()].join(' · ');
    return Material(
      key: ValueKey('next-stop-${d.id}'),
      color: AppColors.surface,
      elevation: 3,
      shadowColor: Colors.black26,
      borderRadius: BorderRadius.circular(14),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 14, 10),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _pin(d.stopSequence?.toString(), current: true, size: 30),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(top, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.textLight)),
                  Text(
                    _destinationName,
                    key: const Key('routeDestinationName'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: AppColors.textDark),
                  ),
                  if (sub.isNotEmpty)
                    Text(sub,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 13, color: AppColors.textMedium)),
                  if (notes.isNotEmpty)
                    Text('Entrance: $notes',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12.5, color: AppColors.textMedium)),
                  if (next.after != null)
                    Text('Then: ${next.after!.clinicName}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12, color: AppColors.textLight)),
                ],
              ),
            ),
          ],
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
        return AppColors.info;
    }
  }

  static const Color _ridden = Color(0xFF9CA3AF);
  static const Color _arrival = Color(0xFFB45309);

  Widget _map(DeviationDisplay display) {
    final rider = _riderPoint;
    final dest = _destinationPoint;
    final plan = _plan;
    final later = _laterStops;
    final shown = _routeShown(display);
    final split = shown ? splitRouteAt(plan.points, rider, hintSegment: _splitHint) : null;
    if (split != null && split.segment >= 0) _splitHint = split.segment;
    final fix = riderTracking.lastFix;
    final riderColor = _riderColor(display);
    return Stack(
      children: [
        FlutterMap(
          mapController: _mapController,
          options: MapOptions(
            initialCenter: rider ?? dest ?? (shown ? plan.points.first : _fallbackCenter),
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
              keepBuffer: 3,
            ),
            // The arrival area the server checks completion against.
            if (dest != null)
              CircleLayer(
                circles: [
                  CircleMarker(
                    point: dest,
                    radius: (d.arrivalRadiusM ?? 300).toDouble(),
                    useRadiusInMeter: true,
                    color: _arrival.withValues(alpha: 0.10),
                    borderColor: _arrival.withValues(alpha: 0.55),
                    borderStrokeWidth: 1.5,
                  ),
                ],
              ),
            // The plan: ridden part grey, the rest green, both on a white
            // casing so the line stands out on busy streets.
            if (split != null)
              PolylineLayer(
                polylines: [
                  if (split.ridden.length > 1)
                    Polyline(points: split.ridden, color: _ridden, strokeWidth: 5, borderColor: Colors.white, borderStrokeWidth: 2),
                  Polyline(points: split.ahead, color: AppColors.primary, strokeWidth: 6, borderColor: Colors.white, borderStrokeWidth: 3),
                ],
              ),
            MarkerLayer(
              markers: [
                for (var i = later.length - 1; i >= 0; i--)
                  if (later[i].hasClinicCoords)
                    Marker(
                      point: LatLng(later[i].clinicLat!, later[i].clinicLng!),
                      width: 30,
                      height: 38,
                      alignment: Alignment.topCenter,
                      child: _pin('${later[i].stopSequence ?? i + 2}', current: false, size: 30),
                    ),
                if (dest != null)
                  Marker(
                    point: dest,
                    width: 180,
                    height: 76,
                    alignment: Alignment.topCenter,
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        _mapChip(_destinationName),
                        const SizedBox(height: 2),
                        _pin(d.stopSequence?.toString(), current: true, size: 40),
                      ],
                    ),
                  ),
              ],
            ),
            // The rider glides between fixes instead of jumping.
            if (rider != null)
              TweenAnimationBuilder<LatLng>(
                tween: _LatLngTween(end: rider),
                duration: const Duration(milliseconds: 900),
                curve: Curves.easeOut,
                builder: (context, at, _) => Stack(
                  children: [
                    if (fix != null)
                      CircleLayer(
                        circles: [
                          CircleMarker(
                            point: at,
                            radius: fix.accuracyMeters.clamp(5, 200).toDouble(),
                            useRadiusInMeter: true,
                            color: riderColor.withValues(alpha: 0.12),
                            borderColor: riderColor.withValues(alpha: 0.35),
                            borderStrokeWidth: 1,
                          ),
                        ],
                      ),
                    MarkerLayer(
                      markers: [Marker(point: at, width: 40, height: 40, child: _riderMarker(riderColor, fix))],
                    ),
                  ],
                ),
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
          top: 10,
          left: 10,
          right: 10,
          child: Align(
            alignment: Alignment.topCenter,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 520),
              child: AnimatedSwitcher(
                duration: const Duration(milliseconds: 300),
                switchInCurve: Curves.easeOut,
                transitionBuilder: (child, animation) => FadeTransition(
                  opacity: animation,
                  child: SlideTransition(
                    position: Tween(begin: const Offset(0, -0.15), end: Offset.zero).animate(animation),
                    child: child,
                  ),
                ),
                child: _nextStopCard(),
              ),
            ),
          ),
        ),
        if (shown)
          Positioned(
            bottom: 12,
            left: 10,
            child: _mapChip(plan.isTrip ? 'Line: VaxTrack plan (whole trip)' : 'Line: VaxTrack plan'),
          ),
        Positioned(
          bottom: 60,
          right: 12,
          child: FloatingActionButton.small(
            key: const Key('routeScreenGoogleDirections'),
            heroTag: 'route_monitor_google',
            tooltip: 'Turn-by-turn in Google Maps',
            backgroundColor: Colors.white,
            foregroundColor: AppColors.primary,
            onPressed: (d.hasClinicCoords || d.clinicAddress.trim().isNotEmpty) ? _confirmGoogleMaps : null,
            child: const Icon(Icons.map_outlined),
          ),
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
          color: Colors.white.withValues(alpha: 0.94),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: AppColors.border),
        ),
        child: Text(text,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: AppColors.textDark)),
      );

  /// A stop pin: a teardrop with its stop number. The stop being ridden to is
  /// amber and larger; later stops are small and green.
  Widget _pin(String? number, {required bool current, required double size}) {
    final color = current ? _arrival : AppColors.primaryDark;
    return SizedBox(
      width: size,
      height: size * 1.25,
      child: Stack(
        alignment: Alignment.topCenter,
        children: [
          Icon(Icons.location_on, size: size * 1.25, color: color, shadows: const [Shadow(color: Colors.black26, blurRadius: 4)]),
          Padding(
            padding: EdgeInsets.only(top: size * 0.22),
            child: Container(
              width: size * 0.5,
              height: size * 0.5,
              alignment: Alignment.center,
              decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle),
              child: number == null
                  ? Icon(Icons.flag, size: size * 0.32, color: color)
                  : Text(number, style: TextStyle(fontSize: size * 0.3, fontWeight: FontWeight.w800, color: color, height: 1)),
            ),
          ),
        ],
      ),
    );
  }

  /// The rider: a dot, or an arrow pointing the way they are moving once they
  /// are actually moving (a standing phone's compass heading is noise). Blue
  /// on route, orange while checking off route, red once off route.
  Widget _riderMarker(Color color, LocationFix? fix) {
    final heading = fix?.sanitizedHeading;
    final moving = heading != null && (fix?.sanitizedSpeed ?? 0) >= 1.5;
    return Center(
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 250),
        width: moving ? 32 : 22,
        height: moving ? 32 : 22,
        decoration: BoxDecoration(
          color: color,
          shape: BoxShape.circle,
          border: Border.all(color: Colors.white, width: 3),
          boxShadow: const [BoxShadow(color: Colors.black38, blurRadius: 5)],
        ),
        child: moving
            ? AnimatedRotation(
                turns: heading / 360,
                duration: const Duration(milliseconds: 400),
                child: const Icon(Icons.navigation, size: 16, color: Colors.white),
              )
            : null,
      ),
    );
  }

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
            child: AnimatedSize(
              duration: const Duration(milliseconds: 220),
              curve: Curves.easeOut,
              alignment: Alignment.topCenter,
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
                // Only problems: location off, permission, no position yet.
                TrackingStatusBanner(controller: riderTracking, problemsOnly: true),
                // The plan line is labelled on the map; here only when it cannot be used.
                if (!plan.usable || display == DeviationDisplay.routeUnavailable)
                  _note(Icons.alt_route, routeText, key: const Key('routePlanStatus')),
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
              ],
            ),
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
    if (gps.state == GpsState.good) return const SizedBox.shrink(key: Key('gpsStatus'));
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
      ],
    );
  }

  /// The Google hand-off, with the reminder that Google picks its own roads.
  Future<void> _confirmGoogleMaps() async {
    final go = await showModalBottomSheet<bool>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('Turn-by-turn in Google Maps', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
              const SizedBox(height: 8),
              const Text('$googleRouteNote VaxTrack keeps checking your position against the plan.',
                  style: TextStyle(fontSize: 13, color: AppColors.textMedium)),
              const SizedBox(height: 16),
              ElevatedButton.icon(
                onPressed: () => Navigator.of(sheetContext).pop(true),
                icon: const Icon(Icons.map_outlined),
                label: const Text('Open Google Maps'),
              ),
            ],
          ),
        ),
      ),
    );
    if (go == true) await _openGoogleMaps();
  }

  void _showHelp() {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (_) => SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('How route monitoring works', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
              const SizedBox(height: 10),
              Text(_plan.label, style: const TextStyle(fontSize: 13, color: AppColors.textMedium)),
              const SizedBox(height: 10),
              const Text(
                'Start shares your location with dispatch. It keeps running with a notification if you leave this '
                'screen or lock the phone, until you tap Stop or your last stop is done — after each stop it moves '
                'on to the next one by itself. Keep background activity allowed for VaxTrack so sharing is reliable.',
                style: TextStyle(fontSize: 13, color: AppColors.textMedium),
              ),
              const SizedBox(height: 10),
              const Text(
                'VaxTrack reports you off route when you are over $kDeviationOffRouteMeters m from the plan for '
                '${kDeviationConfirmSeconds ~/ 60} minutes. This screen does not give turn-by-turn directions. '
                'Map: free OpenStreetMap.',
                style: TextStyle(fontSize: 13, color: AppColors.textMedium),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Interpolates a map position, for the rider marker's glide between fixes.
class _LatLngTween extends Tween<LatLng> {
  _LatLngTween({required LatLng end}) : super(begin: end, end: end);

  @override
  LatLng lerp(double t) => LatLng(
        begin!.latitude + (end!.latitude - begin!.latitude) * t,
        begin!.longitude + (end!.longitude - begin!.longitude) * t,
      );
}
