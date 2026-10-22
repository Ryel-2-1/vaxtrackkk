import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/theme/app_theme.dart';
import 'package:vaxtrack_mobile/widgets/complete_delivery_confirm_sheet.dart';

/// The final confirmation before a Rider settles a delivery. It owns the submit
/// lifecycle, so these prove it never claims completion before the trusted
/// [onConfirm] resolves, cannot be double-fired, and stays open on failure.
///
/// [onConfirm] is a plain fake here — the sheet contains no Firebase or upload
/// code — so the whole destructive-action safety is exercised without a device.
void main() {
  // Opens the sheet over a Navigator and returns the tester + a getter for the
  // bool the sheet pops with (null until it closes).
  Future<bool? Function()> openSheet(
    WidgetTester tester, {
    required Future<void> Function() onConfirm,
  }) async {
    bool? popped;
    bool closed = false;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () async {
                  popped = await showModalBottomSheet<bool>(
                    context: context,
                    isScrollControlled: true,
                    builder: (_) => CompleteDeliveryConfirmSheet(
                      orderNumber: 'VT-ORD-9001',
                      destinationTitle: 'Sample Clinic',
                      destinationSubtitle: '1 Sample St',
                      proofImageUrl: 'https://example.test/proof.jpg',
                      invoiceImageUrl: 'https://example.test/invoice.jpg',
                      onConfirm: onConfirm,
                    ),
                  );
                  closed = true;
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    return () => closed ? popped : null;
  }

  testWidgets(
    'shows the order, both evidence labels and the settlement warning',
    (tester) async {
      await openSheet(tester, onConfirm: () async {});
      expect(find.text('Complete this delivery?'), findsOneWidget);
      expect(find.text('Order VT-ORD-9001'), findsOneWidget);
      expect(find.text('Sample Clinic'), findsOneWidget);
      expect(find.text('Proof of delivery'), findsOneWidget);
      expect(find.text('Invoice'), findsOneWidget);
      expect(find.textContaining('settles'), findsOneWidget);
      expect(find.text('Confirm Delivery'), findsOneWidget);
      expect(find.text('Go Back'), findsOneWidget);
    },
  );

  // 5. Cancelling performs no completion.
  testWidgets('Go Back closes without confirming', (tester) async {
    var confirmCalls = 0;
    final result = await openSheet(
      tester,
      onConfirm: () async => confirmCalls++,
    );
    await tester.tap(find.text('Go Back'));
    await tester.pumpAndSettle();
    expect(confirmCalls, 0);
    expect(result(), isFalse);
  });

  // 6 + 10. Confirm runs onConfirm once and pops true only after it resolves.
  testWidgets('Confirm runs completion once and reports success', (
    tester,
  ) async {
    var confirmCalls = 0;
    final result = await openSheet(
      tester,
      onConfirm: () async => confirmCalls++,
    );
    await tester.tap(find.text('Confirm Delivery'));
    await tester.pumpAndSettle();
    expect(confirmCalls, 1);
    expect(result(), isTrue);
  });

  // 7. Repeated taps do not start a second submission: while the first is in
  // flight the confirm button is disabled and shows a spinner, so it cannot be
  // fired again (the controller also guards synchronously — covered separately).
  testWidgets('confirm is disabled while a completion is committing', (
    tester,
  ) async {
    var confirmCalls = 0;
    final gate = Completer<void>();
    await openSheet(
      tester,
      onConfirm: () async {
        confirmCalls++;
        await gate.future; // hold the first call open
      },
    );
    await tester.tap(find.text('Confirm Delivery'));
    await tester.pump(); // enter submitting state, do not settle

    // The label is replaced by a spinner, and the button is disabled.
    expect(find.text('Confirm Delivery'), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    final confirmButton = tester.widget<ElevatedButton>(
      find.ancestor(
        of: find.byType(CircularProgressIndicator),
        matching: find.byType(ElevatedButton),
      ),
    );
    expect(confirmButton.onPressed, isNull);
    // Go Back is disabled too, so it cannot cancel out mid-commit.
    final goBack = tester.widget<OutlinedButton>(find.byType(OutlinedButton));
    expect(goBack.onPressed, isNull);

    gate.complete();
    await tester.pumpAndSettle();
    expect(confirmCalls, 1);
  });

  // 9. Completion failure does not show a completed state; the sheet stays open.
  testWidgets('a failed completion stays open and shows the message', (
    tester,
  ) async {
    final result = await openSheet(
      tester,
      onConfirm: () async {
        throw Exception('There is not enough stock in that batch.');
      },
    );
    await tester.tap(find.text('Confirm Delivery'));
    await tester.pumpAndSettle();
    // Not popped, message shown, and the button is available to retry.
    expect(result(), isNull);
    expect(find.textContaining('not enough stock'), findsOneWidget);
    expect(find.text('Confirm Delivery'), findsOneWidget);
  });

  // 8 + 10. Only after the awaited completion resolves does the sheet close.
  testWidgets('does not close before the completion resolves', (tester) async {
    final gate = Completer<void>();
    final result = await openSheet(tester, onConfirm: () async => gate.future);
    await tester.tap(find.text('Confirm Delivery'));
    await tester.pump();
    // Still open while the completion is in flight.
    expect(result(), isNull);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    gate.complete();
    await tester.pumpAndSettle();
    expect(result(), isTrue);
  });

  // The two actions as laid out on a phone: a matched pair at every width and
  // text size. Measured from the rendered buttons (not the source).
  group('the Go Back / Submit & Complete pair', () {
    // Real Roboto (the Android default; the app sets no font family) from the
    // Flutter SDK. Widgets in tests always render in the built-in test font,
    // so the one-line check measures the label in Roboto explicitly against
    // the RENDERED button's inner width. If unavailable, that check skips.
    var roboto = false;
    setUpAll(() async {
      final dir = Directory(
        '${Platform.environment['FLUTTER_ROOT'] ?? ''}/bin/cache/artifacts/material_fonts',
      );
      final files = [
        'roboto-regular.ttf',
        'roboto-medium.ttf',
        'roboto-bold.ttf',
      ].map((n) => File('${dir.path}/$n')).toList();
      if (!files.every((f) => f.existsSync())) return;
      final loader = FontLoader('Roboto');
      for (final f in files) {
        loader.addFont(
          Future.value(
            ByteData.view(Uint8List.fromList(f.readAsBytesSync()).buffer),
          ),
        );
      }
      await loader.load();
      roboto = true;
    });

    Future<void> openProofSheet(
      WidgetTester tester, {
      required double width,
      required double textScale,
      Completer<void>? hold,
    }) async {
      tester.view.physicalSize = Size(width, 1600);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.theme,
          home: MediaQuery(
            data: MediaQueryData(
              size: Size(width, 1600),
              textScaler: TextScaler.linear(textScale),
            ),
            child: Builder(
              builder: (context) => Scaffold(
                body: Center(
                  child: ElevatedButton(
                    onPressed: () => showModalBottomSheet<bool>(
                      context: context,
                      isScrollControlled: true,
                      builder: (_) => CompleteDeliveryConfirmSheet(
                        orderNumber: 'VT-ORD-17910141845935-59WI',
                        destinationTitle: 'Sample Clinic',
                        destinationSubtitle: '1 Sample St',
                        proofImageUrl: 'https://example.test/proof.jpg',
                        invoiceImageUrl: 'https://example.test/invoice.jpg',
                        title: 'Submit proof & complete this delivery?',
                        confirmLabel: 'Submit & Complete',
                        onConfirm: () => hold?.future ?? Future<void>.value(),
                      ),
                    ),
                    child: const Text('open'),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
    }

    final back = find.widgetWithText(OutlinedButton, 'Go Back');
    final submit = find.byType(ElevatedButton).last;

    void expectMatchedPair(
      WidgetTester tester,
      double width, {
      bool checkSubmitLabel = true,
    }) {
      final b = tester.getRect(back);
      final s = tester.getRect(submit);
      expect(
        b.width,
        moreOrLessEquals(s.width, epsilon: 0.01),
        reason: 'equal width',
      );
      expect(
        b.top,
        moreOrLessEquals(s.top, epsilon: 0.01),
        reason: 'tops aligned',
      );
      expect(
        b.bottom,
        moreOrLessEquals(s.bottom, epsilon: 0.01),
        reason: 'bottoms aligned',
      );
      expect(b.height, greaterThanOrEqualTo(48));
      expect(
        s.left - b.right,
        moreOrLessEquals(12, epsilon: 0.01),
        reason: 'gap',
      );
      expect(
        b.left,
        moreOrLessEquals(20, epsilon: 0.01),
        reason: 'left margin',
      );
      expect(
        width - s.right,
        moreOrLessEquals(20, epsilon: 0.01),
        reason: 'right margin matches',
      );

      final labels = [
        find.text('Go Back'),
        if (checkSubmitLabel) find.text('Submit & Complete'),
      ];
      final buttons = [b, if (checkSubmitLabel) s];
      for (var i = 0; i < labels.length; i++) {
        final t = tester.getRect(labels[i]);
        expect(
          t.center.dx,
          moreOrLessEquals(buttons[i].center.dx, epsilon: 1),
          reason: 'centred horizontally',
        );
        expect(
          t.center.dy,
          moreOrLessEquals(buttons[i].center.dy, epsilon: 1),
          reason: 'centred vertically',
        );
        expect(
          buttons[i].contains(t.topLeft) &&
              buttons[i].contains(t.bottomRight - const Offset(0.01, 0.01)),
          isTrue,
          reason: 'label inside its button — not clipped',
        );
        final paragraph = tester.renderObject<RenderParagraph>(labels[i]);
        expect(paragraph.didExceedMaxLines, isFalse);
      }
      expect(tester.takeException(), isNull, reason: 'no overflow');
    }

    for (final width in [360.0, 320.0]) {
      for (final scale in [1.0, 1.3, 2.0]) {
        testWidgets(
          '${width.toInt()} dp, text ${scale}x: equal size, aligned edges, centred labels',
          (tester) async {
            await openProofSheet(tester, width: width, textScale: scale);
            expectMatchedPair(tester, width);
          },
        );
      }
    }

    testWidgets(
      '360 dp (vivo V2419), normal text: "Submit & Complete" stays on one line',
      (tester) async {
        if (!roboto) {
          markTestSkipped('Roboto not found in the Flutter SDK cache');
          return;
        }
        await openProofSheet(tester, width: 360, textScale: 1.0);
        final button = tester.getRect(submit);
        // The sheet's button text: 15 sp bold, in the phone's Roboto.
        final painter = TextPainter(
          text: const TextSpan(
            text: 'Submit & Complete',
            style: TextStyle(
              fontFamily: 'Roboto',
              fontSize: 15,
              fontWeight: FontWeight.w700,
            ),
          ),
          textDirection: TextDirection.ltr,
        )..layout();
        const horizontalPadding = 8.0 * 2;
        expect(
          painter.width,
          lessThanOrEqualTo(button.width - horizontalPadding),
          reason:
              'fits the rendered button on one line (it did not with the old 24 dp padding)',
        );
        expect(
          painter.width,
          greaterThan(button.width - 24.0 * 2),
          reason: 'sanity: the old padding wrapped it',
        );
      },
    );

    testWidgets(
      'while submitting: both disabled, spinner centred, the pair stays matched',
      (tester) async {
        final hold = Completer<void>();
        await openProofSheet(tester, width: 360, textScale: 1.0, hold: hold);
        await tester.tap(find.text('Submit & Complete'));
        await tester.pump();
        expect(tester.widget<OutlinedButton>(back).onPressed, isNull);
        expect(tester.widget<ElevatedButton>(submit).onPressed, isNull);
        expectMatchedPair(tester, 360, checkSubmitLabel: false);
        final button = tester.getRect(submit);
        final spinner = tester.getRect(
          find.descendant(
            of: submit,
            matching: find.byType(CircularProgressIndicator),
          ),
        );
        expect(
          spinner.center.dx,
          moreOrLessEquals(button.center.dx, epsilon: 1),
        );
        expect(
          spinner.center.dy,
          moreOrLessEquals(button.center.dy, epsilon: 1),
        );
        hold.complete();
        await tester.pumpAndSettle();
      },
    );
  });
}
