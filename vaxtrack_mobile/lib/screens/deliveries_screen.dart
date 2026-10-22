import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import '../models/delivery.dart';
import '../services/delivery_service.dart';
import '../theme/app_theme.dart';
import '../utils/delivery_buckets.dart';
import '../widgets/delivery_list_card.dart';
import 'delivery_detail_screen.dart';
import '../widgets/rider_feed_builder.dart';

class DeliveriesScreen extends StatefulWidget {
  const DeliveriesScreen({super.key, this.riderId, this.deliveriesFeed});

  /// Test seams. In the app both are null: the Rider is the signed-in user and
  /// the feed is Firestore. Tests pass a Rider id and a controlled stream.
  final String? riderId;
  final Stream<List<Delivery>> Function(String riderId)? deliveriesFeed;

  @override
  State<DeliveriesScreen> createState() => _DeliveriesScreenState();
}

class _DeliveriesScreenState extends State<DeliveriesScreen> with SingleTickerProviderStateMixin {
  // Lazy: only created when the Firestore feed is actually opened.
  late final _deliveryService = DeliveryService();
  late TabController _tabController;
  /// The signed-in Rider, read on every build — never captured once — so a
  /// changed account can only ever open that account's feed.
  String? get _riderId => widget.riderId ?? FirebaseAuth.instance.currentUser?.uid;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final riderId = _riderId;
    if (riderId == null) return const Center(child: Text('Not logged in.'));

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
      // One subscription for the life of the screen (see RiderFeedBuilder).
      body: RiderFeedBuilder<List<Delivery>>(
        riderId: riderId,
        open: widget.deliveriesFeed ?? _deliveryService.riderDeliveries,
        component: 'DeliveriesScreen',
        what: 'your deliveries',
        builder: (context, deliveries) {
          final buckets = DeliveryBuckets(deliveries);
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
