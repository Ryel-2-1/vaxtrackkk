import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import '../offline/offline_delivery_service.dart';
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

  // Deliveries recorded on the phone without signal are sent by themselves:
  // now, whenever the app comes back to the foreground, and on the queue's own
  // retry timer while any is waiting.
  late final AppLifecycleListener _lifecycle =
      AppLifecycleListener(onResume: () => offlineDeliveries.sync());

  @override
  void initState() {
    super.initState();
    _lifecycle;
    offlineDeliveries.sync();
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

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

  // Tabs are built the first time they are opened and then kept: switching
  // back is instant, keeps scroll position and typed proof details, and never
  // re-opens a live feed. Tabs not yet visited cost nothing.
  final Set<int> _visited = {0};

  void _select(int i) {
    if (i == _currentIndex) return;
    setState(() {
      _currentIndex = i;
      _visited.add(i);
    });
  }

  static const _tabs = [
    (Icons.dashboard_outlined, Icons.dashboard, 'Dashboard'),
    (Icons.local_shipping_outlined, Icons.local_shipping, 'Deliveries'),
    (Icons.camera_alt_outlined, Icons.camera_alt, 'Proof'),
    (Icons.person_outlined, Icons.person, 'Profile'),
  ];

  Widget _shell() {
    return LayoutBuilder(
      builder: (context, constraints) {
        // Tablets and landscape: a side rail, and content kept to a readable
        // width instead of stretching across the screen.
        final wide = constraints.maxWidth >= 840;
        // Each tab fades in when shown (hidden tabs sit at 0, so showing one
        // animates it up); the stack itself is never rebuilt, so no tab loses
        // its state.
        final body = IndexedStack(
          index: _currentIndex,
          children: [
            for (var i = 0; i < _screens.length; i++)
              // Hidden tabs keep their state but run no animations.
              TickerMode(
                enabled: i == _currentIndex,
                child: AnimatedOpacity(
                  opacity: i == _currentIndex ? 1 : 0,
                  duration: const Duration(milliseconds: 180),
                  curve: Curves.easeOut,
                  child: _visited.contains(i) ? _screens[i] : const SizedBox.shrink(),
                ),
              ),
          ],
        );
        if (!wide) {
          return Scaffold(
            body: body,
            bottomNavigationBar: NavigationBar(
              selectedIndex: _currentIndex,
              onDestinationSelected: _select,
              backgroundColor: AppColors.surface,
              indicatorColor: AppColors.primaryLight,
              destinations: [
                for (final (icon, selected, label) in _tabs)
                  NavigationDestination(
                    icon: Icon(icon),
                    selectedIcon: Icon(selected, color: AppColors.primary),
                    label: label,
                  ),
              ],
            ),
          );
        }
        return Scaffold(
          body: SafeArea(
            child: Row(
              children: [
                NavigationRail(
                  selectedIndex: _currentIndex,
                  onDestinationSelected: _select,
                  backgroundColor: AppColors.surface,
                  indicatorColor: AppColors.primaryLight,
                  labelType: NavigationRailLabelType.all,
                  destinations: [
                    for (final (icon, selected, label) in _tabs)
                      NavigationRailDestination(
                        icon: Icon(icon),
                        selectedIcon: Icon(selected, color: AppColors.primary),
                        label: Text(label),
                      ),
                  ],
                ),
                const VerticalDivider(width: 1, color: AppColors.border),
                Expanded(
                  child: Align(
                    alignment: Alignment.topCenter,
                    child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 760), child: body),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}
