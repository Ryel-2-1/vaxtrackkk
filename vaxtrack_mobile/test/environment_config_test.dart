import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/environment.dart';

// Dependency-free tests for the environment/project guard. These import ONLY the
// pure `environment.dart` (no Flutter widgets, no Firebase), so they run under
// `flutter test` without a device or a Firebase connection.
void main() {
  group('EnvConfig expected project ids', () {
    test('production is bound to vaxtrack-bef1b', () {
      expect(EnvConfig.production.expectedProjectId, 'vaxtrack-bef1b');
      expect(EnvConfig.production.environment, AppEnvironment.production);
      expect(EnvConfig.production.label, 'production');
    });

    test('staging is bound to vaxtrack-staging', () {
      expect(EnvConfig.staging.expectedProjectId, 'vaxtrack-staging');
      expect(EnvConfig.staging.environment, AppEnvironment.staging);
      expect(EnvConfig.staging.label, 'staging');
    });
  });

  group('assertProjectMatches accepts the matching project', () {
    test('production accepts its own project id', () {
      expect(
        () => assertProjectMatches(EnvConfig.production, 'vaxtrack-bef1b'),
        returnsNormally,
      );
    });

    test('staging accepts its own project id', () {
      expect(
        () => assertProjectMatches(EnvConfig.staging, 'vaxtrack-staging'),
        returnsNormally,
      );
    });
  });

  group('assertProjectMatches rejects cross-environment projects', () {
    test('staging REJECTS the production project id', () {
      expect(
        () => assertProjectMatches(EnvConfig.staging, 'vaxtrack-bef1b'),
        throwsA(isA<EnvironmentMismatchException>()),
      );
    });

    test('production REJECTS the staging project id', () {
      expect(
        () => assertProjectMatches(EnvConfig.production, 'vaxtrack-staging'),
        throwsA(isA<EnvironmentMismatchException>()),
      );
    });

    test('an empty / whitespace project id is rejected', () {
      expect(
        () => assertProjectMatches(EnvConfig.production, ''),
        throwsA(isA<EnvironmentMismatchException>()),
      );
      expect(
        () => assertProjectMatches(EnvConfig.staging, '   '),
        throwsA(isA<EnvironmentMismatchException>()),
      );
    });

    test('an arbitrary unrelated project id is rejected', () {
      expect(
        () => assertProjectMatches(EnvConfig.production, 'some-other-project'),
        throwsA(isA<EnvironmentMismatchException>()),
      );
    });
  });

  group('EnvConfig.fromName rejects unknown / invalid environments', () {
    test('known names resolve to the canonical const configs', () {
      expect(EnvConfig.fromName('production'), same(EnvConfig.production));
      expect(EnvConfig.fromName('staging'), same(EnvConfig.staging));
    });

    test('an unknown name throws', () {
      expect(
        () => EnvConfig.fromName('qa'),
        throwsA(isA<EnvironmentMismatchException>()),
      );
    });

    test('null or blank names throw', () {
      expect(
        () => EnvConfig.fromName(null),
        throwsA(isA<EnvironmentMismatchException>()),
      );
      expect(
        () => EnvConfig.fromName(''),
        throwsA(isA<EnvironmentMismatchException>()),
      );
    });
  });
}
