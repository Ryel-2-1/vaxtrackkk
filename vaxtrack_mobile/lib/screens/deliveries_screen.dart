import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import '../models/delivery.dart';
import '../services/delivery_service.dart';
import '../theme/app_theme.dart';
import '../utils/delivery_buckets.dart';
import '../widgets/delivery_list_card.dart';
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

          final buckets = DeliveryBuckets(snapshot.data ?? []);
          final all = buckets.all;
          final active = buckets.active;
          final completed = buckets.completed;

          return TabBarView(
            controller: _tabController,
            children: [
              _buildList(active, 'No assigned deliveries yet.'),
              _buildList(completed, 'No completed deliveries yet.'),
              _buildList(all, 'No assigned deliveries yet.'),
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
        return DeliveryListCard(
          delivery: d,
          onTap: () => Navigator.push(
            context,
            MaterialPageRoute(builder: (_) => DeliveryDetailScreen(delivery: d)),
          ),
        );
      },
    );
  }
}
