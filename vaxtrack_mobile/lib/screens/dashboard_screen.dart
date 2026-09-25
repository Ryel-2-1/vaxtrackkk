import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/delivery.dart';
import '../services/delivery_service.dart';
import '../services/location_service.dart';
import '../theme/app_theme.dart';
import '../utils/route_utils.dart';
import '../utils/sync_status.dart';
import '../utils/trip_route.dart';
import '../widgets/sync_indicator.dart';
import 'delivery_detail_screen.dart';

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  final _deliveryService = DeliveryService();
  final _locationService = LocationService();
  String? _riderId;

  @override
  void initState() {
    super.initState();
    _riderId = FirebaseAuth.instance.currentUser?.uid;
    _sendLocation();
  }

  Future<void> _sendLocation() async {
    if (_riderId == null) return;
    final pos = await _locationService.getCurrentPosition();
    if (pos != null) {
      await _locationService.updateRiderLocation(_riderId!, pos);
    }
  }

  // Open the whole optimized trip in Google Maps: current location → each stop
  // in visiting order. Real turn-by-turn without the gated Navigation SDK.
  Future<void> _navigateFullRoute(List<Delivery> stops) async {
    final uri = googleMapsMultiStopUrl(stops);
    if (uri == null) return;
    try {
      final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
      if (!ok && mounted) {
        _showSnack('Could not open Google Maps — no maps app is available.');
      }
    } catch (_) {
      if (mounted) _showSnack('Could not open Google Maps on this device.');
    }
  }

  void _showSnack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    if (_riderId == null) {
      return const Center(child: Text('Not logged in.'));
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Rider Dashboard')),
      body: StreamBuilder<RiderDeliveriesSnapshot>(
        stream: _deliveryService.riderDeliveriesWithSync(_riderId!),
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return Center(child: Text('Error: ${snapshot.error}'));
          }

          final result = snapshot.data;
          final deliveries = result?.deliveries ?? [];
          final active = deliveries.where((d) => d.isActive).toList();
          final completed = deliveries.where((d) => d.isDelivered).toList();
          final urgent = active.where((d) => d.isUrgent).toList();
          // Optimized multi-stop trip (dispatcher-generated). When present, the
          // active list is shown in visiting order and a route banner appears.
          final tripStops = orderedTripStops(active);
          final orderedActive = [...active]..sort((a, b) {
              final sa = a.isOnTrip ? (a.stopSequence ?? 9999) : 9999;
              final sb = b.isOnTrip ? (b.stopSequence ?? 9999) : 9999;
              return sa.compareTo(sb);
            });
          final syncStatus = result == null
              ? SyncStatus.synced
              : syncStatusFrom(
                  hasPendingWrites: result.hasPendingWrites,
                  isFromCache: result.isFromCache,
                );

          return RefreshIndicator(
            onRefresh: _sendLocation,
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Align(
                  alignment: Alignment.centerRight,
                  child: SyncIndicator(status: syncStatus),
                ),
                const SizedBox(height: 10),
                _buildStatCards(deliveries.length, completed.length, active.length),
                if (urgent.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  _buildUrgentBanner(urgent.first),
                ],
                if (tripStops.length >= 2) ...[
                  const SizedBox(height: 12),
                  _buildTripBanner(tripStops),
                ],
                const SizedBox(height: 20),
                _sectionTitle("Today's Deliveries", '${active.length} remaining'),
                const SizedBox(height: 8),
                if (active.isEmpty)
                  _emptyState('No assigned deliveries yet.')
                else
                  ...orderedActive.map((d) => _deliveryCard(d)),
                if (completed.isNotEmpty) ...[
                  const SizedBox(height: 20),
                  _sectionTitle('Completed', '${completed.length} delivered'),
                  const SizedBox(height: 8),
                  ...completed.map((d) => _deliveryCard(d)),
                ],
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _buildStatCards(int total, int done, int remaining) {
    return Row(
      children: [
        _statCard(Icons.local_shipping, 'Deliveries', '$total', AppColors.primary, AppColors.primaryLight),
        const SizedBox(width: 10),
        _statCard(Icons.check_circle, 'Completed', '$done', AppColors.primary, AppColors.primaryLight),
        const SizedBox(width: 10),
        _statCard(Icons.inventory_2, 'Remaining', '$remaining', AppColors.warning, AppColors.warningBg),
      ],
    );
  }

  Widget _statCard(IconData icon, String label, String value, Color iconColor, Color bgColor) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(14),
          boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.05), blurRadius: 4)],
        ),
        child: Column(
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(color: bgColor, borderRadius: BorderRadius.circular(10)),
              child: Icon(icon, color: iconColor, size: 20),
            ),
            const SizedBox(height: 8),
            Text(value, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w900, color: AppColors.textDark)),
            const SizedBox(height: 2),
            Text(label, style: const TextStyle(fontSize: 11, color: AppColors.textLight)),
          ],
        ),
      ),
    );
  }

  Widget _buildUrgentBanner(Delivery d) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.urgentBg,
        border: Border.all(color: const Color(0xFFFCA5A5)),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: [
          const Icon(Icons.warning_rounded, color: AppColors.urgent, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              'Urgent: ${d.orderNumber} — ${d.clinicName}',
              style: const TextStyle(color: Color(0xFF991B1B), fontSize: 13, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildTripBanner(List<Delivery> stops) {
    final first = stops.first;
    final distance = formatDistance(first.tripDistanceMeters);
    final duration = formatDuration(first.tripDurationSeconds);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.primaryLight,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.alt_route, color: AppColors.primary, size: 20),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Your route · ${stops.length} stops',
                  style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      color: AppColors.textDark),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            'Optimized order · $distance · $duration',
            style: const TextStyle(fontSize: 12, color: AppColors.textLight),
          ),
          const SizedBox(height: 10),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton.icon(
              onPressed: () => _navigateFullRoute(stops),
              icon: const Icon(Icons.navigation, size: 18),
              label: const Text('Navigate route in Google Maps'),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.primary,
                foregroundColor: Colors.white,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _sectionTitle(String title, String subtitle) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: AppColors.textDark)),
        Text(subtitle, style: const TextStyle(fontSize: 12, color: AppColors.textLight)),
      ],
    );
  }

  Widget _emptyState(String msg) {
    return Container(
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Center(
        child: Text(msg, style: const TextStyle(color: AppColors.textMuted, fontSize: 13)),
      ),
    );
  }

  Widget _deliveryCard(Delivery d) {
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: () => Navigator.push(
          context,
          MaterialPageRoute(builder: (_) => DeliveryDetailScreen(delivery: d)),
        ),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  // Neither child of this Row was flexible, so both took their
                  // full intrinsic width and the Row overflowed whenever the
                  // order number plus both badges exceeded the card's 288dp of
                  // content width — by 6.6px on a 384dp-wide device, which
                  // clipped the trailing status badge to "In Tra".
                  //
                  // The order number is the only variable-length item here; the
                  // badges are short, fixed-vocabulary labels that must stay
                  // fully readable. Flexible (not Expanded) lets the number —
                  // and only the number — give way, so the row is byte-identical
                  // wherever it already fits and the badges are never clipped
                  // where it does not. The right padding keeps the ellipsis off
                  // the badge once the text does have to shrink.
                  Flexible(
                    child: Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: Text(d.orderNumber,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
                    ),
                  ),
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      _badge(d.priority, d.priority == 'Urgent' ? AppColors.urgentBg : AppColors.primaryLight,
                          d.priority == 'Urgent' ? AppColors.urgent : AppColors.primary),
                      const SizedBox(width: 6),
                      _statusBadge(d),
                    ],
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Text(d.clinicName, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
              if (d.isOnTrip) ...[
                const SizedBox(height: 6),
                _tripStopChip(d),
              ],
              const SizedBox(height: 8),
              Row(
                children: [
                  const Icon(Icons.location_on, size: 14, color: AppColors.textLight),
                  const SizedBox(width: 4),
                  Expanded(child: Text(d.clinicAddress, style: const TextStyle(fontSize: 12, color: AppColors.textLight))),
                ],
              ),
              const SizedBox(height: 4),
              Row(
                children: [
                  const Icon(Icons.vaccines, size: 14, color: AppColors.textLight),
                  const SizedBox(width: 4),
                  // Same defect as the header row, and the same fix the address
                  // row directly above already uses: the vaccine name is
                  // variable-length, so without a flex child this Row overflows
                  // on longer names. Expanded (not ellipsis) so the full name
                  // stays readable by wrapping, matching the address row.
                  Expanded(
                    child: Text('${d.vaccineName} — ${d.quantity} ${d.unit}',
                        style: const TextStyle(fontSize: 12, color: AppColors.textLight)),
                  ),
                ],
              ),
              if (d.isDelivered) ...[
                const SizedBox(height: 10),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(Icons.check_circle, color: AppColors.primary, size: 16),
                    const SizedBox(width: 6),
                    const Text('Delivered', style: TextStyle(color: AppColors.primary, fontWeight: FontWeight.w700)),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _tripStopChip(Delivery d) {
    final total = d.tripStopCount;
    final label = (total != null && total > 0)
        ? 'Stop ${d.stopSequence} of $total'
        : 'Stop ${d.stopSequence}';
    final eta =
        (d.stopEtaText ?? '').isNotEmpty ? ' · ETA ${d.stopEtaText}' : '';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: AppColors.infoBg,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.alt_route, size: 13, color: AppColors.info),
          const SizedBox(width: 4),
          Text(
            '$label$eta',
            style: const TextStyle(
                fontSize: 11, fontWeight: FontWeight.w700, color: AppColors.info),
          ),
        ],
      ),
    );
  }

  Widget _badge(String text, Color bg, Color fg) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(20)),
      child: Text(text, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: fg)),
    );
  }

  Widget _statusBadge(Delivery d) {
    Color bg;
    Color fg;
    switch (d.status) {
      case 'in_transit':
        bg = AppColors.infoBg;
        fg = AppColors.info;
        break;
      case 'delivered':
      case 'completed':
        bg = AppColors.primaryLight;
        fg = AppColors.primary;
        break;
      case 'delayed':
        bg = AppColors.urgentBg;
        fg = AppColors.urgent;
        break;
      default:
        bg = AppColors.warningBg;
        fg = AppColors.warning;
    }
    return _badge(d.statusLabel, bg, fg);
  }
}
