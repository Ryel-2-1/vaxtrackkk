import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/models/delivery.dart';
import 'package:vaxtrack_mobile/theme/app_theme.dart';
import 'package:vaxtrack_mobile/widgets/dashboard_delivery_card.dart';
import 'package:vaxtrack_mobile/widgets/delivery_list_card.dart';
import 'package:vaxtrack_mobile/widgets/requested_arrival_text.dart';

Delivery _delivery({bool legacy = false}) => Delivery.fromFirestore('qa', {
  'orderNumber': 'VT-ORD-1793090256269-PQUB',
  'clinicName': 'A long QA clinic name for a narrow physical phone',
  'clinicAddress': 'A long destination address that wraps naturally',
  'vaccineName': 'QA Vaccine',
  'quantity': 3,
  'status': 'in_transit',
  'tripId': 'trip',
  'stopSequence': 1,
  'tripStopCount': 2,
  'stopEtaText': '10:45 AM',
  if (!legacy) ...{
    'requestedDeliveryDate': '2026-10-28',
    'requestedArrival': {
      'version': 1,
      'mode': 'window',
      'start': '10:00',
      'end': '11:00',
    },
  },
});

Future<void> _pump(
  WidgetTester tester,
  Widget card, {
  double width = 320,
  double scale = 1,
}) async {
  tester.view.physicalSize = Size(width * 3, 2400);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.theme,
      home: MediaQuery.withClampedTextScaling(
        minScaleFactor: scale,
        maxScaleFactor: scale,
        child: Scaffold(
          body: ListView(padding: const EdgeInsets.all(16), children: [card]),
        ),
      ),
    ),
  );
}

void main() {
  final builders = <String, Widget Function(Delivery)>{
    'delivery list': (d) => DeliveryListCard(delivery: d),
    'dashboard': (d) => DashboardDeliveryCard(delivery: d),
  };
  for (final entry in builders.entries) {
    for (final width in [320.0, 412.0]) {
      for (final scale in [1.0, 1.6]) {
        testWidgets('${entry.key}: request wraps at $width dp / $scale text', (
          tester,
        ) async {
          final delivery = _delivery();
          await _pump(
            tester,
            entry.value(delivery),
            width: width,
            scale: scale,
          );
          expect(tester.takeException(), isNull);
          final finder = find.text(delivery.requestedArrivalNote);
          expect(finder, findsOneWidget);
          final text = tester.widget<Text>(finder);
          expect(text.maxLines, isNull);
          expect(text.overflow, isNot(TextOverflow.ellipsis));
          final paragraph = tester.renderObject<RenderParagraph>(finder);
          expect(paragraph.didExceedMaxLines, isFalse);
          final rect = tester.getRect(finder);
          expect(rect.left, greaterThanOrEqualTo(0));
          expect(rect.right, lessThanOrEqualTo(width));
          expect(find.text('In Transit'), findsOneWidget);
          if (entry.key == 'dashboard') {
            expect(find.textContaining('ETA 10:45 AM'), findsOneWidget);
          }
        });
      }
    }
    testWidgets('${entry.key}: old orders never invent a window', (
      tester,
    ) async {
      await _pump(tester, entry.value(_delivery(legacy: true)));
      expect(find.text('Requested arrival: not specified'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('request text keeps the planning disclaimer accessible', (
    tester,
  ) async {
    await _pump(tester, RequestedArrivalText(delivery: _delivery()));
    final tooltip = tester.widget<Tooltip>(find.byType(Tooltip));
    expect(tooltip.message, contains('not a guaranteed ETA'));
    expect(tooltip.message, contains('Philippine time'));
  });
}
