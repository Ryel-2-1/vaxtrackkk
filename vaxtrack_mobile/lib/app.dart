import 'package:flutter/material.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'theme/app_theme.dart';
import 'screens/login_screen.dart';
import 'screens/home_screen.dart';
import 'screens/register_screen.dart';
import 'services/auth_service.dart';
import 'models/app_user.dart';

/// Root widget for the VaxTrack Rider app. Environment selection + Firebase
/// initialization happen in `bootstrap.dart` BEFORE this is mounted, so this
/// widget is environment-agnostic and unchanged across production/staging.
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

/// Shown when the app cannot start — Firebase failed to initialize OR the
/// connected Firebase project did not match the selected environment. It never
/// reveals API keys/options: only the environment label and a short message.
class StartupErrorApp extends StatelessWidget {
  final String environment;
  final String error;

  const StartupErrorApp({
    super.key,
    required this.environment,
    required this.error,
  });

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
                Text(
                  'Environment: $environment',
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: Colors.black87,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 8),
                const Text(
                  'Unable to start against the expected Firebase project. '
                  'Please check the build configuration and try again.',
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

/// Root gate: routes the signed-in user to the correct screen based on their
/// Firestore rider profile (unchanged from the previous single-entrypoint app).
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
