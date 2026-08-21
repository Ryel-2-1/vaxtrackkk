// Pure, dependency-free build-environment configuration for the VaxTrack Rider
// app.
//
// This file intentionally imports NOTHING from Flutter or Firebase, so it can
// be unit-tested without a device, an emulator, or a Firebase connection. It
// encodes which Firebase project each environment is *allowed* to talk to, and
// the guard that refuses to start when the connected project does not match.
//
// No Firebase API keys / tokens / secrets live here — only project IDs, which
// are non-secret identifiers.

/// The two build environments the Rider app supports.
enum AppEnvironment { production, staging }

/// Thrown when the Firebase project the app actually connected to does not match
/// the project the selected [AppEnvironment] REQUIRES, or when the environment
/// itself is unknown/blank. This is never caught-and-ignored during startup: a
/// mismatch must stop the app rather than silently fall back to another project.
class EnvironmentMismatchException implements Exception {
  final String message;
  const EnvironmentMismatchException(this.message);

  @override
  String toString() => 'EnvironmentMismatchException: $message';
}

/// Immutable binding of an [AppEnvironment] to the single Firebase project id it
/// is permitted to use.
class EnvConfig {
  final AppEnvironment environment;

  /// The ONLY Firebase project id this environment may connect to.
  final String expectedProjectId;

  const EnvConfig({required this.environment, required this.expectedProjectId});

  /// Production → Firebase project `vaxtrack-bef1b`.
  static const EnvConfig production = EnvConfig(
    environment: AppEnvironment.production,
    expectedProjectId: 'vaxtrack-bef1b',
  );

  /// Staging → Firebase project `vaxtrack-staging`.
  static const EnvConfig staging = EnvConfig(
    environment: AppEnvironment.staging,
    expectedProjectId: 'vaxtrack-staging',
  );

  /// Human-readable label used in logs / the startup-error screen
  /// ("production" / "staging").
  String get label => environment.name;

  /// Resolve an environment by its string name (e.g. from a build flavor or a
  /// `--dart-define`). Anything that is not exactly a known environment — an
  /// unknown or blank name — throws, so it can never silently start.
  static EnvConfig fromName(String? name) {
    switch (name) {
      case 'production':
        return production;
      case 'staging':
        return staging;
      default:
        throw EnvironmentMismatchException(
          'Unknown environment "${name ?? ''}". '
          'Expected exactly "production" or "staging".',
        );
    }
  }
}

/// Assert that the Firebase project actually connected to ([actualProjectId])
/// matches the [config]'s required project.
///
/// Throws [EnvironmentMismatchException] on any mismatch or empty id. The caller
/// MUST NOT run the app when this throws — there is deliberately no
/// cross-environment fallback (staging never silently becomes production, and
/// vice versa).
void assertProjectMatches(EnvConfig config, String actualProjectId) {
  final actual = actualProjectId.trim();
  if (actual.isEmpty) {
    throw EnvironmentMismatchException(
      '${config.label} build could not determine a Firebase projectId '
      '(expected "${config.expectedProjectId}"). Refusing to start.',
    );
  }
  if (actual != config.expectedProjectId) {
    throw EnvironmentMismatchException(
      '${config.label} build connected to Firebase project "$actual" '
      'but is only allowed to use "${config.expectedProjectId}". '
      'Refusing to start (no cross-environment fallback).',
    );
  }
}
