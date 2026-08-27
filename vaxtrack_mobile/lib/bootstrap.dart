import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_core/firebase_core.dart';
import 'app.dart';
import 'environment.dart';
import 'firebase_options.dart';

/// Upper bound for the on-device Firestore offline cache.
///
/// On Android, FlutterFire already enables disk persistence by default, so
/// previously-loaded rider data (assigned deliveries, order/clinic details,
/// saved route) is readable offline out of the box. We still set this
/// explicitly to (a) document the intent and (b) pin a BOUNDED cache — never
/// [Settings.CACHE_SIZE_UNLIMITED]. 40 MB is far more than a rider's handful of
/// orders needs and stays inside the SDK's allowed 1 MB–100 MB range.
const int _firestoreCacheBytes = 40 * 1024 * 1024;

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
    // Configure the offline cache BEFORE any Firestore read/listener runs.
    _configureFirestorePersistence();
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

/// Enable Firestore offline persistence with an explicit, bounded cache.
///
/// Ordering: runs after `Firebase.initializeApp` and before the first Firestore
/// read/listener (`bootstrapAndRun` calls it before `runApp`, and no Firestore
/// access happens before that) — which is when the SDK requires cache settings
/// to be applied.
///
/// Error handling: applying explicit settings is best-effort and must NEVER
/// crash startup. Android already enables disk persistence by default, so even
/// if this fails the app still runs on a safe, persistent cache. Note the Dart
/// setter only STORES the settings; the SDK's "settings must be set before
/// first use" rule is enforced natively on the first Firestore call, so the
/// dev-only hot-restart case does not surface at this call site. We therefore
/// do not attempt to classify a specific "already configured" error here — any
/// unexpected synchronous failure is logged (in all build modes; a Firestore
/// *settings* error carries no secrets) and startup continues on the default
/// persistence rather than being silently swallowed or turned into a crash.
void _configureFirestorePersistence() {
  try {
    FirebaseFirestore.instance.settings = const Settings(
      persistenceEnabled: true,
      cacheSizeBytes: _firestoreCacheBytes,
    );
  } catch (e) {
    debugPrint(
      '[VaxTrack] Could not apply explicit Firestore cache settings; '
      'continuing on default persistence: $e',
    );
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
