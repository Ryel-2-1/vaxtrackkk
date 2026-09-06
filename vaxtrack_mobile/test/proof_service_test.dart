import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/services/proof_service.dart';
import 'package:vaxtrack_mobile/utils/proof_validation.dart';

/// The decision table behind every proof write, exercised as a pure function.
///
/// `ProofService` runs exactly this against the order it re-reads inside the
/// transaction, so these cases describe the real authorization contract without
/// needing an emulator. The Firestore rules re-check the same conditions
/// independently — tests/firestore.rules.test.js covers that side.
void main() {
  const orderId = 'JDP0JzdWMnegoeAz3Zq9';
  const riderUid = 'rider-uid-1';
  const canonicalPath = 'proof_of_delivery/$orderId/proof.jpg';

  Map<String, dynamic> approvedRider() => {
        'role': 'rider',
        'status': 'approved',
        'employeeId': 'EMP-4432',
        'fullName': 'QA Rider',
        'email': 'rider@vaxtrack.com',
      };

  Map<String, dynamic> liveOrder({
    String status = 'in_transit',
    String? assignedTo = riderUid,
    Object? proofSubmittedAt,
  }) =>
      {
        'status': status,
        'assignedRiderId': assignedTo,
        'proofSubmittedAt': ?proofSubmittedAt,
      };

  ProofDecision decide({
    String? authUid = riderUid,
    Map<String, dynamic>? userData,
    Map<String, dynamic>? orderData,
    String recipientName = 'Maria Santos',
    String proofUrl = 'https://storage/proof.jpg',
    String? storagePath = canonicalPath,
    bool orderPresent = true,
    bool userPresent = true,
  }) {
    return evaluateProofSubmission(
      authUid: authUid,
      userData: userPresent ? (userData ?? approvedRider()) : null,
      orderData: orderPresent ? (orderData ?? liveOrder()) : null,
      orderId: orderId,
      recipientName: recipientName,
      proofUrl: proofUrl,
      storagePath: storagePath,
    );
  }

  group('allows', () {
    test('the assigned approved rider on an in_transit order', () {
      final d = decide();
      expect(d.allowed, isTrue);
      expect(d.recipientName, 'Maria Santos');
      expect(d.proofUrl, 'https://storage/proof.jpg');
    });

    test('the assigned approved rider on a delayed order', () {
      final d = decide(orderData: liveOrder(status: 'delayed'));
      expect(d.allowed, isTrue);
    });

    test('a submission with no Storage path (manual-link fallback)', () {
      // The fallback records a URL with no object behind it. Everything else —
      // authorization, order state, recipient — still applies.
      final d = decide(storagePath: null, proofUrl: 'https://example/img.png');
      expect(d.allowed, isTrue);
    });

    test('and normalizes the stored name', () {
      final d = decide(recipientName: '   Maria Santos  ');
      expect(d.allowed, isTrue);
      expect(d.recipientName, 'Maria Santos');
    });
  });

  group('denies', () {
    test('an unauthenticated caller', () {
      expect(decide(authUid: null).code, 'not-signed-in');
      expect(decide(authUid: '').code, 'not-signed-in');
    });

    test('a missing order', () {
      expect(decide(orderPresent: false).code, 'order-not-found');
    });

    test('a caller with no rider profile', () {
      expect(decide(userPresent: false).code, 'rider-profile-missing');
    });

    test('a non-rider role, even an approved one', () {
      for (final role in ['admin', 'dispatcher', 'salesrep', '']) {
        final d = decide(userData: {'role': role, 'status': 'approved'});
        expect(d.code, 'not-a-rider', reason: role);
      }
    });

    test('an unapproved rider', () {
      for (final status in ['pending', 'disabled', 'rejected', '']) {
        final d = decide(userData: {'role': 'rider', 'status': status});
        expect(d.code, 'rider-not-approved', reason: status);
      }
    });

    test('a rider the order is not assigned to', () {
      final d = decide(orderData: liveOrder(assignedTo: 'someone-else'));
      expect(d.code, 'not-assigned-rider');
    });

    test('an order with no assigned rider at all', () {
      expect(decide(orderData: liveOrder(assignedTo: null)).code,
          'not-assigned-rider');
    });

    test('every status except in_transit and delayed', () {
      for (final status in [
        'pending_dispatch',
        'assigned',
        'loading',
        'delivery_failed',
        'delivered',
        'cancelled',
      ]) {
        final d = decide(orderData: liveOrder(status: status));
        expect(d.code, 'invalid-status', reason: status);
      }
    });

    test('a second submission once proof is finalized', () {
      final d = decide(
        orderData: liveOrder(proofSubmittedAt: DateTime(2026, 9, 1)),
      );
      expect(d.code, 'proof-already-finalized');
    });

    test('an invalid recipient name', () {
      expect(decide(recipientName: '   ').code, 'recipient-required');
      expect(decide(recipientName: 'a' * 121).code, 'recipient-too-long');
    });

    test('an empty proof URL', () {
      expect(decide(proofUrl: '  ').code, 'proof-url-required');
    });

    test("another order's canonical object", () {
      final d = decide(
        storagePath: 'proof_of_delivery/some-other-order/proof.jpg',
      );
      expect(d.code, 'invalid-storage-path');
    });

    test('a path that is not the canonical name for this order', () {
      for (final path in [
        'proof_of_delivery/$orderId/1788246428806.jpg',
        'proof_of_delivery/$orderId/proof.png',
        'invoices/$orderId/proof.jpg',
        'proof.jpg',
      ]) {
        expect(decide(storagePath: path).code, 'invalid-storage-path',
            reason: path);
      }
    });
  });

  group('identity cannot be supplied by the caller', () {
    // Identity is the session uid compared in full against the order's CURRENT
    // assignedRiderId. Nothing a caller can type is accepted in its place.
    test('an employee id, name, email or uid fragment is not an identity', () {
      for (final fake in [
        'EMP-4432',
        'QA Rider',
        'rider@vaxtrack.com',
        riderUid.substring(0, 5),
        '$riderUid ',
        riderUid.toUpperCase(),
      ]) {
        final d = decide(authUid: fake);
        expect(d.allowed, isFalse, reason: fake);
        expect(d.code, 'not-assigned-rider', reason: fake);
      }
    });

    test('profile fields do not widen authorization', () {
      // A rider document stuffed with an admin-looking employee id is still
      // just an unapproved non-rider.
      final d = decide(userData: {
        'role': 'salesrep',
        'status': 'approved',
        'employeeId': 'ADMIN-0001',
        'fullName': 'System Administrator',
      });
      expect(d.code, 'not-a-rider');
    });
  });

  group('invoice submission', () {
    ProofDecision invoice({
      Map<String, dynamic>? orderData,
      String url = 'https://storage/invoice.jpg',
      String? storagePath = 'invoices/$orderId/invoice.jpg',
    }) =>
        evaluateInvoiceSubmission(
          authUid: riderUid,
          userData: approvedRider(),
          orderData: orderData ?? liveOrder(),
          orderId: orderId,
          invoiceUrl: url,
          storagePath: storagePath,
        );

    test('shares the proof authorization contract', () {
      expect(invoice().allowed, isTrue);
      expect(invoice(orderData: liveOrder(status: 'delivered')).code,
          'invalid-status');
      expect(invoice(orderData: liveOrder(assignedTo: 'other')).code,
          'not-assigned-rider');
      expect(invoice(storagePath: 'invoices/other/invoice.jpg').code,
          'invalid-storage-path');
      expect(invoice(url: '').code, 'invoice-url-required');
    });

    test('is finalized independently of the proof', () {
      // Recording the proof must not lock the invoice, or an order proven
      // before its invoice arrived could never carry one.
      final proofDone = liveOrder(proofSubmittedAt: DateTime(2026, 9, 1));
      expect(invoice(orderData: proofDone).allowed, isTrue);

      final invoiceDone = liveOrder()..['invoiceSubmittedAt'] = DateTime(2026, 9, 1);
      expect(invoice(orderData: invoiceDone).code, 'invoice-already-finalized');
    });
  });

  test('canonical paths agree with the shared constants', () {
    // The decision function and the uploader must derive the same path, or a
    // valid upload would be rejected by its own validator.
    expect(proofObjectPath(orderId), canonicalPath);
    expect(decide(storagePath: proofObjectPath(orderId)).allowed, isTrue);
  });
}
