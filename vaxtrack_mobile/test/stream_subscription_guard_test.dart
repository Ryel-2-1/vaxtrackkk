import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// SUPPLEMENTARY source guards — they read the code, they do not run the UI.
/// The runtime behaviour (one subscription per Rider, no spinner after the
/// first load, safe errors, Retry reconnects, account change) is exercised by
/// rider_feed_builder_test.dart and rider_screen_feeds_test.dart. These only
/// stop the screens drifting back to the old pattern: a Firestore stream
/// created in build(), a bare StreamBuilder, or a raw error on screen.
void main() {
  const screens = [
    'lib/screens/dashboard_screen.dart',
    'lib/screens/deliveries_screen.dart',
    'lib/screens/profile_screen.dart',
    'lib/screens/proof_screen.dart',
  ];

  // Calls that CREATE a Firestore stream (a tear-off such as
  // `_deliveryService.riderDeliveries` handed to RiderFeedBuilder is fine).
  final streamFactory = RegExp(r'riderDeliveries(WithSync)?\(|userProfileStream\(|\.snapshots\(');

  for (final path in screens) {
    group(path.split('/').last, () {
      final src = File(path).readAsStringSync();
      final buildStart = src.indexOf('Widget build(BuildContext context)');
      final afterBuild = src.indexOf(RegExp(r'\n  (Widget|Future|void|String|bool|List) _'), buildStart);
      final build = src.substring(buildStart, afterBuild == -1 ? src.length : afterBuild);

      test('its feed goes through RiderFeedBuilder', () {
        expect(build, contains('RiderFeedBuilder<'));
        expect(src, isNot(contains('StreamBuilder<')), reason: 'no bare StreamBuilder on a Firestore feed');
      });

      test('build() creates no stream', () {
        expect(streamFactory.hasMatch(build), isFalse,
            reason: 'a stream created in build() resubscribes on every rebuild');
      });

      test('no raw error text on screen', () {
        expect(src, isNot(contains(RegExp(r'\$\{\s*\w*[sS]nap\w*\.error'))));
        expect(src, isNot(contains(RegExp(r'Text\([^)]*\.error'))));
      });
    });
  }
}
