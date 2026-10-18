import 'dart:io';

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/models/delivery.dart';
import 'package:vaxtrack_mobile/screens/proof_submission_controller.dart';
import 'package:vaxtrack_mobile/services/delivery_service.dart';
import 'package:vaxtrack_mobile/services/image_upload_service.dart';
import 'package:vaxtrack_mobile/services/proof_service.dart';
import 'package:vaxtrack_mobile/utils/delivery_geofence_messages.dart';
import 'package:vaxtrack_mobile/utils/order_workflow.dart';
import 'package:vaxtrack_mobile/utils/proof_validation.dart';

/// The order is reported Delayed WHILE the Rider's photos are uploading — after
/// the fresh re-read and the location preflight already said yes.
///
/// Every fake reads one shared server-side order at call time, the way the
/// real services read Firestore and Storage, and refuses exactly where the
/// deployed checks refuse:
///   - upload:   storage.rules orderAcceptsEvidence (in transit + assigned);
///   - record:   the app's REAL evaluateProofSubmission / evaluateInvoiceSubmission
///               (the same decision ProofService makes inside its transaction,
///               mirrored by firestore.rules);
///   - preflight and completion: the server's order of checks (assignment →
///               delivery-delayed → in transit → evidence), completion settling
///               stock once.

const orderId = 'raceOrderDoc01';
const me = 'riderUidRace01';

class _Server {
  final Map<String, dynamic> order = {
    'orderNumber': 'VT-ORD-RACE-1',
    'status': 'in_transit',
    'assignedRiderId': me,
  };
  final Map<String, dynamic> user = {'role': 'rider', 'status': 'approved'};
  final List<String> calls = [];
  int stockConsumed = 0;

  /// Runs right after an upload / record succeeds (the dispatcher acting
  /// mid-submission).
  void Function(String step)? after;

  bool get acceptsEvidence => order['status'] == 'in_transit' && order['assignedRiderId'] == me;
  void set(String status) => order['status'] = status;
}

class _Loader implements DeliveryLoader {
  _Loader(this.s);
  final _Server s;
  @override
  Future<Delivery> fetchDelivery(String id) async {
    s.calls.add('fetch');
    return Delivery.fromFirestore(id, Map.of(s.order));
  }
}

class _Geofence implements DeliveryGeofenceChecker {
  _Geofence(this.s);
  final _Server s;
  @override
  Future<DeliveryGeofenceResult> checkDeliveryGeofence(String id) async {
    s.calls.add('geofence');
    if (s.order['assignedRiderId'] != me) {
      throw const WorkflowException('not-assigned-rider', kNotCompletableMessage);
    }
    if (s.order['status'] == 'delayed') {
      throw const WorkflowException(kDeliveryDelayed, kDelayedNotCompletableMessage);
    }
    return const DeliveryGeofenceResult(eligible: true, distanceM: 40, radiusM: 300, locationAgeSeconds: 20, accuracyM: 8);
  }
}

class _Uploader implements ProofUploader {
  _Uploader(this.s);
  final _Server s;

  Future<EvidenceUpload> _upload(String kind, String path) async {
    if (!s.acceptsEvidence) {
      s.calls.add('upload-$kind:refused');
      // What Firebase Storage reports for a rules refusal.
      throw FirebaseException(plugin: 'firebase_storage', code: 'unauthorized');
    }
    s.calls.add('upload-$kind');
    final upload = EvidenceUpload(downloadUrl: 'https://storage/$path', storagePath: path);
    s.after?.call('upload-$kind');
    return upload;
  }

  @override
  Future<EvidenceUpload> uploadProof(String id, File file) => _upload('proof', proofObjectPath(id));
  @override
  Future<EvidenceUpload> uploadInvoice(String id, File file) => _upload('invoice', invoiceObjectPath(id));
  @override
  Future<String?> existingProofUrl(String id) async => null;
  @override
  Future<String?> existingInvoiceUrl(String id) async => null;
}

class _Writer implements ProofMetadataWriter {
  _Writer(this.s);
  final _Server s;

  @override
  Future<void> saveProofOfDelivery({
    required String orderId,
    required String recipientName,
    required String proofUrl,
    String? storagePath,
  }) async {
    final d = evaluateProofSubmission(
      authUid: me,
      userData: s.user,
      orderData: s.order,
      orderId: orderId,
      recipientName: recipientName,
      proofUrl: proofUrl,
      storagePath: storagePath,
    );
    if (!d.allowed) {
      s.calls.add('record-proof:refused');
      throw ProofException(d.code!, d.message!);
    }
    s.calls.add('record-proof');
    s.order
      ..['proofOfDeliveryUrl'] = d.proofUrl
      ..['proofOfDeliveryPath'] = storagePath
      ..['proofRecipientName'] = d.recipientName
      ..['proofSubmittedAt'] = DateTime(2026, 10, 16)
      ..['proofSubmittedByUid'] = me;
    s.after?.call('record-proof');
  }

  @override
  Future<void> saveInvoicePhoto({required String orderId, required String invoiceUrl, String? storagePath}) async {
    final d = evaluateInvoiceSubmission(
      authUid: me,
      userData: s.user,
      orderData: s.order,
      orderId: orderId,
      invoiceUrl: invoiceUrl,
      storagePath: storagePath,
    );
    if (!d.allowed) {
      s.calls.add('record-invoice:refused');
      throw ProofException(d.code!, d.message!);
    }
    s.calls.add('record-invoice');
    s.order
      ..['invoiceUrl'] = d.proofUrl
      ..['invoicePath'] = storagePath
      ..['invoiceSubmittedAt'] = DateTime(2026, 10, 16)
      ..['invoiceSubmittedByUid'] = me;
  }
}

class _Completer implements DeliveryCompleter {
  _Completer(this.s);
  final _Server s;
  @override
  Future<void> markDelivered(String id, String currentStatus) async {
    s.calls.add('complete');
    if (s.order['status'] == 'delivered') return; // idempotent replay
    if (s.order['assignedRiderId'] != me) {
      throw const WorkflowException('not-assigned-rider', kNotCompletableMessage);
    }
    if (s.order['status'] == 'delayed') {
      throw const WorkflowException(kDeliveryDelayed, kDelayedNotCompletableMessage);
    }
    if (s.order['status'] != 'in_transit') {
      throw const WorkflowException('invalid-status-transition', kNotCompletableMessage);
    }
    if (s.order['proofSubmittedAt'] == null || s.order['invoiceSubmittedAt'] == null) {
      throw const WorkflowException('proof-missing', 'Proof is not recorded.');
    }
    s.order['status'] = 'delivered';
    s.stockConsumed += 1;
  }
}

void main() {
  late _Server s;
  late ProofSubmissionController c;
  final proofPhoto = File('proof.jpg');
  final invoicePhoto = File('invoice.jpg');

  setUp(() {
    s = _Server();
    c = ProofSubmissionController(
      uploader: _Uploader(s),
      writer: _Writer(s),
      completer: _Completer(s),
      loader: _Loader(s),
      geofence: _Geofence(s),
    );
  });

  // The screen still holds the in-transit copy and both chosen photos.
  Future<bool> submit() => c.submitAndComplete(
        orderId: orderId,
        currentStatus: 'in_transit',
        proofRecorded: false,
        invoiceRecorded: false,
        recipientName: 'Maria Santos',
        proofPhoto: proofPhoto,
        invoicePhoto: invoicePhoto,
        riderUid: me,
      );

  bool retryOffered() => c.canSubmitAndComplete(
      recipientName: 'Maria Santos',
      hasProofPhoto: true,
      hasInvoicePhoto: true,
      proofRecorded: false,
      invoiceRecorded: false);

  void expectNothingSettled() {
    expect(s.calls, isNot(contains('complete')), reason: 'completion is never called');
    expect(s.order['status'], 'delayed');
    expect(s.stockConsumed, 0);
    expect(c.isCompleted, isFalse);
    expect(c.phase, isNot(ProofPhase.completed));
    expect(c.noticeMessage, isNot(ProofSubmissionController.completedMessage));
    expect(c.isCommitting, isFalse);
  }

  test('Delayed after both uploads: the record is refused, nothing completes, and the retry after resuming reuses the uploads', () async {
    s.after = (step) {
      if (step == 'upload-invoice') s.set('delayed');
    };

    expect(await submit(), isFalse, reason: 'the UI must not report success');
    expect(s.calls, ['fetch', 'geofence', 'upload-proof', 'upload-invoice', 'record-proof:refused']);
    expectNothingSettled();
    expect(c.errorMessage, kDelayedNotCompletableMessage);
    expect(s.order['proofSubmittedAt'], isNull);
    expect(s.order['invoiceSubmittedAt'], isNull);
    // Retry state is kept: both uploaded objects are still pending, the
    // button stays usable.
    expect(c.hasPendingUpload, isTrue);
    expect(c.hasPendingInvoiceUpload, isTrue);
    expect(c.isProofSaved, isFalse);
    expect(retryOffered(), isTrue);

    // Pressed again while STILL Delayed: refused at the fresh read — nothing
    // else runs, and the pending uploads survive.
    s.after = null;
    s.calls.clear();
    expect(await submit(), isFalse);
    expect(s.calls, ['fetch']);
    expect(c.errorMessage, kDelayedNotCompletableMessage);
    expect(c.hasPendingUpload, isTrue);
    expect(c.hasPendingInvoiceUpload, isTrue);

    // The Rider resumes (delayed → in transit) and presses once more.
    expect(canTransition(kActorRider, 'delayed', 'in_transit').allowed, isTrue);
    s.set('in_transit');
    s.calls.clear();
    expect(await submit(), isTrue);
    expect(s.calls, ['fetch', 'geofence', 'record-proof', 'record-invoice', 'complete'],
        reason: 'no second upload: the earlier objects are recorded');
    expect(s.order['status'], 'delivered');
    expect(s.stockConsumed, 1);
    expect(c.isCompleted, isTrue);
    expect(c.noticeMessage, ProofSubmissionController.completedMessage);

    // Another tap is a no-op success: nothing is called, stock is not touched.
    s.calls.clear();
    expect(await submit(), isTrue);
    expect(s.calls, isEmpty);
    expect(s.stockConsumed, 1);
  });

  test('Delayed between the two uploads: Storage refuses the invoice, nothing is recorded, the retry uploads only the invoice', () async {
    s.after = (step) {
      if (step == 'upload-proof') s.set('delayed');
    };

    expect(await submit(), isFalse);
    expect(s.calls, ['fetch', 'geofence', 'upload-proof', 'upload-invoice:refused']);
    expectNothingSettled();
    expect(c.errorMessage, contains('permission denied'));
    expect(c.errorMessage, isNot(contains('No connection')));
    expect(s.order['proofSubmittedAt'], isNull, reason: 'a lone proof is never recorded');
    expect(c.hasPendingUpload, isTrue, reason: 'the uploaded proof is kept for the retry');
    expect(retryOffered(), isTrue);

    s.after = null;
    s.set('in_transit');
    s.calls.clear();
    expect(await submit(), isTrue);
    expect(s.calls, ['fetch', 'geofence', 'upload-invoice', 'record-proof', 'record-invoice', 'complete']);
    expect(s.stockConsumed, 1);
  });

  test('Delayed after the proof is recorded: the invoice record is refused; the retry records only the invoice', () async {
    s.after = (step) {
      if (step == 'record-proof') s.set('delayed');
    };

    expect(await submit(), isFalse);
    expect(s.calls, ['fetch', 'geofence', 'upload-proof', 'upload-invoice', 'record-proof', 'record-invoice:refused']);
    expectNothingSettled();
    expect(c.errorMessage, kDelayedNotCompletableMessage);
    expect(c.isProofSaved, isTrue);
    expect(c.hasPendingInvoiceUpload, isTrue);
    // The proof is recorded; only the invoice is outstanding.
    expect(
        c.canSubmitAndComplete(
            recipientName: '',
            hasProofPhoto: false,
            hasInvoicePhoto: true,
            proofRecorded: true,
            invoiceRecorded: false),
        isTrue);

    s.after = null;
    s.set('in_transit');
    s.calls.clear();
    expect(await submit(), isTrue);
    expect(s.calls, ['fetch', 'geofence', 'record-invoice', 'complete'],
        reason: 'no upload and no second proof record');
    expect(s.stockConsumed, 1);
  });
}
