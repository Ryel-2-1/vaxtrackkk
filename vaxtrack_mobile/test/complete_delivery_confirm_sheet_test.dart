import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
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

  testWidgets('shows the order, both evidence labels and the settlement warning',
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
  });

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
  testWidgets('Confirm runs completion once and reports success', (tester) async {
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
  testWidgets('confirm is disabled while a completion is committing',
      (tester) async {
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
  testWidgets('a failed completion stays open and shows the message',
      (tester) async {
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
    final result = await openSheet(
      tester,
      onConfirm: () async => gate.future,
    );
    await tester.tap(find.text('Confirm Delivery'));
    await tester.pump();
    // Still open while the completion is in flight.
    expect(result(), isNull);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    gate.complete();
    await tester.pumpAndSettle();
    expect(result(), isTrue);
  });
}
