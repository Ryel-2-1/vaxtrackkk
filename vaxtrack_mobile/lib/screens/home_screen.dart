import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import '../services/rider_tracking_service.dart';
import '../tracking/tracking_contract.dart';
import '../tracking/tracking_lifecycle.dart';
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

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  int _currentIndex = 0;

  // Live location follows the rider's ACTIVE deliveries for as long as an
  // approved rider is signed in (HomeScreen is only shown to one). Signing out
  // shuts it down (AuthService.signOut); returning from Settings re-checks.
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final uid = FirebaseAuth.instance.currentUser?.uid;
    if (uid != null) riderTracking.attach(uid, trackedOrdersFor(uid));
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Locking the phone or switching apps never stops a running stream (see
    // foregroundForLifecycle); returning re-checks and starts what waited.
    final foreground = foregroundForLifecycle(state);
    if (foreground != null) riderTracking.setForeground(foreground);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    // Leaving the signed-in shell for any reason stops sharing.
    riderTracking.shutdown(reason: kEndReasonTrackingStopped);
    super.dispose();
  }

  final _screens = const [
    DashboardScreen(),
    DeliveriesScreen(),
    ProofScreen(),
    ProfileScreen(),
  ];

  @override
  Widget build(BuildContext context) {
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
