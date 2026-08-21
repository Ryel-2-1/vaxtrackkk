import 'bootstrap.dart';
import 'environment.dart';

/// Staging entrypoint — Firebase project `vaxtrack-staging`
/// (applicationId `com.example.vaxtrack_mobile.staging`).
///
/// Run:   flutter run   --flavor staging -t lib/main_staging.dart
/// Build: flutter build apk --debug --flavor staging -t lib/main_staging.dart
void main() => bootstrapAndRun(EnvConfig.staging);
