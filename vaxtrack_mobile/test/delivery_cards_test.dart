import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/models/delivery.dart';
import 'package:vaxtrack_mobile/theme/app_theme.dart';
import 'package:vaxtrack_mobile/widgets/dashboard_delivery_card.dart';
import 'package:vaxtrack_mobile/widgets/delivery_list_card.dart';
import 'package:vaxtrack_mobile/widgets/order_number_text.dart';

// The number from the physical-phone report, which wrapped across three lines
// in the Completed tab.
const longNumber = 'VT-ORD-17910141845935-59WI';

Delivery delivery({
  String orderNumber = longNumber,
  String status = 'delivered',
  String statusLabel = 'Delivered',
  String priority = 'Standard',
  String clinicName = 'Laguna Provincial Hospital and Medical Center Annex',
  String clinicAddress =
      'Unit 4B, 1234 National Highway corner Rizal Avenue, Barangay San Isidro',
  String vaccineName = 'Pneumococcal Polysaccharide Conjugate Vaccine (13-valent)',
  String? tripId,
  int? stopSequence,
  int? tripStopCount,
  String? stopEtaText,
}) =>
    Delivery(
      id: 'doc1',
      orderNumber: orderNumber,
      clinicName: clinicName,
      clinicAddress: clinicAddress,
      vaccineName: vaccineName,
      quantity: 1200,
      unit: 'vials',
      priority: priority,
      status: status,
      statusLabel: statusLabel,
      tripId: tripId,
      stopSequence: stopSequence,
      tripStopCount: tripStopCount,
      stopEtaText: stopEtaText,
    );

/// Pump [card] in a phone of logical [width], under the app theme and the
/// same 16dp list padding the screens use.
Future<void> pumpCard(
  WidgetTester tester,
  Widget card, {
  double width = 360,
  double textScale = 1.0,
}) async {
  tester.view.physicalSize = Size(width * 3, 2400);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.theme,
      home: MediaQuery.withClampedTextScaling(
        minScaleFactor: textScale,
        maxScaleFactor: textScale,
        child: Scaffold(
          body: ListView(padding: const EdgeInsets.all(16), children: [card]),
        ),
      ),
    ),
  );
}

RenderParagraph paragraphOf(WidgetTester tester, String text) =>
    tester.renderObject<RenderParagraph>(find.text(text));

/// The order number is laid out whole, on one line, unclipped.
void expectWholeOnOneLine(WidgetTester tester, {String number = longNumber}) {
  final finder = find.text(number);
  expect(finder, findsOneWidget, reason: 'the full number is rendered');
  final text = tester.widget<Text>(finder);
  expect(text.overflow, isNot(TextOverflow.ellipsis));
  expect(text.maxLines, 1, reason: 'never wraps mid-identifier');

  final p = paragraphOf(tester, number);
  expect(p.didExceedMaxLines, isFalse, reason: 'not cut off');
  // One line: the laid-out height is a single line of the text's own style.
  final lineHeight = p.getFullHeightForCaret(const TextPosition(offset: 0));
  expect(p.size.height, closeTo(lineHeight, 0.5));
  expect(p.size.width, greaterThanOrEqualTo(p.getMaxIntrinsicWidth(double.infinity) - 0.5),
      reason: 'laid out at its natural width — nothing hidden');
}

/// The card's visible surface (the Card widget's own rect includes its margin).
Rect cardSurface(WidgetTester tester) => tester.getRect(
    find.descendant(of: find.byType(Card), matching: find.byType(Material)).first);

/// The scaled number's on-screen box sits inside the card, horizontally.
void expectInsideCard(WidgetTester tester, String number) {
  final card = cardSurface(tester);
  // The on-screen (post-scaling) box of the text itself.
  final shown = tester.getRect(find.text(number));
  expect(shown.left, greaterThanOrEqualTo(card.left));
  expect(shown.right, lessThanOrEqualTo(card.right + 0.01));
  final screen = tester.view.physicalSize.width / tester.view.devicePixelRatio;
  expect(card.right, lessThanOrEqualTo(screen), reason: 'no horizontal overflow');
}

void main() {
  group('Deliveries tabs card (Active / Completed / All)', () {
    for (final width in [320.0, 360.0, 393.0, 412.0]) {
      testWidgets('a long order number stays whole at ${width.toInt()}dp',
          (tester) async {
        await pumpCard(tester, DeliveryListCard(delivery: delivery()), width: width);

        expect(tester.takeException(), isNull, reason: 'no RenderFlex overflow');
        expectWholeOnOneLine(tester);
        expectInsideCard(tester, longNumber);
      });
    }

    testWidgets('the status chip no longer shares a row with the number',
        (tester) async {
      await pumpCard(tester, DeliveryListCard(delivery: delivery()));

      final number = tester.getRect(find.byType(OrderNumberText));
      final chip = tester.getRect(find.byKey(const ValueKey('delivery-status-chip')));
      expect(chip.top, greaterThanOrEqualTo(number.bottom), reason: 'below, not beside');
      expect(number.overlaps(chip), isFalse);
      // The number gets the WHOLE content column — card width minus the 16dp
      // paddings, the 44dp icon and its 12dp gap — not what a chip left over.
      expect(number.width, closeTo(cardSurface(tester).width - 16 * 2 - 44 - 12, 0.5));
    });

    testWidgets('destination, vaccine, quantity and status stay readable',
        (tester) async {
      await pumpCard(tester, DeliveryListCard(delivery: delivery()), width: 320);

      expect(tester.takeException(), isNull);
      final d = delivery();
      for (final text in [
        d.clinicName,
        '${d.vaccineName} · 1200 vials',
        'Delivered',
      ]) {
        expect(find.text(text), findsOneWidget, reason: text);
        expect(paragraphOf(tester, text).didExceedMaxLines, isFalse, reason: text);
      }
    });

    testWidgets('the delivered chip keeps the green status styling', (tester) async {
      await pumpCard(tester, DeliveryListCard(delivery: delivery()));
      final chip = tester.widget<Container>(find.byKey(const ValueKey('delivery-status-chip')));
      expect((chip.decoration! as BoxDecoration).color, AppColors.primaryLight);
      expect(tester.widget<Text>(find.text('Delivered')).style!.color, AppColors.primary);
    });

    testWidgets('large system text scales the number to fit instead of wrapping',
        (tester) async {
      await pumpCard(tester, DeliveryListCard(delivery: delivery()),
          width: 320, textScale: 1.6);

      expect(tester.takeException(), isNull);
      expectWholeOnOneLine(tester);
      expectInsideCard(tester, longNumber);
    });

    testWidgets('tapping the card still opens the delivery', (tester) async {
      var taps = 0;
      await pumpCard(tester, DeliveryListCard(delivery: delivery(), onTap: () => taps++));
      await tester.tap(find.byType(DeliveryListCard));
      expect(taps, 1);
    });

    testWidgets('a short order number is unchanged in size', (tester) async {
      await pumpCard(tester, DeliveryListCard(delivery: delivery(orderNumber: 'VT-ORD-1')));
      // Fits, so it is drawn at its natural size — no scaling.
      final shown = tester.getRect(find.text('VT-ORD-1'));
      expect(shown.width, closeTo(paragraphOf(tester, 'VT-ORD-1').size.width, 0.5));
    });
  });

  group('Dashboard card', () {
    for (final width in [320.0, 360.0, 412.0]) {
      testWidgets('a long order number is whole, not ellipsized, at ${width.toInt()}dp',
          (tester) async {
        await pumpCard(
          tester,
          DashboardDeliveryCard(
            delivery: delivery(status: 'in_transit', statusLabel: 'In Transit', priority: 'Urgent'),
          ),
          width: width,
        );

        expect(tester.takeException(), isNull, reason: 'no RenderFlex overflow');
        expectWholeOnOneLine(tester);
        expectInsideCard(tester, longNumber);
      });
    }

    testWidgets('both badges are fully visible and below the number', (tester) async {
      await pumpCard(
        tester,
        DashboardDeliveryCard(
          delivery: delivery(status: 'in_transit', statusLabel: 'In Transit', priority: 'Urgent'),
        ),
        width: 320,
      );

      final number = tester.getRect(find.byType(OrderNumberText));
      final badges = tester.getRect(find.byKey(const ValueKey('delivery-badges')));
      expect(badges.top, greaterThanOrEqualTo(number.bottom));
      for (final label in ['Urgent', 'In Transit']) {
        expect(find.text(label), findsOneWidget);
        expect(paragraphOf(tester, label).didExceedMaxLines, isFalse, reason: label);
        final r = tester.getRect(find.text(label));
        expect(r.overlaps(number), isFalse, reason: label);
        expect(r.right, lessThanOrEqualTo(cardSurface(tester).right));
      }
    });

    testWidgets('trip stop chip, long names and the delivered row lay out cleanly',
        (tester) async {
      await pumpCard(
        tester,
        DashboardDeliveryCard(
          delivery: delivery(
            tripId: 't1',
            stopSequence: 3,
            tripStopCount: 12,
            stopEtaText: '10:45 AM (rider is running about 20 minutes late)',
          ),
        ),
        width: 320,
      );

      expect(tester.takeException(), isNull);
      expectWholeOnOneLine(tester);
      expect(find.textContaining('Stop 3 of 12'), findsOneWidget);
      // "Delivered" appears twice: the status badge and the delivered row.
      expect(find.text('Delivered'), findsNWidgets(2));
    });
  });

  testWidgets('OrderNumberText keeps the real string for screen readers',
      (tester) async {
    await pumpCard(tester, const OrderNumberText(longNumber), width: 240);
    expect(find.bySemanticsLabel(longNumber), findsOneWidget);
  });
}
