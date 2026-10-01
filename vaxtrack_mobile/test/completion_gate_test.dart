import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/utils/completion_gate.dart';

/// The client-side, FAIL-CLOSED readiness gate for "Complete Delivery".
/// Completion settles inventory irreversibly, so these prove exactly when the
/// confirmation may open — and, when it may not, the single reason the rider is
/// given and its stable code. The confirmation opens ONLY when `ready` is true.
void main() {
  const rider = 'riderUid-A';

  // A fully ready delivery; each test overrides only what it is testing.
  CompletionReadiness evaluate({
    String? orderId = 'orderDoc123',
    String? currentRiderId = rider,
    String? assignedRiderId = rider,
    bool statusEligible = true,
    bool hasProof = true,
    bool hasInvoice = true,
    bool completionInProgress = false,
    bool dataConfirmed = true,
  }) =>
      evaluateCompletionReadiness(
        orderId: orderId,
        currentRiderId: currentRiderId,
        assignedRiderId: assignedRiderId,
        statusEligible: statusEligible,
        hasProof: hasProof,
        hasInvoice: hasInvoice,
        completionInProgress: completionInProgress,
        dataConfirmed: dataConfirmed,
      );

  test('a fully ready delivery may open the confirmation', () {
    final r = evaluate();
    expect(r.ready, isTrue);
    expect(r.block, CompletionBlock.none);
    expect(r.code, 'ready');
    expect(r.message, isNull);
  });

  group('identity (fail-closed)', () {
    void expectIdentityBlock(
      CompletionReadiness r,
      CompletionBlock block,
      String code,
      String message,
    ) {
      expect(r.ready, isFalse, reason: 'no confirmation may open');
      expect(r.block, block);
      expect(r.code, code);
      expect(r.message, message);
      expect(r.isIdentityFailure, isTrue);
      expect(r.isMissingEvidence, isFalse);
    }

    // 1. Empty order id.
    test('an empty order id is blocked', () {
      expectIdentityBlock(evaluate(orderId: ''), CompletionBlock.invalidOrderId,
          'invalid-order-id', 'This delivery has an invalid order ID.');
    });

    // 2. Whitespace order id.
    test('a whitespace order id is blocked', () {
      expectIdentityBlock(evaluate(orderId: '   '),
          CompletionBlock.invalidOrderId, 'invalid-order-id',
          'This delivery has an invalid order ID.');
    });

    test('a null order id is blocked', () {
      expect(evaluate(orderId: null).block, CompletionBlock.invalidOrderId);
    });

    // 3. Missing current rider.
    test('a missing signed-in rider is blocked', () {
      expectIdentityBlock(evaluate(currentRiderId: null),
          CompletionBlock.unauthenticated, 'unauthenticated',
          'Your session has expired. Sign in again.');
    });

    // 4. Empty current rider.
    test('an empty signed-in rider id is blocked', () {
      expect(evaluate(currentRiderId: '').block, CompletionBlock.unauthenticated);
      expect(evaluate(currentRiderId: '  ').block,
          CompletionBlock.unauthenticated);
    });

    // 5. Missing assigned rider.
    test('a missing assigned rider is blocked', () {
      expectIdentityBlock(evaluate(assignedRiderId: null),
          CompletionBlock.missingAssignment, 'missing-assignment',
          'This delivery is not assigned to a Rider.');
    });

    // 6. Empty assigned rider.
    test('an empty assigned rider id is blocked', () {
      expect(evaluate(assignedRiderId: '').block,
          CompletionBlock.missingAssignment);
      expect(evaluate(assignedRiderId: ' ').block,
          CompletionBlock.missingAssignment);
    });

    // 7. Assignment mismatch.
    test('a delivery assigned to another rider is blocked', () {
      expectIdentityBlock(evaluate(assignedRiderId: 'riderUid-B'),
          CompletionBlock.assignmentMismatch, 'assignment-mismatch',
          'This delivery is assigned to another Rider.');
    });

    test('the comparison is exact — a padded id is a different id', () {
      expect(evaluate(assignedRiderId: ' $rider').block,
          CompletionBlock.assignmentMismatch);
    });

    // 8. Matching non-empty ids pass identity.
    test('matching non-empty rider ids pass the identity checks', () {
      final r = evaluate(currentRiderId: rider, assignedRiderId: rider);
      expect(r.isIdentityFailure, isFalse);
      expect(r.ready, isTrue);
    });

    // 9. Identity is decided before evidence — even with NO evidence at all.
    test('identity failures are reported before evidence validation', () {
      expect(evaluate(orderId: '', hasProof: false, hasInvoice: false).block,
          CompletionBlock.invalidOrderId);
      expect(
          evaluate(currentRiderId: null, hasProof: false, hasInvoice: false)
              .block,
          CompletionBlock.unauthenticated);
      expect(
          evaluate(assignedRiderId: null, hasProof: false, hasInvoice: false)
              .block,
          CompletionBlock.missingAssignment);
      expect(
          evaluate(
                  assignedRiderId: 'riderUid-B',
                  hasProof: false,
                  hasInvoice: false,
                  statusEligible: false)
              .block,
          CompletionBlock.assignmentMismatch);
    });

    // 10. No confirmation opens for ANY identity failure.
    test('no identity failure is ever ready', () {
      for (final r in [
        evaluate(orderId: null),
        evaluate(orderId: ''),
        evaluate(orderId: ' '),
        evaluate(currentRiderId: null),
        evaluate(currentRiderId: ''),
        evaluate(assignedRiderId: null),
        evaluate(assignedRiderId: ''),
        evaluate(assignedRiderId: 'someone-else'),
      ]) {
        expect(r.ready, isFalse, reason: r.code);
        expect(r.isIdentityFailure, isTrue, reason: r.code);
      }
    });
  });

  group('evidence and status', () {
    test('cannot proceed with both photos missing (names the proof first)', () {
      final r = evaluate(hasProof: false, hasInvoice: false);
      expect(r.ready, isFalse);
      expect(r.block, CompletionBlock.missingProof);
      expect(r.code, 'missing-proof');
      expect(r.isMissingEvidence, isTrue);
    });

    test('cannot proceed with only the proof photo', () {
      final r = evaluate(hasProof: true, hasInvoice: false);
      expect(r.block, CompletionBlock.missingInvoice);
      expect(r.code, 'missing-invoice');
    });

    test('cannot proceed with only the invoice photo', () {
      expect(evaluate(hasProof: false, hasInvoice: true).block,
          CompletionBlock.missingProof);
    });

    test('an ineligible status cannot complete', () {
      final r = evaluate(statusEligible: false);
      expect(r.block, CompletionBlock.notEligible);
      expect(r.code, 'status-not-eligible');
    });

    test('an already-completed delivery cannot be completed again', () {
      // A delivered order has canComplete == false, whatever its evidence.
      expect(evaluate(statusEligible: false).block, CompletionBlock.notEligible);
    });

    test('status is checked before evidence', () {
      expect(
          evaluate(statusEligible: false, hasProof: false, hasInvoice: false)
              .block,
          CompletionBlock.notEligible);
    });
  });

  group('unconfirmed data and in-progress', () {
    test('a failed reload blocks completion even with evidence on screen', () {
      final r = evaluate(dataConfirmed: false);
      expect(r.ready, isFalse);
      expect(r.block, CompletionBlock.unconfirmed);
      expect(r.code, 'refresh-required');
    });

    test('unconfirmed data is still reported after identity failures', () {
      expect(evaluate(dataConfirmed: false, currentRiderId: null).block,
          CompletionBlock.unauthenticated);
    });

    test('a completion already in progress blocks another', () {
      expect(evaluate(completionInProgress: true).block,
          CompletionBlock.inProgress);
    });
  });
}
