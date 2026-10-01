import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/models/delivery.dart';
import 'package:vaxtrack_mobile/screens/delivery_completion_coordinator.dart';
import 'package:vaxtrack_mobile/services/delivery_service.dart';
import 'package:vaxtrack_mobile/utils/completion_gate.dart';
import 'package:vaxtrack_mobile/utils/order_workflow.dart';
import 'package:vaxtrack_mobile/widgets/complete_delivery_confirm_sheet.dart';

/// Delivery Detail's completion flow, driven through the extracted coordinator
/// with fake loader/completer — no Firebase, no device. Covers the stale-snapshot
/// fix (reload after Add Proof), fail-closed handling of a failed reload, and
/// the coordinator wired into the real confirmation sheet.

const _orderId = 'orderDoc123';
const _rider = 'riderUid-A';

Delivery _order({
  String status = 'in_transit',
  String? proofUrl,
  String? invoiceUrl,
  String? assignedRiderId = _rider,
  String clinicName = 'Sample Clinic',
}) =>
    Delivery.fromFirestore(_orderId, {
      'orderNumber': 'VT-ORD-9001',
      'status': status,
      'clinicName': clinicName,
      'clinicAddress': '1 Sample St',
      'assignedRiderId': ?assignedRiderId,
      'proofOfDeliveryUrl': ?proofUrl,
      'invoiceUrl': ?invoiceUrl,
    });

class _FakeLoader implements DeliveryLoader {
  final List<String> calls = [];
  Delivery? next;
  Object? error;

  @override
  Future<Delivery> fetchDelivery(String orderId) async {
    calls.add(orderId);
    if (error != null) throw error!;
    return next!;
  }
}

class _FakeCompleter implements DeliveryCompleter {
  final List<(String, String)> calls = [];
  Object? error;
  Completer<void>? gate;

  @override
  Future<void> markDelivered(String orderId, String currentStatus) async {
    calls.add((orderId, currentStatus));
    if (gate != null) await gate!.future;
    if (error != null) throw error!;
  }
}

void main() {
  late _FakeLoader loader;
  late _FakeCompleter completer;

  DeliveryCompletionCoordinator build(Delivery initial) =>
      DeliveryCompletionCoordinator(
        initial: initial,
        loader: loader,
        completer: completer,
      );

  setUp(() {
    loader = _FakeLoader();
    completer = _FakeCompleter();
  });

  group('authoritative refresh', () {
    // 1. Returning from Add Proof triggers the reload — and only AFTER return.
    test('returning from Add Proof triggers exactly one reload, after return',
        () async {
      final c = build(_order());
      loader.next = _order(proofUrl: 'https://s/p.jpg', invoiceUrl: 'https://s/i.jpg');
      final proofScreen = Completer<void>();

      final done = c.addEvidenceThenRefresh(() => proofScreen.future);
      await Future<void>.delayed(Duration.zero);
      expect(loader.calls, isEmpty, reason: 'no reload while still on Proof');

      proofScreen.complete(); // rider comes back
      expect(await done, isTrue);
      expect(loader.calls, [_orderId]);
    });

    // 2. The refreshed values replace the stale snapshot.
    test('refreshed proof and invoice replace the stale snapshot', () async {
      final c = build(_order()); // opened with no evidence
      expect(c.readiness(currentRiderId: _rider).block,
          CompletionBlock.missingProof);

      loader.next = _order(
        proofUrl: 'https://s/p.jpg',
        invoiceUrl: 'https://s/i.jpg',
        clinicName: 'Renamed Clinic',
      );
      await c.addEvidenceThenRefresh(() async {});

      expect(c.delivery.proofOfDeliveryUrl, 'https://s/p.jpg');
      expect(c.delivery.invoiceUrl, 'https://s/i.jpg');
      expect(c.delivery.clinicName, 'Renamed Clinic');
      expect(c.dataConfirmed, isTrue);
      expect(c.readiness(currentRiderId: _rider).ready, isTrue);
    });

    test('a reload also picks up a status or assignment change', () async {
      final c = build(_order(proofUrl: 'p', invoiceUrl: 'i'));
      loader.next = _order(
          status: 'cancelled', proofUrl: 'p', invoiceUrl: 'i');
      await c.refresh();
      expect(c.readiness(currentRiderId: _rider).block,
          CompletionBlock.notEligible);

      loader.next =
          _order(proofUrl: 'p', invoiceUrl: 'i', assignedRiderId: 'riderUid-B');
      await c.refresh();
      expect(c.readiness(currentRiderId: _rider).block,
          CompletionBlock.assignmentMismatch);
    });

    // 3. A failed reload never enables completion.
    test('a failed reload keeps the old display but blocks completion',
        () async {
      final c = build(_order()); // no evidence yet
      loader.error = Exception('unavailable');

      final ok = await c.addEvidenceThenRefresh(() async {});

      expect(ok, isFalse);
      expect(c.delivery.hasProof, isFalse, reason: 'previous display kept');
      expect(c.dataConfirmed, isFalse);
      expect(c.refreshError, DeliveryCompletionCoordinator.refreshFailedMessage);
      expect(c.readiness(currentRiderId: _rider).block,
          CompletionBlock.unconfirmed);
    });

    test('a failed reload blocks completion even if evidence was on screen',
        () async {
      final c = build(_order(proofUrl: 'p', invoiceUrl: 'i'));
      loader.error = Exception('unavailable');
      await c.refresh();

      expect(c.readiness(currentRiderId: _rider).ready, isFalse);
      await expectLater(c.complete(), throwsA(isA<WorkflowException>()));
      expect(completer.calls, isEmpty, reason: 'nothing reaches the server');
    });

    test('a later successful reload clears the block', () async {
      final c = build(_order(proofUrl: 'p', invoiceUrl: 'i'));
      loader.error = Exception('unavailable');
      await c.refresh();
      loader
        ..error = null
        ..next = _order(proofUrl: 'p', invoiceUrl: 'i');
      expect(await c.refresh(), isTrue);
      expect(c.readiness(currentRiderId: _rider).ready, isTrue);
    });
  });

  group('completion', () {
    test('uses the refreshed order id and status', () async {
      final c = build(_order(status: 'delayed'));
      loader.next = _order(proofUrl: 'p', invoiceUrl: 'i');
      await c.refresh();
      await c.complete();
      expect(completer.calls, [(_orderId, 'in_transit')]);
    });

    // 6. A repeated call cannot submit again while the first is running.
    test('a second completion while one is running is refused', () async {
      final c = build(_order(proofUrl: 'p', invoiceUrl: 'i'));
      completer.gate = Completer<void>();

      final first = c.complete();
      expect(c.completing, isTrue);
      await expectLater(c.complete(), throwsA(isA<WorkflowException>()));
      completer.gate!.complete();
      await first;

      expect(completer.calls.length, 1);
      expect(c.completing, isFalse);
    });

    // 7. A server failure leaves no delivered state behind.
    test('a server failure rethrows and changes nothing locally', () async {
      final c = build(_order(proofUrl: 'p', invoiceUrl: 'i'));
      completer.error = const WorkflowException(
          'delivery-failed', 'Could not complete this delivery.');

      await expectLater(c.complete(), throwsA(isA<WorkflowException>()));
      expect(c.delivery.status, 'in_transit');
      expect(c.delivery.isDelivered, isFalse);
      expect(c.completing, isFalse, reason: 'retry is possible');
    });
  });

  // The coordinator wired into the REAL confirmation sheet, the way Delivery
  // Detail wires it — so Go Back / Confirm / failure are proven end to end
  // through the widget the rider actually taps.
  group('confirmation sheet wired to the coordinator', () {
    Future<bool? Function()> openSheet(
      WidgetTester tester,
      DeliveryCompletionCoordinator c,
    ) async {
      bool? popped;
      var closed = false;
      await tester.pumpWidget(MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: ElevatedButton(
              onPressed: () async {
                final d = c.delivery;
                popped = await showModalBottomSheet<bool>(
                  context: context,
                  isScrollControlled: true,
                  builder: (_) => CompleteDeliveryConfirmSheet(
                    orderNumber: d.orderNumber,
                    destinationTitle: d.clinicName,
                    destinationSubtitle: d.clinicAddress,
                    proofImageUrl: d.proofOfDeliveryUrl!,
                    invoiceImageUrl: d.invoiceUrl!,
                    onConfirm: c.complete,
                  ),
                );
                closed = true;
              },
              child: const Text('open'),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      return () => closed ? popped : null;
    }

    // 4. Go Back makes no completion call.
    testWidgets('Go Back makes no completion call', (tester) async {
      final c = build(_order(proofUrl: 'https://s/p', invoiceUrl: 'https://s/i'));
      final result = await openSheet(tester, c);
      await tester.tap(find.text('Go Back'));
      await tester.pumpAndSettle();
      expect(completer.calls, isEmpty);
      expect(result(), isFalse);
    });

    // 5. Confirm invokes completion exactly once.
    testWidgets('Confirm Delivery invokes completion exactly once',
        (tester) async {
      final c = build(_order(proofUrl: 'https://s/p', invoiceUrl: 'https://s/i'));
      final result = await openSheet(tester, c);
      await tester.tap(find.text('Confirm Delivery'));
      await tester.pumpAndSettle();
      expect(completer.calls, [(_orderId, 'in_transit')]);
      expect(result(), isTrue);
    });

    // 6. While the first completion runs, the confirm control cannot fire again.
    testWidgets('a repeated tap cannot submit again', (tester) async {
      final c = build(_order(proofUrl: 'https://s/p', invoiceUrl: 'https://s/i'));
      completer.gate = Completer<void>();
      await openSheet(tester, c);

      await tester.tap(find.text('Confirm Delivery'));
      await tester.pump();
      expect(find.text('Confirm Delivery'), findsNothing,
          reason: 'replaced by a spinner while committing');
      final button = tester.widget<ElevatedButton>(find.ancestor(
          of: find.byType(CircularProgressIndicator),
          matching: find.byType(ElevatedButton)));
      expect(button.onPressed, isNull);

      completer.gate!.complete();
      await tester.pumpAndSettle();
      expect(completer.calls.length, 1);
    });

    // 7. A server failure keeps the sheet open — no false delivered state.
    testWidgets('a server failure does not report the delivery as completed',
        (tester) async {
      final c = build(_order(proofUrl: 'https://s/p', invoiceUrl: 'https://s/i'));
      completer.error = const WorkflowException(
          'delivery-failed', 'Could not complete this delivery.');
      final result = await openSheet(tester, c);

      await tester.tap(find.text('Confirm Delivery'));
      await tester.pumpAndSettle();

      expect(result(), isNull, reason: 'the sheet did not close as a success');
      expect(find.text('Could not complete this delivery.'), findsOneWidget);
      expect(find.text('Confirm Delivery'), findsOneWidget, reason: 'retryable');
      expect(c.delivery.isDelivered, isFalse);
    });
  });
}
