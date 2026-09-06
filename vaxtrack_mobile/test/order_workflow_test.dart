import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/models/delivery.dart';
import 'package:vaxtrack_mobile/utils/order_workflow.dart';

/// The order lifecycle, as the Rider app enforces it.
///
/// The approved matrix is restated here independently of the implementation, so
/// a change to either side has to be deliberate. The web suite additionally
/// parses order_workflow.dart and compares it to the JavaScript policy, so the
/// two platforms cannot drift apart.

const expectedDispatcher = <String, List<String>>{
  'pending_dispatch': ['assigned', 'cancelled'],
  'assigned': ['loading', 'cancelled'],
  'loading': ['in_transit', 'cancelled'],
  'in_transit': ['cancelled'],
  'delayed': ['cancelled'],
  'delivery_failed': ['assigned', 'cancelled'],
  'delivered': <String>[],
  'cancelled': <String>[],
};

const expectedRider = <String, List<String>>{
  'pending_dispatch': <String>[],
  'assigned': <String>[],
  'loading': <String>[],
  'in_transit': ['delayed', 'delivered', 'delivery_failed'],
  'delayed': ['in_transit', 'delivered', 'delivery_failed'],
  'delivery_failed': <String>[],
  'delivered': <String>[],
  'cancelled': <String>[],
};

Delivery deliveryWith(String status, {String? riderId}) => Delivery(
      id: 'order1',
      orderNumber: 'VT-ORD-9001',
      clinicName: 'QA Clinic',
      clinicAddress: '1 Test Street',
      vaccineName: 'QA Vaccine',
      quantity: 10,
      unit: 'vials',
      priority: 'Standard',
      status: status,
      statusLabel: statusLabel(status),
      assignedRiderId: riderId ?? 'rider1',
    );

void main() {
  group('transition matrix', () {
    test('every actor/from/to combination matches the approved lifecycle', () {
      var allowed = 0;
      var total = 0;

      for (final actor in [kActorDispatcher, kActorRider]) {
        final expected =
            actor == kActorDispatcher ? expectedDispatcher : expectedRider;
        for (final from in kOrderStatuses) {
          for (final to in kOrderStatuses) {
            total += 1;
            final shouldAllow = expected[from]!.contains(to);
            final result = canTransition(actor, from, to);
            expect(result.allowed, shouldAllow,
                reason: '$actor: $from -> $to');
            if (result.allowed) allowed += 1;
          }
        }
      }

      expect(total, 128);
      expect(allowed, 16, reason: 'exactly sixteen legal transitions');
    });

    test('the exported tables agree with the matrix', () {
      for (final from in kOrderStatuses) {
        expect(kDispatcherTransitions[from], expectedDispatcher[from]);
        expect(kRiderTransitions[from], expectedRider[from]);
        expect(allowedTransitions(kActorRider, from), expectedRider[from]);
      }
    });
  });

  group('rider authority', () {
    test('a rider cannot start loading or transit', () {
      expect(canTransition(kActorRider, 'assigned', 'loading').allowed, isFalse);
      expect(canTransition(kActorRider, 'loading', 'in_transit').allowed, isFalse);
    });

    test('a rider cannot cancel or assign', () {
      expect(canTransition(kActorRider, 'in_transit', 'cancelled').allowed, isFalse);
      expect(canTransition(kActorRider, 'delayed', 'cancelled').allowed, isFalse);
      expect(canTransition(kActorRider, 'pending_dispatch', 'assigned').allowed, isFalse);
    });

    test('a rider may delay, resume and complete', () {
      expect(canTransition(kActorRider, 'in_transit', 'delayed').allowed, isTrue);
      expect(canTransition(kActorRider, 'delayed', 'in_transit').allowed, isTrue);
      expect(canTransition(kActorRider, 'in_transit', 'delivered').allowed, isTrue);
      expect(canTransition(kActorRider, 'delayed', 'delivered').allowed, isTrue);
    });

    test('a rider cannot move an order backwards', () {
      for (final pair in [
        ['in_transit', 'loading'],
        ['in_transit', 'assigned'],
        ['delayed', 'assigned'],
        ['delayed', 'pending_dispatch'],
      ]) {
        expect(canTransition(kActorRider, pair[0], pair[1]).allowed, isFalse,
            reason: '${pair[0]} -> ${pair[1]}');
      }
    });
  });

  group('terminal states', () {
    test('delivered and cancelled never move again', () {
      for (final actor in [kActorDispatcher, kActorRider]) {
        for (final from in kTerminalStatuses) {
          for (final to in kOrderStatuses) {
            expect(canTransition(actor, from, to).allowed, isFalse,
                reason: '$actor: $from -> $to');
          }
        }
      }
      expect(isTerminalStatus('delivered'), isTrue);
      expect(isTerminalStatus('cancelled'), isTrue);
      expect(isTerminalStatus('in_transit'), isFalse);
    });
  });

  group('unknown input', () {
    test('unknown statuses are rejected, never guessed at', () {
      // 'delivery_failed' used to sit here; it is a canonical status now.
      for (final value in <Object?>[
        'picked_up', 'arrived', 'failed', 'completed', 'canceled',
        '', '   ', null, 42,
      ]) {
        expect(normalizeStatus(value), isNull, reason: '$value');
        expect(isKnownStatus(value), isFalse);
        expect(canTransition(kActorRider, 'in_transit', value).allowed, isFalse);
      }
    });

    test('only harmless formatting is normalized', () {
      expect(normalizeStatus('  IN_TRANSIT '), 'in_transit');
      expect(normalizeStatus('in-transit'), 'in_transit');
      expect(normalizeStatus('In Transit'), 'in_transit');
      expect(normalizeStatus('in_transitt'), isNull);
    });

    test('assertTransition throws a typed exception', () {
      expect(assertTransition(kActorRider, 'in_transit', 'delivered'), 'delivered');
      expect(
        () => assertTransition(kActorRider, 'assigned', 'loading'),
        throwsA(isA<WorkflowException>()
            .having((e) => e.code, 'code', 'transition-not-allowed')),
      );
    });
  });

  group('delivery capability getters', () {
    test('assigned and loading expose no rider transition control', () {
      for (final status in ['assigned', 'loading']) {
        final d = deliveryWith(status);
        expect(d.canReportDelay, isFalse, reason: status);
        expect(d.canResumeTransit, isFalse, reason: status);
        expect(d.canComplete, isFalse, reason: status);
      }
      expect(deliveryWith('assigned').isAwaitingLoading, isTrue);
      expect(deliveryWith('loading').isAwaitingDispatch, isTrue);
    });

    test('in transit exposes report delay and complete only', () {
      final d = deliveryWith('in_transit');
      expect(d.canReportDelay, isTrue);
      expect(d.canComplete, isTrue);
      expect(d.canResumeTransit, isFalse, reason: 'already moving');
    });

    test('delayed exposes resume and complete only', () {
      final d = deliveryWith('delayed');
      expect(d.canResumeTransit, isTrue);
      expect(d.canComplete, isTrue);
      expect(d.canReportDelay, isFalse, reason: 'already delayed');
    });

    test('terminal deliveries expose no action at all', () {
      for (final status in ['delivered', 'cancelled']) {
        final d = deliveryWith(status);
        expect(d.canReportDelay, isFalse);
        expect(d.canResumeTransit, isFalse);
        expect(d.canComplete, isFalse);
        expect(d.isAwaitingLoading, isFalse);
        expect(d.isAwaitingDispatch, isFalse);
      }
    });

    test('the assigned rider identity is retained on the model', () {
      final d = deliveryWith('in_transit', riderId: 'riderXYZ');
      expect(d.assignedRiderId, 'riderXYZ');
    });
  });

  group('failed delivery', () {
    test('failure can be reported only from in transit or delayed', () {
      expect(deliveryWith('in_transit').canReportFailure, isTrue);
      expect(deliveryWith('delayed').canReportFailure, isTrue);
      for (final status in [
        'pending_dispatch', 'assigned', 'loading', 'delivered', 'cancelled',
      ]) {
        expect(deliveryWith(status).canReportFailure, isFalse, reason: status);
      }
    });

    test('a failed delivery exposes no rider action at all', () {
      final d = deliveryWith('delivery_failed');
      expect(d.canReportDelay, isFalse);
      expect(d.canResumeTransit, isFalse);
      expect(d.canComplete, isFalse);
      expect(d.canReportFailure, isFalse, reason: 'it already failed');
      expect(d.isDeliveryFailed, isTrue);
    });

    test('a rider cannot retry or reassign a failed delivery', () {
      for (final to in kOrderStatuses) {
        expect(canTransition(kActorRider, 'delivery_failed', to).allowed, isFalse,
            reason: 'rider must not move delivery_failed to $to');
      }
    });

    test('a failed delivery is parked, not finished', () {
      expect(isTerminalStatus('delivery_failed'), isFalse);
      expect(isAwaitingDispatcher('delivery_failed'), isTrue);
      expect(isAwaitingDispatcher('in_transit'), isFalse);
    });

    test('a failed delivery is still visible and labelled to its rider', () {
      final d = deliveryWith('delivery_failed');
      expect(d.statusLabel, 'Delivery Failed');
      expect(d.isActive, isTrue, reason: 'not terminal, so it stays in the list');
      expect(d.assignedRiderId, 'rider1');
    });
  });

  group('reason validation', () {
    test('a reason must be present, meaningful and bounded', () {
      expect(validateReason('  Clinic closed  ').valid, isTrue);
      expect(validateReason('  Clinic closed  ').value, 'Clinic closed');
      for (final bad in <Object?>['', '   ', '\n\t ', null, 42]) {
        final r = validateReason(bad);
        expect(r.valid, isFalse, reason: '$bad');
        expect(r.code, 'reason-required');
      }
      final tooLong = validateReason('x' * (kMaxReasonLength + 1));
      expect(tooLong.valid, isFalse);
      expect(tooLong.code, 'reason-too-long');
      expect(validateReason('x' * kMaxReasonLength).valid, isTrue);
      expect(kMaxReasonLength, 500);
    });
  });

  group('labels', () {
    test('canonical statuses have distinct human labels', () {
      expect(statusLabel('pending_dispatch'), 'Pending Dispatch');
      expect(statusLabel('assigned'), 'Assigned');
      expect(statusLabel('loading'), 'Loading');
      expect(statusLabel('in_transit'), 'In Transit');
      expect(statusLabel('delayed'), 'Delayed');
      expect(statusLabel('delivery_failed'), 'Delivery Failed');
      expect(statusLabel('delivered'), 'Delivered');
      expect(statusLabel('cancelled'), 'Cancelled');
      expect(kStatusLabels.values.toSet().length, kStatusLabels.length);
    });
  });
}
