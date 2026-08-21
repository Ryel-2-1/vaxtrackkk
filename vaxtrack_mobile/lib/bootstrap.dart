import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:firebase_core/firebase_core.dart';
import 'app.dart';
import 'environment.dart';
import 'firebase_options.dart';

/// Shared startup used by every entrypoint (`main.dart`, `main_production.dart`,
/// `main_staging.dart`).
///
/// It initializes Firebase for [config], verifies the connected project id
/// matches the environment's REQUIRED project, prints a minimal one-line summary
/// in debug builds, then runs the app. On ANY failure — including a project
/// mismatch — it shows a clear startup-error screen and never runs the real app
/// against the wrong Firebase project (no silent staging→production fallback).
Future<void> bootstrapAndRun(EnvConfig config) async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    final projectId = await _initFirebaseProjectId(config);
    // Hard gate: refuse to continue unless we are on the expected project.
    assertProjectMatches(config, projectId);
    if (kDebugMode) {
      // Debug-only and deliberately minimal: environment + projectId ONLY.
      // Never log API keys, tokens, or the full FirebaseOptions.
      debugPrint(
        '[VaxTrack] environment=${config.label} '
        'firebaseProjectId=$projectId',
      );
    }
    runApp(const VaxTrackRiderApp());
  } catch (e, stack) {
    debugPrint('Startup failed for ${config.label} environment: $e\n$stack');
    runApp(StartupErrorApp(environment: config.label, error: e.toString()));
  }
}

/// Initialize the default Firebase app for [config] and return its projectId.
///
///  * Android: initialize from the native `google-services.json` that the Gradle
///    `com.google.gms.google-services` plugin baked in for the SELECTED FLAVOR
///    (production → `android/app/google-services.json`, staging →
///    `android/app/src/staging/google-services.json`). No Dart options are
///    passed, so no staging Firebase secrets ever live in committed Dart.
///  * Other platforms (iOS / desktop / tests): only the committed PRODUCTION Dart
///    options exist. A staging run on such a target therefore has no committed
///    config and will FAIL the projectId assertion in [bootstrapAndRun] rather
///    than silently using production.
Future<String> _initFirebaseProjectId(EnvConfig config) async {
  FirebaseApp app;
  try {
    if (defaultTargetPlatform == TargetPlatform.android) {
      // Native default → the flavor's google-services.json.
      app = await Firebase.initializeApp();
    } else {
      app = await Firebase.initializeApp(
        options: DefaultFirebaseOptions.currentPlatform,
      );
    }
  } on FirebaseException catch (e) {
    // A hot-restart / double init can report the default app already exists.
    if (e.code == 'duplicate-app') {
      app = Firebase.app();
    } else {
      rethrow;
    }
  }
  return app.options.projectId;
}
