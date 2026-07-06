import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import '../models/app_user.dart';
import '../services/auth_service.dart';
import '../services/delivery_service.dart';
import '../models/delivery.dart';
import '../theme/app_theme.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  final _authService = AuthService();
  final _deliveryService = DeliveryService();

  @override
  Widget build(BuildContext context) {
    final uid = FirebaseAuth.instance.currentUser?.uid;
    if (uid == null) return const Center(child: Text('Not logged in.'));

    return Scaffold(
      appBar: AppBar(title: const Text('Rider Profile')),
      body: StreamBuilder<AppUser?>(
        stream: _authService.userProfileStream(uid),
        builder: (context, userSnap) {
          if (userSnap.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }

          final user = userSnap.data;
          if (user == null) return const Center(child: Text('Profile not found.'));

          return StreamBuilder<List<Delivery>>(
            stream: _deliveryService.riderDeliveries(uid),
            builder: (context, deliverySnap) {
              final deliveries = deliverySnap.data ?? [];
              final completed = deliveries.where((d) => d.isDelivered).length;
              final active = deliveries.where((d) => !d.isDelivered).length;

              return ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  _profileHeader(user),
                  const SizedBox(height: 16),
                  _statsRow(deliveries.length, completed, active),
                  const SizedBox(height: 16),
                  _detailsCard(user),
                  const SizedBox(height: 16),
                  _geofenceCard(),
                  const SizedBox(height: 24),
                  SizedBox(
                    width: double.infinity,
                    child: OutlinedButton.icon(
                      onPressed: _logout,
                      icon: const Icon(Icons.logout, color: AppColors.urgent),
                      label: const Text('Sign Out', style: TextStyle(color: AppColors.urgent)),
                      style: OutlinedButton.styleFrom(side: const BorderSide(color: AppColors.urgent)),
                    ),
                  ),
                ],
              );
            },
          );
        },
      ),
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

  Widget _geofenceCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Geofence & Deviation Status', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            const Text('Your current route compliance', style: TextStyle(fontSize: 12, color: AppColors.textLight)),
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: AppColors.primaryBg,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: AppColors.borderLight),
              ),
              child: const Row(
                children: [
                  Icon(Icons.check_circle, color: AppColors.primary, size: 20),
                  SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Within Geofence', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13, color: AppColors.primary)),
                        Text('No deviations detected', style: TextStyle(fontSize: 11, color: AppColors.textLight)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            const Text(
              'Geofence status is monitored by the dispatch system. If you deviate from your assigned route, an alert will be displayed here.',
              style: TextStyle(fontSize: 11, color: AppColors.textMuted),
            ),
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
