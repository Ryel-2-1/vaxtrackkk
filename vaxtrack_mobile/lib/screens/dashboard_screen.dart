import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/delivery.dart';
import '../services/delivery_service.dart';
import '../services/location_service.dart';
import '../theme/app_theme.dart';
import '../utils/delivery_buckets.dart';
import '../utils/google_maps_url.dart';
import '../utils/route_utils.dart';
import '../utils/sync_status.dart';
import '../utils/trip_route.dart';
import '../widgets/dashboard_delivery_card.dart';
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
          final buckets = DeliveryBuckets(deliveries);
          final active = buckets.active;
          final completed = buckets.completed;
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
                _buildStatCards(buckets.total, buckets.done, buckets.remaining),
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
                  ...orderedActive.map(_deliveryCard),
                if (completed.isNotEmpty) ...[
                  const SizedBox(height: 20),
                  _sectionTitle('Completed', '${completed.length} delivered'),
                  const SizedBox(height: 8),
                  ...completed.map(_deliveryCard),
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
          const SizedBox(height: 6),
          const Text(
            motorcycleModeNote,
            style: TextStyle(fontSize: 11, color: AppColors.textLight),
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
    return DashboardDeliveryCard(
      delivery: d,
      onTap: () => Navigator.push(
        context,
        MaterialPageRoute(builder: (_) => DeliveryDetailScreen(delivery: d)),
      ),
    );
  }
}
