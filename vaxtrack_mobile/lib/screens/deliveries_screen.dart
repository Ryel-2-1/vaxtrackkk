import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import '../models/delivery.dart';
import '../services/delivery_service.dart';
import '../theme/app_theme.dart';
import 'delivery_detail_screen.dart';

class DeliveriesScreen extends StatefulWidget {
  const DeliveriesScreen({super.key});

  @override
  State<DeliveriesScreen> createState() => _DeliveriesScreenState();
}

class _DeliveriesScreenState extends State<DeliveriesScreen> with SingleTickerProviderStateMixin {
  final _deliveryService = DeliveryService();
  late TabController _tabController;
  String? _riderId;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    _riderId = FirebaseAuth.instance.currentUser?.uid;
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_riderId == null) return const Center(child: Text('Not logged in.'));

    return Scaffold(
      appBar: AppBar(
        title: const Text('My Deliveries'),
        bottom: TabBar(
          controller: _tabController,
          labelColor: AppColors.primary,
          unselectedLabelColor: AppColors.textLight,
          indicatorColor: AppColors.primary,
          tabs: const [
            Tab(text: 'Active'),
            Tab(text: 'Completed'),
            Tab(text: 'All'),
          ],
        ),
      ),
      body: StreamBuilder<List<Delivery>>(
        stream: _deliveryService.riderDeliveries(_riderId!),
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return Center(child: Text('Error loading deliveries.'));
          }

          final all = snapshot.data ?? [];
          final active = all.where((d) => !d.isDelivered).toList();
          final completed = all.where((d) => d.isDelivered).toList();

          return TabBarView(
            controller: _tabController,
            children: [
              _buildList(active, 'No active deliveries.'),
              _buildList(completed, 'No completed deliveries yet.'),
              _buildList(all, 'No deliveries assigned to you.'),
            ],
          );
        },
      ),
    );
  }

  Widget _buildList(List<Delivery> items, String emptyMsg) {
    if (items.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.inbox_outlined, size: 48, color: AppColors.textMuted),
              const SizedBox(height: 12),
              Text(emptyMsg, style: const TextStyle(color: AppColors.textMuted)),
            ],
          ),
        ),
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: items.length,
      itemBuilder: (context, index) {
        final d = items[index];
        return _deliveryTile(d);
      },
    );
  }

  Widget _deliveryTile(Delivery d) {
    return Card(
      child: ListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        leading: Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(
            color: d.isDelivered ? AppColors.primaryLight : (d.isUrgent ? AppColors.urgentBg : AppColors.infoBg),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Icon(
            d.isDelivered ? Icons.check_circle : (d.isInTransit ? Icons.local_shipping : Icons.inventory_2),
            color: d.isDelivered ? AppColors.primary : (d.isUrgent ? AppColors.urgent : AppColors.info),
            size: 22,
          ),
        ),
        title: Text(d.orderNumber, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14)),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(d.clinicName, style: const TextStyle(fontSize: 13)),
            const SizedBox(height: 2),
            Text('${d.vaccineName} · ${d.quantity} ${d.unit}',
                style: const TextStyle(fontSize: 11, color: AppColors.textLight)),
          ],
        ),
        trailing: _statusChip(d),
        onTap: () => Navigator.push(
          context,
          MaterialPageRoute(builder: (_) => DeliveryDetailScreen(delivery: d)),
        ),
      ),
    );
  }

  Widget _statusChip(Delivery d) {
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
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12)),
      child: Text(d.statusLabel, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: fg)),
    );
  }
}
