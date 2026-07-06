import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/delivery.dart';
import '../services/delivery_service.dart';
import '../services/location_service.dart';
import '../theme/app_theme.dart';
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
  String? _delayReason;

  Delivery get d => widget.delivery;

  Future<void> _updateStatus(String newStatus) async {
    setState(() => _updatingStatus = true);
    try {
      switch (newStatus) {
        case 'loading':
          await _deliveryService.startLoading(d.id);
          break;
        case 'in_transit':
          await _deliveryService.startTransit(d.id);
          break;
        case 'delivered':
          await _deliveryService.markDelivered(d.id);
          break;
        case 'delayed':
          await _deliveryService.reportDelay(d.id, _delayReason ?? 'Unknown');
          break;
        default:
          await _deliveryService.updateStatus(d.id, newStatus);
      }

      final pos = await _locationService.getCurrentPosition();
      if (pos != null) {
        await _locationService.updateOrderLocation(d.id, pos);
      }

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Status updated to $newStatus'), backgroundColor: AppColors.primary),
        );
        Navigator.pop(context);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error: $e'), backgroundColor: AppColors.urgent),
        );
      }
    } finally {
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
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
            ElevatedButton(
              onPressed: () {
                _delayReason = controller.text;
                Navigator.pop(ctx);
                _updateStatus('delayed');
              },
              style: ElevatedButton.styleFrom(backgroundColor: AppColors.urgent),
              child: const Text('Submit'),
            ),
          ],
        );
      },
    );
  }

  Future<void> _openNavigation() async {
    final address = Uri.encodeFull(d.clinicAddress);
    final uri = Uri.parse('https://www.google.com/maps/search/?api=1&query=$address');
    if (await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    }
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
          if (!d.isDelivered && d.status != 'delayed' && d.status != 'cancelled') ...[
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
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _cardHeader('Route Information'),
            const SizedBox(height: 12),
            Container(
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
                      const Text('Main Hub', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                      const Padding(
                        padding: EdgeInsets.symmetric(horizontal: 8),
                        child: Icon(Icons.arrow_forward, color: AppColors.primary, size: 16),
                      ),
                      Expanded(
                        child: Text(d.clinicAddress.isNotEmpty ? d.clinicAddress : d.clinicName,
                            style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text('Next Stop: ${d.clinicName}',
                      style: const TextStyle(fontSize: 12, color: AppColors.textLight)),
                ],
              ),
            ),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                onPressed: d.clinicAddress.isNotEmpty ? _openNavigation : null,
                icon: const Icon(Icons.navigation),
                label: const Text('Open in Maps'),
              ),
            ),
          ],
        ),
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
            _timelineEntry('Loading', d.startedAt, d.isLoading || d.isInTransit || d.isDelivered),
            _timelineEntry('In Transit', d.startedAt, d.isInTransit || d.isDelivered),
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
              border: Border.all(color: done ? AppColors.primary : AppColors.border),
            ),
            child: done
                ? const Icon(Icons.check, size: 14, color: AppColors.primary)
                : null,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(label, style: TextStyle(
              fontSize: 13,
              fontWeight: done ? FontWeight.w600 : FontWeight.normal,
              color: done ? AppColors.textDark : AppColors.textMuted,
            )),
          ),
          if (time != null)
            Text(fmt.format(time), style: const TextStyle(fontSize: 11, color: AppColors.textLight)),
        ],
      ),
    );
  }

  Widget _actionButtons() {
    return Column(
      children: [
        if (d.canStartLoading)
          _actionButton('Start Loading', Icons.inventory, AppColors.info, () => _updateStatus('loading')),
        if (d.canStartTransit)
          _actionButton('Start Transit', Icons.local_shipping, AppColors.primary, () => _updateStatus('in_transit')),
        if (d.canDeliver)
          _actionButton('Mark as Delivered', Icons.check_circle, AppColors.primary, () => _updateStatus('delivered')),
        const SizedBox(height: 8),
        if (!d.isDelivered)
          _actionButton('Report Delay', Icons.schedule, AppColors.urgent, _showDelayDialog),
      ],
    );
  }

  Widget _actionButton(String label, IconData icon, Color color, VoidCallback onTap) {
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
    return Text(title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: AppColors.textDark));
  }

  Widget _infoRow(IconData icon, String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 16, color: AppColors.textLight),
          const SizedBox(width: 10),
          SizedBox(width: 80, child: Text(label, style: const TextStyle(fontSize: 12, color: AppColors.textLight))),
          Expanded(child: Text(value, style: const TextStyle(fontSize: 13, color: AppColors.textDark))),
        ],
      ),
    );
  }
}
