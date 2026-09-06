import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';

import '../utils/proof_validation.dart';

/// The one place proof-of-delivery metadata is written.
///
/// Before this existed the screen called `DeliveryService.saveProofOfDelivery`,
/// a two-line `update()` that accepted any order id and any string and checked
/// nothing at all: not who was calling, not whether they were the assigned
/// rider, not what state the order was in, not whether the URL pointed at this
/// order's evidence. Every one of those checks now happens here, against the
/// order as it is on the server at the moment of the write.
///
/// Firestore rules re-check the same conditions independently and remain the
/// authority; this is what gives the rider a clear, immediate reason instead of
/// a bare `permission-denied`.
/// What a caller needs in order to persist evidence. [ProofService] implements
/// it; tests supply a fake, which is what makes the duplicate guard and the
/// retry behaviour provable without a Firebase connection.
abstract class ProofMetadataWriter {
  Future<void> saveProofOfDelivery({
    required String orderId,
    required String recipientName,
    required String proofUrl,
    String? storagePath,
  });

  Future<void> saveInvoicePhoto({
    required String orderId,
    required String invoiceUrl,
    String? storagePath,
  });
}

class ProofService implements ProofMetadataWriter {
  ProofService({FirebaseFirestore? firestore, FirebaseAuth? auth})
      : _db = firestore ?? FirebaseFirestore.instance,
        _auth = auth ?? FirebaseAuth.instance;

  final FirebaseFirestore _db;
  final FirebaseAuth _auth;

  /// Record proof for [orderId].
  ///
  /// The order is re-read INSIDE a transaction and re-validated against that
  /// fresh copy, so a submission cannot be decided against a stale snapshot —
  /// an order reassigned, cancelled or already proven while the rider was
  /// filling in the form is refused rather than overwritten.
  ///
  /// Identity is taken from the authenticated session, never from an argument:
  /// there is no parameter a caller could use to attribute this to another
  /// rider. Status is deliberately NOT touched — proof and completion are
  /// separate acts, and marking an order delivered stays the rider's explicit
  /// decision.
  @override
  Future<void> saveProofOfDelivery({
    required String orderId,
    required String recipientName,
    required String proofUrl,
    String? storagePath,
  }) {
    final uid = _auth.currentUser?.uid;
    final orderRef = _db.collection('orders').doc(orderId);
    final userRef = uid == null ? null : _db.collection('users').doc(uid);

    return _db.runTransaction((txn) async {
      final orderSnap = await txn.get(orderRef);
      final userSnap = userRef == null ? null : await txn.get(userRef);

      final decision = evaluateProofSubmission(
        authUid: uid,
        userData: userSnap?.data(),
        orderData: orderSnap.exists ? orderSnap.data() : null,
        orderId: orderId,
        recipientName: recipientName,
        proofUrl: proofUrl,
        storagePath: storagePath,
      );
      if (!decision.allowed) {
        throw ProofException(decision.code!, decision.message!);
      }

      txn.update(orderRef, {
        'proofOfDeliveryUrl': decision.proofUrl,
        // Omitted entirely when there is no Storage object — the temporary
        // manual-link fallback records a URL with nothing behind it.
        'proofOfDeliveryPath': ?storagePath,
        'proofRecipientName': decision.recipientName,
        'proofSubmittedAt': FieldValue.serverTimestamp(),
        'proofSubmittedByUid': uid,
        'updatedAt': FieldValue.serverTimestamp(),
      });
    });
  }

  /// Record the optional photo of the paper invoice.
  ///
  /// Same authorization and same transactional re-read as the proof write, with
  /// no recipient — the recipient is a property of the delivery, recorded once
  /// with the proof, not repeated per attachment. Tracked by its own
  /// `invoiceSubmittedAt` marker so finalizing one does not lock the other.
  @override
  Future<void> saveInvoicePhoto({
    required String orderId,
    required String invoiceUrl,
    String? storagePath,
  }) {
    final uid = _auth.currentUser?.uid;
    final orderRef = _db.collection('orders').doc(orderId);
    final userRef = uid == null ? null : _db.collection('users').doc(uid);

    return _db.runTransaction((txn) async {
      final orderSnap = await txn.get(orderRef);
      final userSnap = userRef == null ? null : await txn.get(userRef);

      final decision = evaluateInvoiceSubmission(
        authUid: uid,
        userData: userSnap?.data(),
        orderData: orderSnap.exists ? orderSnap.data() : null,
        orderId: orderId,
        invoiceUrl: invoiceUrl,
        storagePath: storagePath,
      );
      if (!decision.allowed) {
        throw ProofException(decision.code!, decision.message!);
      }

      txn.update(orderRef, {
        'invoiceUrl': decision.proofUrl,
        'invoicePath': ?storagePath,
        'invoiceSubmittedAt': FieldValue.serverTimestamp(),
        'invoiceSubmittedByUid': uid,
        'updatedAt': FieldValue.serverTimestamp(),
      });
    });
  }
}

/// The outcome of checking a proof submission. [code] values are stable
/// identifiers; [message] is written to be shown to the rider unchanged.
class ProofDecision {
  const ProofDecision.allow({required this.recipientName, required this.proofUrl})
      : allowed = true,
        code = null,
        message = null;

  const ProofDecision.deny(this.code, this.message)
      : allowed = false,
        recipientName = '',
        proofUrl = '';

  final bool allowed;
  final String? code;
  final String? message;

  /// Trimmed name to persist. Only meaningful when [allowed].
  final String recipientName;

  /// Trimmed URL to persist. Only meaningful when [allowed].
  final String proofUrl;
}

/// Every condition a proof write must satisfy, as a pure function of the
/// session, the caller's user document and the order document.
///
/// Kept free of Firestore types so the whole decision table is unit-testable
/// without an emulator. [orderData] is null when the order does not exist;
/// [userData] is null when the caller has no profile document.
ProofDecision evaluateProofSubmission({
  required String? authUid,
  required Map<String, dynamic>? userData,
  required Map<String, dynamic>? orderData,
  required String orderId,
  required String recipientName,
  required String proofUrl,
  String? storagePath,
}) {
  final authorization = _checkEvidenceAuthorization(
    authUid: authUid,
    userData: userData,
    orderData: orderData,
  );
  if (authorization != null) return authorization;

  if (orderData!['proofSubmittedAt'] != null) {
    return const ProofDecision.deny(
      'proof-already-finalized',
      'Proof for this delivery has already been recorded. '
          'Contact your dispatcher if it needs to be changed.',
    );
  }

  final name = validateRecipientName(recipientName);
  if (!name.valid) return ProofDecision.deny(name.code!, name.message!);

  final url = _checkEvidenceUrl(proofUrl, 'proof');
  if (url != null) return url;

  final path = _checkStoragePath(
    storagePath,
    expected: proofObjectPath(orderId),
  );
  if (path != null) return path;

  return ProofDecision.allow(
    recipientName: name.value,
    proofUrl: proofUrl.trim(),
  );
}

/// The invoice photo's equivalent. Same authorization, no recipient, and its own
/// finalization marker.
ProofDecision evaluateInvoiceSubmission({
  required String? authUid,
  required Map<String, dynamic>? userData,
  required Map<String, dynamic>? orderData,
  required String orderId,
  required String invoiceUrl,
  String? storagePath,
}) {
  final authorization = _checkEvidenceAuthorization(
    authUid: authUid,
    userData: userData,
    orderData: orderData,
  );
  if (authorization != null) return authorization;

  if (orderData!['invoiceSubmittedAt'] != null) {
    return const ProofDecision.deny(
      'invoice-already-finalized',
      'The invoice photo for this delivery has already been recorded.',
    );
  }

  final url = _checkEvidenceUrl(invoiceUrl, 'invoice');
  if (url != null) return url;

  final path = _checkStoragePath(
    storagePath,
    expected: invoiceObjectPath(orderId),
  );
  if (path != null) return path;

  return ProofDecision.allow(recipientName: '', proofUrl: invoiceUrl.trim());
}

/// Who may attach evidence to an order, and when. Returns a denial, or null
/// when the caller is cleared to continue.
ProofDecision? _checkEvidenceAuthorization({
  required String? authUid,
  required Map<String, dynamic>? userData,
  required Map<String, dynamic>? orderData,
}) {
  if (authUid == null || authUid.isEmpty) {
    return const ProofDecision.deny(
      'not-signed-in',
      'Your session has expired. Please sign in again.',
    );
  }
  if (orderData == null) {
    return const ProofDecision.deny(
      'order-not-found',
      'That delivery no longer exists.',
    );
  }
  if (userData == null) {
    return const ProofDecision.deny(
      'rider-profile-missing',
      'Your rider profile could not be found. Contact your administrator.',
    );
  }
  if (_normalize(userData['role']) != 'rider') {
    return const ProofDecision.deny(
      'not-a-rider',
      'Only the assigned rider can submit proof of delivery.',
    );
  }
  if (_normalize(userData['status']) != 'approved') {
    return const ProofDecision.deny(
      'rider-not-approved',
      'Your rider account is not approved. Contact your administrator.',
    );
  }
  // Compared in full against the order's CURRENT assigned rider. An employee
  // id, display name or uid fragment is simply a different string and fails
  // here, exactly as it fails the equivalent check in the rules.
  if (orderData['assignedRiderId'] != authUid) {
    return const ProofDecision.deny(
      'not-assigned-rider',
      'This delivery is not assigned to you.',
    );
  }
  final status = _normalize(orderData['status']);
  if (!kProofSubmittableStatuses.contains(status)) {
    return const ProofDecision.deny(
      'invalid-status',
      'Proof can only be submitted while a delivery is in transit or delayed.',
    );
  }
  return null;
}

ProofDecision? _checkEvidenceUrl(String value, String label) {
  if (value.trim().isEmpty) {
    return ProofDecision.deny(
      '$label-url-required',
      'The $label photo could not be read. Please try again.',
    );
  }
  return null;
}

/// The stored object must be THIS order's canonical object.
///
/// Null is accepted because the temporary manual-URL fallback (debug builds
/// only) records a link with no Storage object behind it. That is exactly why
/// the equivalent rule cannot yet REQUIRE the path — see storage/firestore
/// rules and Part 8 of the checkpoint notes. When a path is supplied it must
/// match, so a valid URL for a different order cannot be filed under this one.
ProofDecision? _checkStoragePath(String? storagePath, {required String expected}) {
  if (storagePath == null) return null;
  if (storagePath != expected) {
    return const ProofDecision.deny(
      'invalid-storage-path',
      'That photo does not belong to this delivery. Please retake it.',
    );
  }
  return null;
}

String _normalize(Object? value) =>
    value is String ? value.trim().toLowerCase() : '';
