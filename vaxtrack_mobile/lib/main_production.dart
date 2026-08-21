import 'bootstrap.dart';
import 'environment.dart';

/// Production entrypoint — Firebase project `vaxtrack-bef1b`.
///
/// Run:   flutter run   --flavor production -t lib/main_production.dart
/// Build: flutter build apk --debug --flavor production -t lib/main_production.dart
void main() => bootstrapAndRun(EnvConfig.production);
