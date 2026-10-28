import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import '../services/rider_tracking_service.dart';
import '../tracking/tracking_session_scope.dart';
import 'dashboard_screen.dart';
import 'deliveries_screen.dart';
import 'proof_screen.dart';
import 'profile_screen.dart';
import '../theme/app_theme.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _currentIndex = 0;

  final _screens = const [
    DashboardScreen(),
    DeliveriesScreen(),
    ProofScreen(),
    ProfileScreen(),
  ];

  // Live location follows the rider's ACTIVE deliveries for as long as an
  // approved rider is signed in (HomeScreen is only shown to one). The scope
  // attaches on mount, releases ITS OWN claim on unmount (never a newer one),
  // and forwards the app lifecycle. Signing out shuts it down (AuthService.signOut).
  @override
  Widget build(BuildContext context) {
    return TrackingSessionScope(
      controller: riderTracking,
      riderUid: FirebaseAuth.instance.currentUser?.uid,
      ordersFor: trackedOrdersFor,
      child: _shell(),
    );
  }

  Widget _shell() {
    return Scaffold(
      body: _screens[_currentIndex],
      bottomNavigationBar: NavigationBar(
        selectedIndex: _currentIndex,
        onDestinationSelected: (i) => setState(() => _currentIndex = i),
        backgroundColor: AppColors.surface,
        indicatorColor: AppColors.primaryLight,
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.dashboard_outlined),
            selectedIcon: Icon(Icons.dashboard, color: AppColors.primary),
            label: 'Dashboard',
          ),
          NavigationDestination(
            icon: Icon(Icons.local_shipping_outlined),
            selectedIcon: Icon(Icons.local_shipping, color: AppColors.primary),
            label: 'Deliveries',
          ),
          NavigationDestination(
            icon: Icon(Icons.camera_alt_outlined),
            selectedIcon: Icon(Icons.camera_alt, color: AppColors.primary),
            label: 'Proof',
          ),
          NavigationDestination(
            icon: Icon(Icons.person_outlined),
            selectedIcon: Icon(Icons.person, color: AppColors.primary),
            label: 'Profile',
          ),
        ],
      ),
    );
  }
}
