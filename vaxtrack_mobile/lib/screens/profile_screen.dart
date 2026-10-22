import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import '../models/app_user.dart';
import '../services/auth_service.dart';
import '../services/delivery_service.dart';
import '../models/delivery.dart';
import '../theme/app_theme.dart';
import '../widgets/route_monitoring_card.dart';
import '../widgets/rider_feed_builder.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key, this.riderId, this.profileFeed, this.deliveriesFeed});

  /// Test seams. In the app all are null: the Rider is the signed-in user and
  /// both feeds are Firestore. Tests pass a Rider id and controlled streams.
  final String? riderId;
  final Stream<AppUser?> Function(String riderId)? profileFeed;
  final Stream<List<Delivery>> Function(String riderId)? deliveriesFeed;

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  // Lazy: only created when a Firestore feed is actually opened.
  late final _authService = AuthService();
  late final _deliveryService = DeliveryService();
  /// The signed-in Rider, read on every build — never captured once — so a
  /// changed account can only ever open that account's feed.
  String? get _uid => widget.riderId ?? FirebaseAuth.instance.currentUser?.uid;

  @override
  Widget build(BuildContext context) {
    final uid = _uid;
    if (uid == null) return const Center(child: Text('Not logged in.'));

    return Scaffold(
      appBar: AppBar(title: const Text('Rider Profile')),
      // Each feed is subscribed once (see RiderFeedBuilder). Sign Out stays
      // reachable in every state, including a failed profile load.
      body: RiderFeedBuilder<AppUser?>(
        riderId: uid,
        open: widget.profileFeed ?? _authService.userProfileStream,
        component: 'ProfileScreen',
        what: 'your profile',
        errorBuilder: (context, message, retry) =>
            RiderFeedError(message: message, onRetry: retry, footer: _signOutButton()),
        builder: (context, user) {
          if (user == null) {
            // The profile feed is live: if the record appears, this updates
            // by itself — so no Retry here.
            return RiderFeedError(
              message: 'Your rider profile could not be found. Contact your dispatcher.',
              footer: _signOutButton(),
            );
          }
          // The delivery counts are secondary: while they load or if they
          // fail, the rest of the profile (and Sign Out) stays on screen.
          return RiderFeedBuilder<List<Delivery>>(
            riderId: uid,
            open: widget.deliveriesFeed ?? _deliveryService.riderDeliveries,
            component: 'ProfileScreen',
            what: 'your delivery counts',
            loadingBuilder: (context) => _page(
              user,
              stats: const LinearProgressIndicator(key: ValueKey('profile-stats-loading')),
            ),
            errorBuilder: (context, message, retry) => _page(
              user,
              stats: _statsError(message, retry),
            ),
            builder: (context, deliveries) {
              final completed = deliveries.where((d) => d.isDelivered).length;
              final active = deliveries.where((d) => !d.isDelivered).length;
              return _page(user, stats: _statsRow(deliveries.length, completed, active));
            },
          );
        },
      ),
    );
  }

  Widget _page(AppUser user, {required Widget stats}) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _profileHeader(user),
        const SizedBox(height: 16),
        stats,
        const SizedBox(height: 16),
        _detailsCard(user),
        const SizedBox(height: 16),
        const RouteMonitoringCard(),
        const SizedBox(height: 24),
        _signOutButton(),
      ],
    );
  }

  Widget _signOutButton() {
    return SizedBox(
      width: double.infinity,
      child: OutlinedButton.icon(
        onPressed: _logout,
        icon: const Icon(Icons.logout, color: AppColors.urgent),
        label: const Text('Sign Out', style: TextStyle(color: AppColors.urgent)),
        style: OutlinedButton.styleFrom(side: const BorderSide(color: AppColors.urgent)),
      ),
    );
  }

  Widget _statsError(String message, VoidCallback retry) {
    return Row(
      children: [
        Expanded(
          child: Text(
            message,
            key: const ValueKey('feed-error-message'),
            style: const TextStyle(fontSize: 12, color: AppColors.textMedium),
          ),
        ),
        TextButton(key: const ValueKey('feed-retry'), onPressed: retry, child: const Text('Retry')),
      ],
    );
  }

  Widget _profileHeader(AppUser user) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          children: [
            Container(
              width: 72,
              height: 72,
              decoration: BoxDecoration(
                color: AppColors.primaryLight,
                borderRadius: BorderRadius.circular(18),
              ),
              child: const Icon(Icons.two_wheeler, size: 36, color: AppColors.primary),
            ),
            const SizedBox(height: 12),
            Text(user.name, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            Text(user.email, style: const TextStyle(fontSize: 13, color: AppColors.textLight)),
            const SizedBox(height: 4),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
              decoration: BoxDecoration(
                color: user.isApproved ? AppColors.primaryLight : AppColors.warningBg,
                borderRadius: BorderRadius.circular(20),
              ),
              child: Text(
                user.isApproved ? 'Active Rider' : user.status.toUpperCase(),
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  color: user.isApproved ? AppColors.primary : AppColors.warning,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _statsRow(int total, int completed, int active) {
    return Row(
      children: [
        _miniStat('Total', '$total'),
        const SizedBox(width: 10),
        _miniStat('Completed', '$completed'),
        const SizedBox(width: 10),
        _miniStat('Active', '$active'),
      ],
    );
  }

  Widget _miniStat(String label, String value) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 14),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(12),
          boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.05), blurRadius: 4)],
        ),
        child: Column(
          children: [
            Text(value, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w900)),
            const SizedBox(height: 2),
            Text(label, style: const TextStyle(fontSize: 11, color: AppColors.textLight)),
          ],
        ),
      ),
    );
  }

  Widget _detailsCard(AppUser user) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Rider Information', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
            const SizedBox(height: 12),
            _detailRow('Employee ID', user.employeeId ?? 'N/A'),
            _detailRow('Vehicle', user.vehiclePlate ?? 'N/A'),
            _detailRow('Phone', user.phone ?? 'N/A'),
            _detailRow('Region', user.region ?? 'N/A'),
            _detailRow('Role', 'Rider'),
            _detailRow('Status', user.isApproved ? 'Active' : user.status),
          ],
        ),
      ),
    );
  }

  Widget _detailRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          SizedBox(width: 100, child: Text(label, style: const TextStyle(fontSize: 12, color: AppColors.textLight))),
          Expanded(child: Text(value, style: const TextStyle(fontSize: 13, color: AppColors.textDark))),
        ],
      ),
    );
  }

  Future<void> _logout() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Sign Out'),
        content: const Text('Are you sure you want to sign out?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: ElevatedButton.styleFrom(backgroundColor: AppColors.urgent),
            child: const Text('Sign Out'),
          ),
        ],
      ),
    );

    if (confirm == true) {
      await _authService.signOut();
      if (mounted) {
        // Return to the root AuthGate ('/'), which shows LoginScreen for a
        // signed-out user. Pushing '/login' instead would remove AuthGate
        // from the stack and leave nobody routing the next sign-in.
        Navigator.of(context).pushNamedAndRemoveUntil('/', (route) => false);
      }
    }
  }
}
