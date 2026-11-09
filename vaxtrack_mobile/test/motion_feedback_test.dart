import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/screens/proof_submission_controller.dart';
import 'package:vaxtrack_mobile/theme/app_theme.dart';
import 'package:vaxtrack_mobile/widgets/complete_delivery_confirm_sheet.dart';
import 'package:vaxtrack_mobile/widgets/motion.dart';

/// Motion in the Rider app is feedback: it must show the delivered moment,
/// show progress that only moves forward, and still say everything when the
/// rider has turned animations off.
void main() {
  Future<bool? Function()> openSheet(
    WidgetTester tester, {
    required Future<void> Function() onConfirm,
    bool animationsOff = false,
  }) async {
    bool? popped;
    var closed = false;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.theme,
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: animationsOff),
          child: child!,
        ),
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

  for (final animationsOff in [false, true]) {
    testWidgets(
      'a confirmed completion shows "Delivered", then closes as completed '
      '(animations ${animationsOff ? 'off' : 'on'})',
      (tester) async {
        final result = await openSheet(tester, onConfirm: () async {}, animationsOff: animationsOff);
        await tester.tap(find.text('Confirm Delivery'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
        expect(find.byType(DeliveredMark), findsOneWidget);
        expect(find.text('Delivered'), findsOneWidget);
        expect(result(), isNull, reason: 'the mark is seen before the sheet closes');
        await tester.pumpAndSettle();
        expect(result(), isTrue);
        expect(find.byType(DeliveredMark), findsNothing);
      },
    );
  }

  testWidgets('a failed completion never shows the delivered mark', (tester) async {
    final result = await openSheet(tester, onConfirm: () async => throw Exception('Not enough stock.'));
    await tester.tap(find.text('Confirm Delivery'));
    await tester.pumpAndSettle();
    expect(find.byType(DeliveredMark), findsNothing);
    expect(find.textContaining('Not enough stock'), findsOneWidget);
    expect(result(), isNull);
  });

  test('progress only moves forward through a submission', () {
    final source = File('lib/screens/proof_submission_controller.dart').readAsStringSync();
    double at(String phase) {
      final m = RegExp('case ProofPhase\\.$phase:\\s*return ([0-9.]+);').firstMatch(
        source.substring(source.indexOf('double? get progressFraction')),
      );
      return double.parse(m!.group(1)!);
    }

    final complete = ['checkingLocation', 'uploadingProof', 'uploadingInvoice', 'completing'].map(at).toList();
    final proofOnly = ['preparing', 'uploadingPhoto', 'savingDetails'].map(at).toList();
    for (final steps in [complete, proofOnly]) {
      for (var i = 1; i < steps.length; i++) {
        expect(steps[i], greaterThan(steps[i - 1]));
      }
      expect(steps.last, lessThan(1.0), reason: 'never full before the server confirms');
    }
    expect(ProofPhase.values, contains(ProofPhase.completing));
  });

  testWidgets('the progress bar and label show with animations off', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: MediaQuery(
          data: MediaQueryData(disableAnimations: true),
          child: Scaffold(body: SubmissionProgress(text: 'Uploading proof photo (1 of 2)…', fraction: 0.3)),
        ),
      ),
    );
    expect(find.text('Uploading proof photo (1 of 2)…'), findsOneWidget);
    final bar = tester.widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator));
    expect(bar.value, closeTo(0.3, 0.001), reason: 'no tween to wait for when animations are off');
  });

  testWidgets('a feedback message appears, and leaves when cleared', (tester) async {
    Widget host(String? message) => MaterialApp(
          home: Scaffold(
            body: FeedbackReveal(identity: message, child: message == null ? null : Text(message)),
          ),
        );
    await tester.pumpWidget(host(null));
    expect(find.byType(Text), findsNothing);
    await tester.pumpWidget(host('Invalid email or password.'));
    await tester.pumpAndSettle();
    expect(find.text('Invalid email or password.'), findsOneWidget);
    await tester.pumpWidget(host(null));
    await tester.pumpAndSettle();
    expect(find.text('Invalid email or password.'), findsNothing);
  });
}
