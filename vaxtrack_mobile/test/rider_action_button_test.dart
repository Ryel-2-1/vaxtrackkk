import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/theme/app_theme.dart';
import 'package:vaxtrack_mobile/widgets/rider_action_button.dart';

/// The stacked Rider actions are one matching set, and the Proof screen does
/// not flash while the Rider types.
void main() {
  const labels = [
    kSubmitAndCompleteLabel,
    'Report Delay',
    'Report Delivery Failure',
    'Retry Completion',
  ];

  Future<void> pumpActions(WidgetTester tester, double scale, {double width = 360}) async {
    tester.view.physicalSize = Size(width, 1000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.theme,
      home: MediaQuery(
        data: MediaQueryData(size: Size(width, 1000), textScaler: TextScaler.linear(scale)),
        child: Scaffold(
          // Same page padding as Delivery Detail.
          body: ListView(padding: const EdgeInsets.all(16), children: [
            for (final l in labels)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: RiderActionButton(
                  key: ValueKey(l),
                  label: l,
                  icon: Icons.check_circle,
                  color: l.startsWith('Report') ? Colors.red : null,
                  onPressed: () {},
                ),
              ),
          ]),
        ),
      ),
    ));
  }

  group('stacked action buttons are symmetrical', () {
    for (final width in [320.0, 360.0, 412.0]) {
      for (final scale in [1.0, 1.3, 2.0]) {
        testWidgets('${width.toInt()} dp, text ${scale}x: same width and height, one line each', (tester) async {
          await pumpActions(tester, scale, width: width);
          expect(tester.takeException(), isNull, reason: 'no overflow');
          final sizes = [for (final l in labels) tester.getSize(find.byKey(ValueKey(l)))];
          for (final s in sizes) {
            expect(s.width, width - 32);
            expect(s.height, sizes.first.height, reason: 'every button matches the first one');
            expect(s.height, greaterThanOrEqualTo(kRiderActionButtonHeight));
          }
          for (final l in labels) {
            final text = tester.widget<Text>(find.text(l));
            expect(text.maxLines, 1, reason: '$l never wraps');
          }
        });
      }
    }
  });

  testWidgets('disabled and busy states keep the same size', (tester) async {
    tester.view.physicalSize = const Size(360, 600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    Widget button(Key key, {VoidCallback? onPressed, bool busy = false}) => RiderActionButton(
        key: key, label: kSubmitAndCompleteLabel, icon: Icons.check_circle, onPressed: onPressed, busy: busy);
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.theme,
      home: Scaffold(
        body: Column(children: [
          button(const ValueKey('on'), onPressed: () {}),
          button(const ValueKey('off')),
          button(const ValueKey('busy'), busy: true),
        ]),
      ),
    ));
    final on = tester.getSize(find.byKey(const ValueKey('on')));
    expect(tester.getSize(find.byKey(const ValueKey('off'))), on);
    expect(tester.getSize(find.byKey(const ValueKey('busy'))), on);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });

  test('Delivery Detail and the Proof screen use the shared button and label', () {
    final detail = File('lib/screens/delivery_detail_screen.dart').readAsStringSync();
    final proof = File('lib/screens/proof_screen.dart').readAsStringSync();
    for (final src in [detail, proof]) {
      expect(src, contains('RiderActionButton('));
      expect(src, contains('kSubmitAndCompleteLabel'));
      expect(src, isNot(contains("'Submit Proof & Complete Delivery'")));
    }
  });

  // SUPPLEMENTARY source guard (it reads the code; ProofScreen builds its own
  // Firebase services, so it is not pumped). The runtime behaviour of the
  // shared feed — subscribed once, no spinner after the first load — is
  // exercised in rider_feed_builder_test.dart.
  test('Proof screen: the deliveries feed is subscribed once, not in build() (white-flash regression)', () {
    final src = File('lib/screens/proof_screen.dart').readAsStringSync();
    final build = src.substring(src.indexOf('Widget build(BuildContext context)'));
    expect(build, contains('RiderFeedBuilder<List<Delivery>>('));
    expect(build, contains('open: _deliveryService.riderDeliveries,'));
    expect(build, isNot(contains('riderDeliveries(')),
        reason: 'a stream created in build() resubscribes on every keystroke');
  });
}
