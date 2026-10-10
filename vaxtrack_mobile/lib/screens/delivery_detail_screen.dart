import 'dart:async';
import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/delivery.dart';
import '../services/delivery_service.dart';
import '../theme/app_theme.dart';
import '../utils/completion_gate.dart';
import '../utils/google_maps_url.dart';
import '../utils/nav_availability.dart';
import '../utils/order_workflow.dart';
import '../utils/route_utils.dart';
import '../widgets/delivered_evidence_card.dart';
import '../widgets/delivery_map.dart';
import 'delivery_completion_coordinator.dart';
import 'proof_screen.dart';
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
  bool _updatingStatus = false;
  String? _delayReason;
  String? _failureReason;
  // Fires the "saved, will sync" feedback if a write is still pending after a
  // few seconds. UI-only — it never clears the pending guard (see _updateStatus).
  Timer? _statusFeedbackTimer;

  // The order this screen shows. Starts from the dashboard's copy and is
  // reloaded from the server when the rider returns from adding evidence, so
  // the screen never decides completion against a stale snapshot.
  late final DeliveryCompletionCoordinator _completion =
      DeliveryCompletionCoordinator(
    initial: widget.delivery,
    loader: _deliveryService,
    completer: _deliveryService,
  );

  Delivery get d => _completion.delivery;

  // Any write, completion or reload in progress — the action buttons wait.
  bool get _busy =>
      _updatingStatus || _completion.completing || _completion.refreshing;

  @override
  void initState() {
    super.initState();
    _completion.addListener(_onCompletionChanged);
    // Live location is NOT owned by this screen: it follows the rider's active
    // deliveries app-wide (riderTracking, attached by HomeScreen), so opening
    // or leaving this screen never starts or stops it.
  }

  @override
  void dispose() {
    _statusFeedbackTimer?.cancel();
    _completion.removeListener(_onCompletionChanged);
    _completion.dispose();
    super.dispose();
  }

  void _onCompletionChanged() {
    if (mounted) setState(() {});
  }

  // Routes a target status to the matching audit-stamped service write.
  //
  // The `loading` / `in_transit`-from-loading branches are gone with the
  // buttons that drove them, and there is no longer a `default` that forwards
  // an arbitrary string: every remaining branch is one of the rider's four
  // legal moves, and each service method re-validates it against the shared
  // policy using the delivery's stored status before writing.
  Future<void> _statusWrite(String newStatus) {
    switch (newStatus) {
      case 'delivered':
        return _deliveryService.markDelivered(d.id, d.status);
      case 'in_transit':
        return _deliveryService.resumeTransit(d.id, d.status);
      case 'delayed':
        return _deliveryService.reportDelay(
            d.id, d.status, _delayReason ?? '');
      case 'delivery_failed':
        return _deliveryService.reportDeliveryFailure(
            d.id, d.status, _failureReason ?? '');
      default:
        // Unreachable from the UI; refuse rather than invent a write.
        throw WorkflowException(
          'transition-not-allowed',
          'A rider cannot move a delivery to ${statusLabel(newStatus)}.',
        );
    }
  }

  Future<void> _updateStatus(String newStatus) async {
    // Duplicate-submission guard. The action buttons are disabled while this is
    // true, AND it is cleared ONLY when the Firestore write actually settles
    // (in the finally below) — never by the feedback timeout. So while a write
    // is still pending offline, the same action cannot be re-submitted.
    if (_updatingStatus) return;
    setState(() => _updatingStatus = true);

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

      // No tracking work here: the app-wide controller sees the new status in
      // the rider's order stream and starts/stops sharing (and ends navigation).
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

  // Rider tapped "Submit Proof & Complete Delivery". Identity, assignment and
  // status are checked here first (fail-closed, early feedback only — the rules
  // and the completion callable remain the authority). The evidence is then
  // gathered on Proof of Delivery, whose single action uploads both photos and
  // completes the delivery behind the existing confirmation. Nothing is
  // uploaded or written on this tap.
  Future<void> _onCompletePressed() async {
    if (_busy) return;
    final readiness = _completion.readiness(
      currentRiderId: FirebaseAuth.instance.currentUser?.uid,
    );
    // Missing photos are exactly what the next screen collects.
    if (!readiness.ready && !readiness.isMissingEvidence) {
      _showCompletionBlocked(readiness);
      return; // no upload, no status change
    }

    final completed = await Navigator.push<bool>(
      context,
      MaterialPageRoute(builder: (_) => ProofScreen.forDelivery(d)),
    );
    if (!mounted) return;

    // ProofScreen pops `true` only after the server completed the delivery.
    if (completed == true) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Delivery completed.'),
          backgroundColor: AppColors.primary,
        ),
      );
      Navigator.pop(context);
      return;
    }
    // Back without completing: whatever was recorded is reloaded, never assumed.
    final ok = await _completion.refresh();
    if (!ok && mounted) _showRefreshFailed();
  }

  // A completion the rider is not ready for: tell them exactly what is wrong.
  // A missing photo offers Proof of Delivery; unconfirmed data offers a reload.
  // No upload, no status change.
  void _showCompletionBlocked(CompletionReadiness readiness) {
    SnackBarAction? action;
    if (readiness.isMissingEvidence) {
      action = SnackBarAction(
        label: 'Add proof',
        textColor: Colors.white,
        onPressed: _openProofAndRefresh,
      );
    } else if (readiness.block == CompletionBlock.unconfirmed) {
      action = SnackBarAction(
        label: 'Retry',
        textColor: Colors.white,
        onPressed: _retryRefresh,
      );
    }
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content:
            Text(readiness.message ?? 'This delivery cannot be completed yet.'),
        backgroundColor: AppColors.warning,
        action: action,
      ),
    );
  }

  // Open Proof of Delivery; when the rider comes back, reload the order from the
  // server so the new proof/invoice (and any status or assignment change) are
  // what completion is decided against.
  Future<void> _openProofAndRefresh() async {
    final ok = await _completion.addEvidenceThenRefresh(() async {
      await Navigator.push(
        context,
        MaterialPageRoute(builder: (_) => ProofScreen.forDelivery(d)),
      );
    });
    if (!ok && mounted) _showRefreshFailed();
  }

  Future<void> _retryRefresh() async {
    final ok = await _completion.refresh();
    if (!mounted) return;
    if (ok) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Delivery details updated.'),
          backgroundColor: AppColors.primary,
        ),
      );
    } else {
      _showRefreshFailed();
    }
  }

  // The previous details stay on screen, but completion stays blocked until a
  // reload succeeds — newly uploaded evidence is never assumed to exist.
  void _showRefreshFailed() {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: const Text(DeliveryCompletionCoordinator.refreshFailedMessage),
        backgroundColor: AppColors.urgent,
        action: SnackBarAction(
          label: 'Retry',
          textColor: Colors.white,
          onPressed: _retryRefresh,
        ),
      ),
    );
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

  /// Report that the delivery could not be completed.
  ///
  /// A reason is required and validated here before the dialog closes, using
  /// the same shared rule the service and the Firestore rules apply — trimmed,
  /// non-empty, at most 500 characters. Dismissing changes nothing. Nothing is
  /// invented: no recipient, no location, no proof, and no default reason.
  void _showFailureDialog() {
    if (_updatingStatus) return;
    showDialog(
      context: context,
      builder: (ctx) {
        final controller = TextEditingController();
        String? error;
        var submitted = false;

        return StatefulBuilder(
          builder: (ctx, setDialogState) => AlertDialog(
            title: const Text('Report Delivery Failure'),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'This marks the delivery as failed and hands it back to the '
                  'dispatcher, who will retry or cancel it.',
                  style: TextStyle(fontSize: 13),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: controller,
                  autofocus: true,
                  maxLines: 3,
                  maxLength: kMaxReasonLength,
                  decoration: InputDecoration(
                    labelText: 'Why did it fail?',
                    hintText: 'e.g., Clinic permanently closed, recipient refused',
                    errorText: error,
                  ),
                  onChanged: (_) {
                    if (error != null) setDialogState(() => error = null);
                  },
                ),
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(ctx),
                child: const Text('Cancel'),
              ),
              ElevatedButton(
                onPressed: () {
                  // Guard against a second tap landing before the dialog pops.
                  if (submitted) return;
                  final checked = validateReason(controller.text,
                      label: 'reason this delivery failed');
                  if (!checked.valid) {
                    setDialogState(() => error = checked.message);
                    return;
                  }
                  submitted = true;
                  _failureReason = checked.value;
                  Navigator.pop(ctx);
                  _updateStatus('delivery_failed');
                },
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.urgent,
                ),
                child: const Text('Report Failure'),
              ),
            ],
          ),
        );
      },
    );
  }

  // Hands off to the installed Google Maps app for real turn-by-turn
  // navigation (free, no API key), in motorcycle mode. Prefers the exact clinic
  // coordinates when the dispatcher set them; otherwise falls back to an
  // address search (a search carries no travel mode — the rider picks it).
  Future<void> _openNavigation() async {
    final Uri uri;
    if (d.hasClinicCoords) {
      uri = googleMapsDestinationUrl(d.clinicLat!, d.clinicLng!);
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

  // Open the FREE in-app navigation screen (OpenStreetMap). Requires the
  // delivery to be active with clinic coordinates; the screen itself enforces
  // start eligibility (auth, assignment, in transit), and Firestore rules +
  // the server remain the final authority.
  Future<void> _startRouteMonitoring() async {
    if (!d.isActive || !d.hasClinicCoords) return;
    await Navigator.push(
      context,
      MaterialPageRoute(builder: (_) => RouteMonitoringScreen(delivery: d)),
    );
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
          // Delivered: the recorded evidence, read-only. (It is no longer
          // offered on the Proof screen, which takes only open deliveries.)
          if (d.isDelivered) ...[
            const SizedBox(height: 12),
            DeliveredEvidenceCard(delivery: d),
          ],
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
              // Start navigation opens THIS stop in the Google Maps app for
              // turn-by-turn. (The whole optimized trip is launched from the
              // dashboard route banner.) No in-app Navigation SDK, so there is
              // no Maps-key / terms gate — one consistent nav path that works.
              SizedBox(
                width: double.infinity,
                child: ElevatedButton.icon(
                  onPressed: nav.canOpenExternalMaps ? _openNavigation : null,
                  icon: const Icon(Icons.navigation),
                  label: const Text('Start navigation'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.primary,
                    foregroundColor: Colors.white,
                  ),
                ),
              ),
              if (nav.canOpenExternalMaps)
                const Padding(
                  padding: EdgeInsets.only(top: 6),
                  child: Text(
                    motorcycleModeNote,
                    style: TextStyle(fontSize: 11, color: AppColors.textLight),
                  ),
                ),
              if (nav.usesAddressSearch)
                const Padding(
                  padding: EdgeInsets.only(top: 6),
                  child: Text(
                    'No destination pin from dispatch — Google Maps will search '
                    'by the clinic address.',
                    style: TextStyle(fontSize: 11, color: AppColors.textLight),
                  ),
                ),
              if (!nav.canOpenExternalMaps)
                const Padding(
                  padding: EdgeInsets.only(top: 6),
                  child: Text(
                    'No destination available to navigate to yet.',
                    style: TextStyle(fontSize: 11, color: AppColors.textLight),
                  ),
                ),
              const SizedBox(height: 16),
              const Divider(height: 1),
              const SizedBox(height: 12),
              // SEPARATE, clearly-labelled VaxTrack compliance feature — NOT a
              // turn-by-turn navigator. Free flutter_map + OpenStreetMap. Start
              // Navigation opens a navigation session; the SERVER checks the
              // shared location against the Dispatcher-assigned route and raises
              // any deviation alert. The screen explains anything missing.
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
                  label: const Text('Navigation & route monitoring'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.info,
                    foregroundColor: Colors.white,
                  ),
                ),
              ),
              const Padding(
                padding: EdgeInsets.only(top: 6),
                child: Text(
                  'Start Navigation to have VaxTrack check your route against the '
                  'Dispatcher-assigned one. Not turn-by-turn navigation.',
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

  /// A calm, non-actionable panel for the stages the dispatcher owns.
  Widget _waitingNotice(IconData icon, String title, String detail) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.info.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.info.withValues(alpha: 0.35)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 20, color: AppColors.info),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title,
                    style: const TextStyle(
                        fontWeight: FontWeight.w700, fontSize: 14)),
                const SizedBox(height: 4),
                Text(detail,
                    style: const TextStyle(fontSize: 12.5, height: 1.4)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// Rider actions — strictly the assigned rider's authority.
  ///
  /// "Start Loading" and "Start Transit" are gone: loading and dispatch belong
  /// to Cargo Loading, where the dispatcher confirms the cargo is physically
  /// loaded and finalizes the run. Those two stages now render as waiting
  /// states, so the rider still sees the order and understands what it is
  /// waiting for rather than losing it from view.
  ///
  /// Report Delay is also no longer offered on every non-delivered order — it
  /// is a transit action, so it appears only while the delivery is actually
  /// moving or already delayed.
  Widget _actionButtons() {
    if (d.isAwaitingLoading) {
      return _waitingNotice(
        Icons.inventory_2_outlined,
        'Waiting for loading',
        'The dispatcher will confirm this order is loaded. Nothing is needed from you yet.',
      );
    }

    if (d.isAwaitingDispatch) {
      return _waitingNotice(
        Icons.local_shipping_outlined,
        'Waiting for dispatch',
        'This order is being loaded. It becomes in transit once the dispatcher finalizes the run.',
      );
    }

    // Reported as failed: the rider is done with it. Retrying or cancelling is
    // the dispatcher's decision, so no action is offered here — only the
    // reported reason, so the rider can see what was recorded.
    if (d.isDeliveryFailed) {
      final reason = d.deliveryFailureReason;
      return _waitingNotice(
        Icons.report_problem_outlined,
        'Awaiting dispatcher action',
        reason == null || reason.isEmpty
            ? 'You reported this delivery as failed. The dispatcher will retry or cancel it.'
            : 'You reported this delivery as failed: "$reason". The dispatcher will retry or cancel it.',
      );
    }

    return Column(
      children: [
        if (d.canResumeTransit)
          _actionButton(
            'Resume Transit',
            Icons.play_arrow,
            AppColors.primary,
            () => _updateStatus('in_transit'),
          ),
        if (d.canComplete)
          _actionButton(
            'Submit Proof & Complete Delivery',
            Icons.check_circle,
            AppColors.primary,
            _onCompletePressed,
          ),
        if (d.canReportDelay) ...[
          const SizedBox(height: 8),
          _actionButton(
            'Report Delay',
            Icons.schedule,
            AppColors.urgent,
            _showDelayDialog,
          ),
        ],
        if (d.canReportFailure) ...[
          const SizedBox(height: 8),
          _actionButton(
            'Report Delivery Failure',
            Icons.cancel_schedule_send,
            AppColors.urgent,
            _showFailureDialog,
          ),
        ],
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
          onPressed: _busy ? null : onTap,
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
