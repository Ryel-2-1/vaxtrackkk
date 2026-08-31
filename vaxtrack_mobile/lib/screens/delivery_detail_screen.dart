import 'dart:async';
import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/delivery.dart';
import '../services/delivery_service.dart';
import '../services/location_service.dart';
import '../services/route_deviation_alert_service.dart';
import '../theme/app_theme.dart';
import '../utils/nav_availability.dart';
import '../utils/route_utils.dart';
import '../widgets/delivery_map.dart';
import 'google_navigation_screen.dart';
import 'route_monitoring_screen.dart';
import 'package:intl/intl.dart';

class DeliveryDetailScreen extends StatefulWidget {
  final Delivery delivery;

  const DeliveryDetailScreen({super.key, required this.delivery});

  @override
  State<DeliveryDetailScreen> createState() => _DeliveryDetailScreenState();
}

class _DeliveryDetailScreenState extends State<DeliveryDetailScreen> {
  final _deliveryService = DeliveryService();
  final _locationService = LocationService();
  bool _updatingStatus = false;
  bool _launchingNav = false;
  String? _delayReason;
  // Fires the "saved, will sync" feedback if a write is still pending after a
  // few seconds. UI-only — it never clears the pending guard (see _updateStatus).
  Timer? _statusFeedbackTimer;

  Delivery get d => widget.delivery;

  @override
  void initState() {
    super.initState();
    // Foreground-only live tracking runs while an in_transit delivery is open.
    if (d.isInTransit) {
      _startTracking();
    }
  }

  @override
  void dispose() {
    // Leaving the screen (or the app being torn down) stops tracking — this is
    // the documented foreground-only MVP; background tracking is out of scope.
    _statusFeedbackTimer?.cancel();
    _locationService.stopTracking();
    super.dispose();
  }

  Future<void> _startTracking() async {
    final riderId = FirebaseAuth.instance.currentUser?.uid;
    if (riderId == null) return;
    try {
      final started = await _locationService.startTracking(riderId);
      if (!started && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Live location unavailable — enable location to share your position.',
            ),
          ),
        );
      }
    } catch (_) {
      // Tracking is best-effort; never disrupt the delivery flow.
    }
  }

  // Maps a target status to the matching (audit-stamped) service write. The
  // order lifecycle and authorization are unchanged — this only routes to the
  // existing methods.
  Future<void> _statusWrite(String newStatus) {
    switch (newStatus) {
      case 'loading':
        return _deliveryService.startLoading(d.id);
      case 'in_transit':
        return _deliveryService.startTransit(d.id);
      case 'delivered':
        return _deliveryService.markDelivered(d.id);
      case 'delayed':
        return _deliveryService.reportDelay(d.id, _delayReason ?? 'Unknown');
      default:
        return _deliveryService.updateStatus(d.id, newStatus);
    }
  }

  // Best-effort one-shot location stamp for a transition. Never blocks or fails
  // the status flow (continuous tracking is handled separately).
  Future<void> _stampLocation(String orderId) async {
    try {
      final pos = await _locationService.getCurrentPosition();
      if (pos != null) {
        await _locationService.updateOrderLocation(orderId, pos);
      }
    } catch (_) {
      // ignore — location is auxiliary to the status change
    }
  }

  Future<void> _updateStatus(String newStatus) async {
    // Duplicate-submission guard. The action buttons are disabled while this is
    // true, AND it is cleared ONLY when the Firestore write actually settles
    // (in the finally below) — never by the feedback timeout. So while a write
    // is still pending offline, the same action cannot be re-submitted.
    if (_updatingStatus) return;
    setState(() => _updatingStatus = true);

    // Auxiliary best-effort location stamp — fire-and-forget so it can never
    // hang or fail the status flow.
    unawaited(_stampLocation(d.id));

    // Feedback-only timeout. If the write has not been server-confirmed within
    // 6 s (e.g. offline), tell the rider it is saved and will sync. This is UI
    // feedback ONLY: it does NOT clear the pending guard, does NOT pop the
    // screen, and does NOT treat the write as finished. Firestore stays the
    // single source of truth; the write remains genuinely in flight.
    var settled = false;
    _statusFeedbackTimer?.cancel();
    _statusFeedbackTimer = Timer(const Duration(seconds: 6), () {
      if (settled || !mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Saved. Will sync when you are back online.'),
          backgroundColor: AppColors.warning,
        ),
      );
    });

    try {
      // Completes ONLY on server acknowledgement. While offline it stays pending
      // (Firestore has already applied it to the local cache, so the dashboard
      // stream reflects it immediately with a "Pending sync" indicator). The
      // screen stays open and the back button still works, but the action stays
      // disabled until this resolves.
      await _statusWrite(newStatus);

      // Server-confirmed. If the rider navigated away while it was pending, skip
      // the UI side-effects (and never start a GPS stream this screen can no
      // longer stop) — the write itself already persisted.
      if (!mounted) return;

      // Tracking lifecycle only on a CONFIRMED transition (unchanged intent):
      // - in_transit -> begin continuous tracking.
      // - delivered/cancelled -> stop before leaving the screen.
      if (newStatus == 'in_transit') {
        await _startTracking();
      } else if (newStatus == 'delivered' || newStatus == 'cancelled') {
        await _locationService.stopTracking();
      }
      if (!mounted) return;

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Status updated to $newStatus'),
          backgroundColor: AppColors.primary,
        ),
      );
      Navigator.pop(context);
    } catch (e) {
      // A genuine failure (e.g. permission denied, or a queued write rejected on
      // reconnect). Caught here so it is never an unhandled Future error; the
      // screen stays open so the rider can retry.
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Could not save "$newStatus": $e'),
            backgroundColor: AppColors.urgent,
          ),
        );
      }
    } finally {
      // The guard clears ONLY here — when the write has succeeded or failed —
      // never merely because the feedback timeout elapsed.
      settled = true;
      _statusFeedbackTimer?.cancel();
      if (mounted) setState(() => _updatingStatus = false);
    }
  }

  void _showDelayDialog() {
    showDialog(
      context: context,
      builder: (ctx) {
        final controller = TextEditingController();
        return AlertDialog(
          title: const Text('Report Delay'),
          content: TextField(
            controller: controller,
            decoration: const InputDecoration(
              labelText: 'Reason for delay',
              hintText: 'e.g., Clinic closed, traffic, address not found',
            ),
            maxLines: 3,
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('Cancel'),
            ),
            ElevatedButton(
              onPressed: () {
                _delayReason = controller.text;
                Navigator.pop(ctx);
                _updateStatus('delayed');
              },
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.urgent,
              ),
              child: const Text('Submit'),
            ),
          ],
        );
      },
    );
  }

  // Hands off to the installed Google Maps app for real turn-by-turn
  // navigation (free, no API key). Prefers the exact clinic coordinates when
  // the dispatcher set them; otherwise falls back to an address search.
  Future<void> _openNavigation() async {
    final Uri uri;
    if (d.hasClinicCoords) {
      uri = Uri.parse(
        'https://www.google.com/maps/dir/?api=1'
        '&destination=${d.clinicLat},${d.clinicLng}&travelmode=driving',
      );
    } else if (d.clinicAddress.isNotEmpty) {
      uri = Uri.parse(
        'https://www.google.com/maps/search/?api=1'
        '&query=${Uri.encodeComponent(d.clinicAddress)}',
      );
    } else {
      _showNavSnack('No destination available to open in Google Maps.');
      return;
    }
    // Surface the outcome honestly instead of failing silently: canLaunchUrl
    // false (no maps app) or a launch that throws both tell the rider.
    try {
      if (await canLaunchUrl(uri) &&
          await launchUrl(uri, mode: LaunchMode.externalApplication)) {
        return;
      }
      _showNavSnack('Could not open Google Maps — no maps app is available.');
    } catch (_) {
      _showNavSnack('Could not open Google Maps on this device.');
    }
  }

  void _showNavSnack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  // After returning from a full-screen navigation view, make sure foreground
  // location reporting is still running for an in_transit delivery. This
  // deliberately RESPECTS the documented "in_transit only" tracking decision —
  // it never starts tracking for pre-transit states, and order-level writes stay
  // gated to in_transit inside LocationService. It only re-asserts continuity so
  // navigation can never silently leave an in_transit delivery unreported; it
  // adds no second tracker.
  Future<void> _ensureTrackingForInTransit() async {
    if (!mounted) return;
    if (d.isInTransit && !_locationService.isTracking) {
      await _startTracking();
    }
  }

  // Open the in-app Google Navigation screen for this delivery's clinic.
  // Guarded so a double-tap can't push two screens / start two sessions. Only
  // reachable when the delivery is active AND has valid clinic coordinates
  // (button gating below); delivered/cancelled orders are excluded.
  Future<void> _startGoogleNavigation() async {
    if (_launchingNav || !d.hasClinicCoords || !d.isActive) return;
    setState(() => _launchingNav = true);
    try {
      // Build the confirmed route-deviation context (order doc id + authed
      // rider uid + display fields). If the uid or doc id is missing we pass
      // null, keeping the nav screen local-only rather than inventing an id.
      final uid = FirebaseAuth.instance.currentUser?.uid;
      final RouteDeviationContext? alertContext =
          (uid != null && uid.isNotEmpty && d.id.isNotEmpty)
          ? RouteDeviationContext(
              orderId: d.id,
              riderUid: uid,
              orderNumber: d.orderNumber,
              clinicName: d.clinicName,
              riderName: d.assignedRiderName,
            )
          : null;
      await Navigator.push(
        context,
        MaterialPageRoute(
          builder: (_) => GoogleNavigationScreen(
            clinicLat: d.clinicLat!,
            clinicLng: d.clinicLng!,
            clinicName: d.clinicName,
            clinicAddress: d.clinicAddress,
            alertContext: alertContext,
          ),
        ),
      );
      // Back on the delivery screen — keep in_transit reporting alive.
      await _ensureTrackingForInTransit();
    } finally {
      if (mounted) setState(() => _launchingNav = false);
    }
  }

  // Open the FREE in-app route-monitoring screen (OpenStreetMap + Geolocator).
  // Requires the delivery to be active with clinic coordinates; the screen
  // itself enforces the full start eligibility (auth, assignment, saved route)
  // and Firestore rules remain the final assignment authority.
  Future<void> _startRouteMonitoring() async {
    if (!d.isActive || !d.hasClinicCoords) return;
    await Navigator.push(
      context,
      MaterialPageRoute(builder: (_) => RouteMonitoringScreen(delivery: d)),
    );
    // Back on the delivery screen — keep in_transit reporting alive.
    await _ensureTrackingForInTransit();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(d.orderNumber)),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _infoCard(),
          const SizedBox(height: 12),
          _routeCard(),
          const SizedBox(height: 12),
          _statusCard(),
          if (!d.isDelivered &&
              d.status != 'delayed' &&
              d.status != 'cancelled') ...[
            const SizedBox(height: 16),
            _actionButtons(),
          ],
        ],
      ),
    );
  }

  Widget _infoCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _cardHeader('Delivery Details'),
            const SizedBox(height: 12),
            _infoRow(Icons.business, 'Clinic', d.clinicName),
            _infoRow(Icons.location_on, 'Address', d.clinicAddress),
            _infoRow(Icons.vaccines, 'Vaccine', d.vaccineName),
            if (d.vaccineType != null && d.vaccineType!.isNotEmpty)
              _infoRow(Icons.category, 'Type', d.vaccineType!),
            _infoRow(Icons.inventory_2, 'Quantity', '${d.quantity} ${d.unit}'),
            if (d.itemSummaries.length > 1)
              _infoRow(Icons.list_alt, 'Items', d.itemSummaries.join('\n')),
            _infoRow(Icons.flag, 'Priority', d.priority),
            if (d.region != null) _infoRow(Icons.map, 'Region', d.region!),
            if (d.deliveryInstructions != null)
              _infoRow(Icons.notes, 'Instructions', d.deliveryInstructions!),
          ],
        ),
      ),
    );
  }

  Widget _routeCard() {
    // Show the live Google Map when we have anything to plot: clinic
    // coordinates and/or a rider location. Otherwise fall back to the text
    // route summary so coord-less orders still work.
    final hasRiderLoc = d.lastLocation != null;
    final showMap = d.hasClinicCoords || hasRiderLoc;
    final nav = NavigationAvailability.of(d);

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _cardHeader('Route & Navigation'),
            const SizedBox(height: 12),
            if (showMap) ...[
              DeliveryMap(
                initialRider: hasRiderLoc
                    ? LatLng(
                        d.lastLocation!.latitude,
                        d.lastLocation!.longitude,
                      )
                    : null,
                clinic: d.hasClinicCoords
                    ? LatLng(d.clinicLat!, d.clinicLng!)
                    : null,
                routePolyline: d.routePolyline,
              ),
              const SizedBox(height: 12),
              if (d.hasRoute) ...[_etaCard(), const SizedBox(height: 12)],
              _destinationRow(),
              if (!d.hasRoute)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(
                    d.hasClinicCoords
                        ? 'Route not generated yet — dispatch can add it. You can still open Google Maps.'
                        : 'Destination pin not set — showing your location only.',
                    style: const TextStyle(
                      fontSize: 11,
                      color: AppColors.textLight,
                    ),
                  ),
                ),
              const SizedBox(height: 12),
            ] else ...[
              _textRouteFallback(),
              const SizedBox(height: 12),
            ],
            // Navigation actions are shown ONLY while the delivery is
            // in_transit. Assigned/loading/delayed get a lifecycle prompt;
            // delivered/cancelled show nothing here (the route summary above
            // stays as read-only history).
            if (nav.inTransit) ...[
              // PRIMARY action: one clear "Start navigation" (in-app Google
              // Navigation SDK). Needs a destination pin; if the SDK is not
              // configured/available the nav screen itself falls back to
              // Google Maps with a clear message.
              SizedBox(
                width: double.infinity,
                child: ElevatedButton.icon(
                  onPressed: (nav.canStartEmbeddedNav && !_launchingNav)
                      ? _startGoogleNavigation
                      : null,
                  icon: const Icon(Icons.assistant_navigation),
                  label: const Text('Start navigation'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.primary,
                    foregroundColor: Colors.white,
                  ),
                ),
              ),
              if (!d.hasClinicCoords)
                const Padding(
                  padding: EdgeInsets.only(top: 6),
                  child: Text(
                    'In-app navigation needs a destination pin from dispatch. '
                    'Use Open in Google Maps below.',
                    style: TextStyle(fontSize: 11, color: AppColors.textLight),
                  ),
                ),
              const SizedBox(height: 8),
              // FALLBACK: hand off to the external Google Maps app. Secondary
              // (outlined) so the primary in-app action stays dominant.
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: nav.canOpenExternalMaps ? _openNavigation : null,
                  icon: const Icon(Icons.map_outlined),
                  label: const Text('Open in Google Maps'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: AppColors.primary,
                    side: const BorderSide(color: AppColors.primary),
                  ),
                ),
              ),
              if (nav.usesAddressSearch)
                const Padding(
                  padding: EdgeInsets.only(top: 6),
                  child: Text(
                    'Using address search — exact destination pin not set by dispatch.',
                    style: TextStyle(fontSize: 11, color: AppColors.textLight),
                  ),
                ),
              const SizedBox(height: 16),
              const Divider(height: 1),
              const SizedBox(height: 12),
              // SEPARATE, clearly-labelled VaxTrack compliance feature — NOT a
              // turn-by-turn navigator. Free flutter_map + OpenStreetMap driving
              // the existing RouteComplianceMonitor / RouteDeviationAlertService
              // against the Dispatcher-assigned route. The screen re-checks
              // assignment + a saved route and explains anything still missing.
              Row(
                children: [
                  const Icon(
                    Icons.verified_user_outlined,
                    size: 16,
                    color: AppColors.info,
                  ),
                  const SizedBox(width: 6),
                  const Text(
                    'VaxTrack compliance',
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      color: AppColors.textDark,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton.icon(
                  onPressed: nav.canMonitorRoute ? _startRouteMonitoring : null,
                  icon: const Icon(Icons.my_location),
                  label: const Text('Monitor assigned route'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.info,
                    foregroundColor: Colors.white,
                  ),
                ),
              ),
              const Padding(
                padding: EdgeInsets.only(top: 6),
                child: Text(
                  'Checks your position against the Dispatcher-assigned route '
                  'and flags deviations. Not turn-by-turn navigation.',
                  style: TextStyle(fontSize: 11, color: AppColors.textLight),
                ),
              ),
            ] else if (nav.statusPrompt != null) ...[
              _statusPromptBox(nav.statusPrompt!),
            ],
          ],
        ),
      ),
    );
  }

  // Shown in place of the navigation actions when the delivery could be
  // navigated but is not in_transit yet (assigned/loading/delayed). It points
  // the rider at the lifecycle action to take first. Terminal statuses
  // (delivered/cancelled) show nothing here.
  Widget _statusPromptBox(String message) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.background,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.info_outline, size: 16, color: AppColors.textLight),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              message,
              style: const TextStyle(fontSize: 12, color: AppColors.textDark),
            ),
          ),
        ],
      ),
    );
  }

  Widget _etaCard() {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 8),
      decoration: BoxDecoration(
        color: AppColors.background,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: [
          _etaMetric(
            Icons.straighten,
            'Distance',
            formatDistance(d.routeDistanceMeters),
          ),
          _etaDivider(),
          _etaMetric(
            Icons.schedule,
            'Duration',
            formatDuration(d.routeDurationSeconds),
          ),
          _etaDivider(),
          _etaMetric(
            Icons.access_time,
            'ETA',
            formatEta(
              d.routeGeneratedAt,
              d.routeDurationSeconds,
              d.routeEtaText,
            ),
          ),
        ],
      ),
    );
  }

  Widget _etaMetric(IconData icon, String label, String value) {
    return Expanded(
      child: Column(
        children: [
          Icon(icon, size: 16, color: AppColors.primary),
          const SizedBox(height: 4),
          Text(
            label,
            style: const TextStyle(fontSize: 11, color: AppColors.textLight),
          ),
          const SizedBox(height: 2),
          Text(
            value,
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w700,
              color: AppColors.textDark,
            ),
          ),
        ],
      ),
    );
  }

  Widget _etaDivider() =>
      Container(width: 1, height: 34, color: AppColors.border);

  Widget _destinationRow() {
    return Row(
      children: [
        const Icon(Icons.place, size: 16, color: AppColors.primary),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            d.clinicAddress.isNotEmpty ? d.clinicAddress : d.clinicName,
            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
          ),
        ),
      ],
    );
  }

  Widget _textRouteFallback() {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.background,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Text(
                'Main Hub',
                style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
              ),
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 8),
                child: Icon(
                  Icons.arrow_forward,
                  color: AppColors.primary,
                  size: 16,
                ),
              ),
              Expanded(
                child: Text(
                  d.clinicAddress.isNotEmpty ? d.clinicAddress : d.clinicName,
                  style: const TextStyle(
                    fontWeight: FontWeight.w600,
                    fontSize: 13,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'Next Stop: ${d.clinicName}',
            style: const TextStyle(fontSize: 12, color: AppColors.textLight),
          ),
          const SizedBox(height: 6),
          const Text(
            'No map coordinates yet — add clinic coordinates in the web portal.',
            style: TextStyle(fontSize: 11, color: AppColors.textLight),
          ),
        ],
      ),
    );
  }

  Widget _statusCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _cardHeader('Status Timeline'),
            const SizedBox(height: 12),
            _timelineEntry('Order Created', d.createdAt, true),
            _timelineEntry('Assigned', d.assignedAt, d.assignedAt != null),
            _timelineEntry(
              'Loading',
              d.startedAt,
              d.isLoading || d.isInTransit || d.isDelivered,
            ),
            _timelineEntry(
              'In Transit',
              d.startedAt,
              d.isInTransit || d.isDelivered,
            ),
            _timelineEntry('Delivered', d.deliveredAt, d.isDelivered),
          ],
        ),
      ),
    );
  }

  Widget _timelineEntry(String label, DateTime? time, bool done) {
    final fmt = DateFormat('MMM d, h:mm a');
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Container(
            width: 24,
            height: 24,
            decoration: BoxDecoration(
              color: done ? AppColors.primaryLight : AppColors.background,
              shape: BoxShape.circle,
              border: Border.all(
                color: done ? AppColors.primary : AppColors.border,
              ),
            ),
            child: done
                ? const Icon(Icons.check, size: 14, color: AppColors.primary)
                : null,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              label,
              style: TextStyle(
                fontSize: 13,
                fontWeight: done ? FontWeight.w600 : FontWeight.normal,
                color: done ? AppColors.textDark : AppColors.textMuted,
              ),
            ),
          ),
          if (time != null)
            Text(
              fmt.format(time),
              style: const TextStyle(fontSize: 11, color: AppColors.textLight),
            ),
        ],
      ),
    );
  }

  Widget _actionButtons() {
    return Column(
      children: [
        if (d.canStartLoading)
          _actionButton(
            'Start Loading',
            Icons.inventory,
            AppColors.info,
            () => _updateStatus('loading'),
          ),
        if (d.canStartTransit)
          _actionButton(
            'Start Transit',
            Icons.local_shipping,
            AppColors.primary,
            () => _updateStatus('in_transit'),
          ),
        if (d.canDeliver)
          _actionButton(
            'Mark as Delivered',
            Icons.check_circle,
            AppColors.primary,
            () => _updateStatus('delivered'),
          ),
        const SizedBox(height: 8),
        if (!d.isDelivered)
          _actionButton(
            'Report Delay',
            Icons.schedule,
            AppColors.urgent,
            _showDelayDialog,
          ),
      ],
    );
  }

  Widget _actionButton(
    String label,
    IconData icon,
    Color color,
    VoidCallback onTap,
  ) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: SizedBox(
        width: double.infinity,
        child: ElevatedButton.icon(
          onPressed: _updatingStatus ? null : onTap,
          icon: Icon(icon),
          label: Text(label),
          style: ElevatedButton.styleFrom(backgroundColor: color),
        ),
      ),
    );
  }

  Widget _cardHeader(String title) {
    return Text(
      title,
      style: const TextStyle(
        fontSize: 15,
        fontWeight: FontWeight.w700,
        color: AppColors.textDark,
      ),
    );
  }

  Widget _infoRow(IconData icon, String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 16, color: AppColors.textLight),
          const SizedBox(width: 10),
          SizedBox(
            width: 80,
            child: Text(
              label,
              style: const TextStyle(fontSize: 12, color: AppColors.textLight),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(fontSize: 13, color: AppColors.textDark),
            ),
          ),
        ],
      ),
    );
  }
}
