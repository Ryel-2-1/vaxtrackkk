import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/utils/google_maps_url.dart';

/// Which route each Rider screen shows, and what it claims about it.
///
/// The saved VaxTrack plan (Valhalla motorcycle route, checked by the web for
/// highway / toll road / ferry flags) is the only route described as checked,
/// and the only route deviation is measured against. Google's directions —
/// the Maps hand-off — are Google's own route and are labelled that way.
/// The in-app Google Navigation SDK spike was removed on 2026-11-09.
String read(String path) => File(path).readAsStringSync().replaceAll('\r\n', '\n');

Iterable<File> dartFiles(String dir) =>
    Directory(dir).listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart'));

String rel(File f) => f.path.replaceAll('\\', '/');

void main() {
  test('there is no in-app Google Navigation: no package, no screen, no Maps key', () {
    expect(read('pubspec.yaml').contains('google_navigation_flutter'), isFalse);
    expect(File('lib/screens/google_navigation_screen.dart').existsSync(), isFalse);
    expect(Directory('lib/dev').existsSync(), isFalse);
    for (final file in dartFiles('lib')) {
      expect(read(rel(file)).contains('google_navigation'), isFalse, reason: rel(file));
    }
    expect(read('android/app/src/main/AndroidManifest.xml').contains('geo.API_KEY'), isFalse);
  });

  test('deviation is decided only on the server: the Rider app keeps no detector and writes no alerts', () {
    for (final gone in [
      'lib/utils/deviation_detector.dart',
      'lib/utils/route_compliance_monitor.dart',
      'lib/utils/route_monitor.dart',
      'lib/services/route_deviation_alert_service.dart',
    ]) {
      expect(File(gone).existsSync(), isFalse, reason: gone);
    }
    final alertsCollection = RegExp(r"""collection\(\s*['"]alerts['"]""");
    for (final file in dartFiles('lib')) {
      expect(alertsCollection.hasMatch(read(rel(file))), isFalse, reason: rel(file));
    }
  });

  test('Rider route screens describe the saved plan through one selector', () {
    final detail = read('lib/screens/delivery_detail_screen.dart');
    expect(detail, contains('final plan = SavedRoutePlan.of(d);'));
    expect(detail, contains('routePolyline: plan.encodedPolyline,'));
    expect(detail.contains('routePolyline: d.routePolyline'), isFalse, reason: 'never the leg when the plan is the trip');
    expect(detail, contains('_etaCard(plan)'));
    final route = read('lib/screens/route_monitoring_screen.dart');
    // The plan is SavedRoutePlan.of(d), decoded once per order update.
    expect(route, contains('_planCache = SavedRoutePlan.of(d);'));
    expect(route.contains('compliancePolyline('), isFalse);
    expect(route.contains('routeDescription('), isFalse);
    // The plan follows the live order, so a re-plan replaces the line.
    expect(route, contains('DeliveryService().riderDeliveries(uid).listen(_onDeliveries'));
    expect(route, contains('_planChanges.observe(_plan.fingerprint)'));
    final dashboard = read('lib/screens/dashboard_screen.dart');
    expect(dashboard, contains('SavedRoutePlan.of(first).label'));
  });

  test('every Google Maps hand-off says Google picks its own roads', () {
    expect(googleRouteNote, contains('may differ from the VaxTrack plan'));
    for (final path in [
      'lib/screens/delivery_detail_screen.dart',
      'lib/screens/dashboard_screen.dart',
      'lib/screens/route_monitoring_screen.dart',
    ]) {
      expect(read(path), contains('googleRouteNote'), reason: path);
      expect(read(path), contains("'Turn-by-turn in Google Maps'"), reason: path);
    }
  });

  test('no Rider screen calls any route safe or compliant', () {
    final claim = RegExp(r"""['"][^'"\n]*\b(motorcycle[- ]safe|safe route|compliant)\b[^'"\n]*['"]""", caseSensitive: false);
    for (final dir in ['lib/screens', 'lib/widgets', 'lib/utils']) {
      for (final file in dartFiles(dir)) {
        // Strings only: comments may discuss the claims being avoided.
        final code = read(rel(file)).split('\n').where((l) => !l.trimLeft().startsWith('//')).join('\n');
        final match = claim.firstMatch(code);
        expect(match, isNull, reason: '${rel(file)}: ${match?.group(0)}');
      }
    }
  });
}

