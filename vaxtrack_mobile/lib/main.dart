import 'package:flutter/material.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'firebase_options.dart';
import 'theme/app_theme.dart';
import 'screens/login_screen.dart';
import 'screens/home_screen.dart';
import 'screens/register_screen.dart';
import 'services/auth_service.dart';
import 'models/app_user.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    try {
      await Firebase.initializeApp(
        options: DefaultFirebaseOptions.currentPlatform,
      );
    } on FirebaseException catch (e) {
      if (e.code != 'duplicate-app') rethrow;
    }
    runApp(const VaxTrackRiderApp());
  } catch (e, stack) {
    debugPrint('Firebase init failed: $e\n$stack');
    runApp(_FirebaseInitErrorApp(error: e.toString()));
  }
}

class _FirebaseInitErrorApp extends StatelessWidget {
  final String error;
  const _FirebaseInitErrorApp({required this.error});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      home: Scaffold(
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(Icons.error_outline, size: 56, color: Colors.red),
                const SizedBox(height: 16),
                const Text(
                  'VaxTrack Rider failed to start',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 8),
                const Text(
                  'Unable to initialize Firebase. Please check your connection and try again.',
                  style: TextStyle(fontSize: 13, color: Colors.black54),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 16),
                Text(
                  error,
                  style: const TextStyle(fontSize: 11, color: Colors.black45),
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class VaxTrackRiderApp extends StatelessWidget {
  const VaxTrackRiderApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'VaxTrack Rider',
      theme: AppTheme.theme,
      debugShowCheckedModeBanner: false,
      home: const AuthGate(),
      routes: {
        '/login': (_) => const LoginScreen(),
        '/home': (_) => const HomeScreen(),
        '/register': (_) => const RegisterScreen(),
      },
    );
  }
}

class AuthGate extends StatelessWidget {
  const AuthGate({super.key});

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<User?>(
      stream: FirebaseAuth.instance.authStateChanges(),
      builder: (context, snapshot) {
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Scaffold(
            body: Center(child: CircularProgressIndicator()),
          );
        }

        // While registerRider() runs, the freshly created Auth session fires
        // authStateChanges. AuthGate must not load the profile or sign out
        // here — that would race the in-flight Firestore profile write.
        // registerRider() signs out itself when done.
        if (AuthService.registrationInProgress) {
          return const Scaffold(
            body: Center(child: CircularProgressIndicator()),
          );
        }

        if (snapshot.data == null) {
          return const LoginScreen();
        }

        final uid = snapshot.data!.uid;
        return FutureBuilder<_ProfileResult>(
          future: _safeGetProfile(uid),
          builder: (context, userSnap) {
            if (userSnap.connectionState == ConnectionState.waiting) {
              return const Scaffold(
                body: Center(child: CircularProgressIndicator()),
              );
            }

            final result = userSnap.data;
            if (result == null) {
              // Should not happen with _safeGetProfile, but be defensive.
              AuthService.pendingLoginMessage =
                  'Sign in failed. Please try again.';
              FirebaseAuth.instance.signOut();
              return const Scaffold(
                body: Center(child: CircularProgressIndicator()),
              );
            }

            if (result.permissionDenied) {
              AuthService.pendingLoginMessage =
                  'Unable to load rider profile. Please check Firestore rules.';
              FirebaseAuth.instance.signOut();
              return const Scaffold(
                body: Center(child: CircularProgressIndicator()),
              );
            }

            final user = result.user;
            final rejection = AuthService.rejectionMessageFor(user);
            if (rejection != null) {
              AuthService.pendingLoginMessage = rejection;
              FirebaseAuth.instance.signOut();
              return const Scaffold(
                body: Center(child: CircularProgressIndicator()),
              );
            }

            return const HomeScreen();
          },
        );
      },
    );
  }

  Future<_ProfileResult> _safeGetProfile(String uid) async {
    try {
      final user = await AuthService().getUserProfile(uid);
      return _ProfileResult(user: user);
    } on FirebaseException catch (e) {
      if (e.code == 'permission-denied') {
        return _ProfileResult(permissionDenied: true);
      }
      return _ProfileResult();
    } catch (_) {
      // Missing profile doc → user is null → rejectionMessageFor returns the
      // "Rider profile not found" message.
      return _ProfileResult();
    }
  }
}

class _ProfileResult {
  final AppUser? user;
  final bool permissionDenied;
  _ProfileResult({this.user, this.permissionDenied = false});
}
