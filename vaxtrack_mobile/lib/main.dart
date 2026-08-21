import 'bootstrap.dart';
import 'environment.dart';

/// Default entrypoint — starts the **production** environment (Firebase project
/// `vaxtrack-bef1b`). Kept for backwards compatibility with plain `flutter run`
/// workflows and tooling that assumes `lib/main.dart`.
///
/// Because Android product flavors now exist, an Android build/run must select a
/// flavor. Use one of:
///   * production: `flutter run --flavor production -t lib/main_production.dart`
///   * staging:    `flutter run --flavor staging    -t lib/main_staging.dart`
/// This file mirrors `main_production.dart` (it also starts production), so
/// `flutter run --flavor production -t lib/main.dart` behaves identically.
void main() => bootstrapAndRun(EnvConfig.production);
