// LOCAL DEV HARNESS for the REAL production GoogleNavigationScreen.
//
// Run with:
//   flutter run -t lib/dev/google_navigation_production_local_main.dart
//
// Purpose: exercise the real production `GoogleNavigationScreen` (with its
// Phase-3A local route-compliance monitoring) WITHOUT logging into Firebase and
// WITHOUT triggering the existing rider-location Firestore writes.
//
//  * NO Firebase initialization.
//  * NO Firebase / Firestore import.
//  * Reads/writes NO orders, users, locations, or alerts.
//  * Hardcoded DEV destination coordinates are allowed ONLY here (never in the
//    production screen).
//
// NOT wired into main.dart or any production route.
import 'package:flutter/material.dart';
import '../screens/google_navigation_screen.dart';

// Development-only test destination (clearly labelled — NOT a real clinic).
const double _devDestinationLat = 14.5995;
const double _devDestinationLng = 120.9842;
const String _devClinicName = 'DEV Test Clinic (harness)';
const String _devClinicAddress =
    'Local development destination — not a real clinic';

void main() {
  // Deliberately NO Firebase.initializeApp() — this harness must not touch
  // Firebase, Firestore, orders, users, locations, or alerts.
  runApp(const _ProdLocalHarnessApp());
}

class _ProdLocalHarnessApp extends StatelessWidget {
  const _ProdLocalHarnessApp();

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'GoogleNavigationScreen — LOCAL DEV harness',
      theme: ThemeData(colorSchemeSeed: Colors.blue, useMaterial3: true),
      home: Scaffold(
        body: SafeArea(
          bottom: false,
          child: Column(
            children: [
              Container(
                width: double.infinity,
                color: const Color(0xFFFFF3CD),
                padding: const EdgeInsets.all(10),
                child: const Text(
                  'LOCAL DEV HARNESS — no Firebase / no Firestore / no '
                  'order-user-location-alert writes. Launches the real '
                  'production GoogleNavigationScreen with a DEV destination.',
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    color: Color(0xFF7A5C00),
                  ),
                ),
              ),
              const Expanded(
                child: GoogleNavigationScreen(
                  clinicLat: _devDestinationLat,
                  clinicLng: _devDestinationLng,
                  clinicName: _devClinicName,
                  clinicAddress: _devClinicAddress,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
