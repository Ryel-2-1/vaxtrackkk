import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/models/delivery.dart';
import 'package:vaxtrack_mobile/screens/proof_submission_controller.dart';
import 'package:vaxtrack_mobile/services/delivery_service.dart';
import 'package:vaxtrack_mobile/services/image_upload_service.dart';
import 'package:vaxtrack_mobile/services/proof_service.dart';
import 'package:vaxtrack_mobile/utils/delivery_buckets.dart';
import 'package:vaxtrack_mobile/utils/order_workflow.dart';
import 'package:vaxtrack_mobile/utils/proof_validation.dart';
import 'package:vaxtrack_mobile/widgets/complete_delivery_confirm_sheet.dart';

/// "Submit Proof & Complete Delivery": one action that uploads both photos,
/// records them and calls the trusted completion — in that order, each step
/// only once, and never reporting a delivery as complete unless the server
/// completed it. Every collaborator is a fake that logs what happened, so the
/// tests assert the SEQUENCE and the COUNTS, not just the end state.

const orderId = 'UcwuVXjlBAzZuYMKeHK0';
final proofFile = File('proof.jpg');
final invoiceFile = File('invoice.jpg');

class _Log {
  final List<String> calls = [];
}

class _Uploader implements ProofUploader {
  _Uploader(this.log);
  final _Log log;
  Object? proofError;
  Object? invoiceError;
  String? existingProof;
  String? existingInvoice;
  Completer<void>? gate;

  @override
  Future<EvidenceUpload> uploadProof(String id, File file) async {
    log.calls.add('upload-proof');
    if (gate != null) await gate!.future;
    if (proofError != null) throw proofError!;
    return EvidenceUpload(
        downloadUrl: 'https://storage/$id/proof.jpg', storagePath: proofObjectPath(id));
  }

  @override
  Future<EvidenceUpload> uploadInvoice(String id, File file) async {
    log.calls.add('upload-invoice');
    if (invoiceError != null) throw invoiceError!;
    return EvidenceUpload(
        downloadUrl: 'https://storage/$id/invoice.jpg', storagePath: invoiceObjectPath(id));
  }

  @override
  Future<String?> existingProofUrl(String id) async => existingProof;

  @override
  Future<String?> existingInvoiceUrl(String id) async => existingInvoice;
}

class _Writer implements ProofMetadataWriter {
  _Writer(this.log);
  final _Log log;
  Object? proofError;
  final List<Map<String, String?>> proofs = [];
  final List<Map<String, String?>> invoices = [];

  @override
  Future<void> saveProofOfDelivery({
    required String orderId,
    required String recipientName,
    required String proofUrl,
    String? storagePath,
  }) async {
    log.calls.add('record-proof');
    if (proofError != null) throw proofError!;
    proofs.add({'name': recipientName, 'url': proofUrl, 'path': storagePath});
  }

  @override
  Future<void> saveInvoicePhoto({
    required String orderId,
    required String invoiceUrl,
    String? storagePath,
  }) async {
    log.calls.add('record-invoice');
    invoices.add({'url': invoiceUrl, 'path': storagePath});
  }
}

class _Completer implements DeliveryCompleter {
  _Completer(this.log);
  final _Log log;

  /// Errors thrown by the next calls, in order; null = succeed.
  final List<Object?> results = [];

  @override
  Future<void> markDelivered(String id, String currentStatus) async {
    log.calls.add('complete:$id:$currentStatus');
    final next = results.isEmpty ? null : results.removeAt(0);
    if (next != null) throw next;
  }
}

/// The server geofence preflight, always eligible here: these tests are about
/// evidence and completion. test/delivery_geofence_test.dart covers refusals.
class _InsideClinic implements DeliveryGeofenceChecker {
  @override
  Future<DeliveryGeofenceResult> checkDeliveryGeofence(String orderId) async =>
      const DeliveryGeofenceResult(eligible: true, distanceM: 12, radiusM: 300, locationAgeSeconds: 20, accuracyM: 8);
}

void main() {
  late _Log log;
  late _Uploader uploader;
  late _Writer writer;
  late _Completer completer;
  late ProofSubmissionController c;

  setUp(() {
    log = _Log();
    uploader = _Uploader(log);
    writer = _Writer(log);
    completer = _Completer(log);
    c = ProofSubmissionController(uploader: uploader, writer: writer, completer: completer, geofence: _InsideClinic());
  });

  Future<bool> run({
    bool proofRecorded = false,
    bool invoiceRecorded = false,
    String name = 'Maria Santos',
    File? proof,
    File? invoice,
    bool useDefaults = true,
  }) =>
      c.submitAndComplete(
        orderId: orderId,
        currentStatus: 'in_transit',
        proofRecorded: proofRecorded,
        invoiceRecorded: invoiceRecorded,
        recipientName: name,
        proofPhoto: useDefaults ? (proof ?? proofFile) : proof,
        invoicePhoto: useDefaults ? (invoice ?? invoiceFile) : invoice,
      );

  group('1. the happy path', () {
    test('uploads both, records both, THEN completes — once each', () async {
      expect(await run(), isTrue);
      expect(log.calls, [
        'upload-proof',
        'upload-invoice',
        'record-proof',
        'record-invoice',
        'complete:$orderId:in_transit',
      ]);
      expect(writer.proofs.single,
          {'name': 'Maria Santos', 'url': 'https://storage/$orderId/proof.jpg', 'path': proofObjectPath(orderId)});
      expect(writer.invoices.single['path'], invoiceObjectPath(orderId));
      expect(c.isCompleted, isTrue);
      expect(c.noticeMessage, ProofSubmissionController.completedMessage);
      expect(c.errorMessage, isNull);
    });

    test('14. progress is narrated step by step', () async {
      final seen = <String>[];
      c.addListener(() {
        final t = c.progressText;
        if (t != null && (seen.isEmpty || seen.last != t)) seen.add(t);
      });
      await run();
      expect(seen, [
        'Preparing proof…',
        'Checking delivery location…',
        'Uploading proof photo (1 of 2)…',
        'Uploading invoice photo (2 of 2)…',
        'Saving proof details…',
        'Completing delivery…',
      ]);
      expect(c.progressText, isNull, reason: 'no spinner once completed');
    });
  });

  group('2/3. an upload failure never records or completes anything', () {
    test('2. proof upload fails: nothing recorded, no completion; retry finishes', () async {
      uploader.proofError =
          FirebaseException(plugin: 'firebase_storage', code: 'retry-limit-exceeded');
      expect(await run(), isFalse);
      expect(log.calls, ['upload-proof']);
      expect(c.errorMessage, contains('No connection'));
      expect(c.isCompletionPending, isFalse);

      uploader.proofError = null;
      log.calls.clear();
      expect(await run(), isTrue);
      expect(log.calls.last, 'complete:$orderId:in_transit');
    });

    test('3. invoice upload fails: the uploaded proof is NOT recorded alone, and is reused on retry', () async {
      uploader.invoiceError =
          FirebaseException(plugin: 'firebase_storage', code: 'unauthorized');
      expect(await run(), isFalse);
      expect(log.calls, ['upload-proof', 'upload-invoice'],
          reason: 'never one image recorded, never a completion');
      expect(writer.proofs, isEmpty);
      expect(c.errorMessage, contains('permission denied'));
      expect(c.hasPendingUpload, isTrue, reason: 'the proof upload is kept');

      uploader.invoiceError = null;
      log.calls.clear();
      expect(await run(), isTrue);
      expect(log.calls, [
        'upload-invoice', // the proof is NOT uploaded again
        'record-proof',
        'record-invoice',
        'complete:$orderId:in_transit',
      ]);
    });
  });

  group('4/5. completion failure and recovery', () {
    test('4. both uploads recorded but completion fails: pending message, retry runs completion only', () async {
      completer.results.add(const WorkflowException('unavailable', 'UNAVAILABLE'));
      expect(await run(), isFalse);
      expect(c.isCompleted, isFalse);
      expect(c.isCompletionPending, isTrue);
      expect(c.errorMessage,
          'Evidence uploaded, but delivery completion is still pending. Retry completion.');
      expect(c.completionFailureDetail, 'No connection. Retry once you are back online.');

      log.calls.clear();
      // The retry needs no photos at all.
      expect(await run(proof: null, invoice: null, useDefaults: false, name: ''), isTrue);
      expect(log.calls, ['complete:$orderId:in_transit']);
      expect(c.isCompletionPending, isFalse);
      expect(c.errorMessage, isNull);
    });

    test('4. a server refusal is shown as its own reason under the pending message', () async {
      // (Location / assignment refusals have their own path: see
      // test/delivery_geofence_test.dart.)
      completer.results.add(const WorkflowException('order-not-fully-reserved',
          "This delivery's stock is not fully reserved and needs dispatcher review."));
      expect(await run(), isFalse);
      expect(c.errorMessage, ProofSubmissionController.completionPendingMessage);
      expect(c.completionFailureDetail,
          "This delivery's stock is not fully reserved and needs dispatcher review.");
    });

    test('5. earlier-session evidence already recorded: completion only, no new photos', () async {
      expect(
        await run(proofRecorded: true, invoiceRecorded: true, proof: null, invoice: null, useDefaults: false, name: ''),
        isTrue,
      );
      expect(log.calls, ['complete:$orderId:in_transit']);
    });

    test('5. uploads recovered from Storage are reused — but only after the rider submits', () async {
      uploader.existingProof = 'https://storage/$orderId/proof.jpg';
      uploader.existingInvoice = 'https://storage/$orderId/invoice.jpg';
      await c.recoverPendingUpload(orderId, includeInvoice: true);
      expect(log.calls, isEmpty, reason: 'recovery alone records and completes nothing');
      expect(c.pendingProofUrl, isNotNull);
      expect(c.pendingInvoiceUrl, isNotNull);
      expect(c.noticeMessage, contains('will be reused'));

      expect(await run(proof: null, invoice: null, useDefaults: false), isTrue);
      expect(log.calls, ['record-proof', 'record-invoice', 'complete:$orderId:in_transit'],
          reason: 'no new upload');
    });

    test('5. a proof recorded by a lost-reply save is treated as recorded, not as a failure', () async {
      writer.proofError =
          const ProofException('proof-already-finalized', 'Proof is already recorded.');
      expect(await run(), isTrue);
      expect(log.calls.last, 'complete:$orderId:in_transit');
    });
  });

  group('6. missing evidence stops everything before any upload', () {
    test('no proof photo', () async {
      expect(await run(proof: null, useDefaults: false, invoice: invoiceFile), isFalse);
      expect(log.calls, isEmpty);
      expect(c.errorMessage, 'Take a proof photo before submitting.');
    });

    test('no invoice photo — the proof is not uploaded on its own', () async {
      expect(await run(invoice: null, useDefaults: false, proof: proofFile), isFalse);
      expect(log.calls, isEmpty);
      expect(c.errorMessage, 'Add the invoice photo before submitting.');
    });

    test('no recipient name', () async {
      expect(await run(name: '   '), isFalse);
      expect(log.calls, isEmpty);
    });

    test('the button stays disabled until both photos and a name are present', () {
      bool ready({String name = 'Maria', bool p = true, bool i = true, bool pr = false, bool ir = false}) =>
          c.canSubmitAndComplete(
              recipientName: name, hasProofPhoto: p, hasInvoicePhoto: i, proofRecorded: pr, invoiceRecorded: ir);
      expect(ready(), isTrue);
      expect(ready(p: false), isFalse);
      expect(ready(i: false), isFalse);
      expect(ready(name: ''), isFalse);
      expect(ready(name: '', p: false, i: false, pr: true, ir: true), isTrue,
          reason: 'recorded evidence: only completion is left');
      expect(ready(p: false, pr: true, i: false), isFalse, reason: 'invoice still missing');
    });
  });

  group('9. duplicate taps', () {
    test('five calls in one event turn produce one of each step', () async {
      uploader.gate = Completer<void>();
      final calls = List.generate(5, (_) => run());
      uploader.gate!.complete();
      final results = await Future.wait(calls);
      expect(results.where((r) => r).length, 1);
      expect(log.calls, [
        'upload-proof',
        'upload-invoice',
        'record-proof',
        'record-invoice',
        'complete:$orderId:in_transit',
      ]);
    });

    test('once completed, the action cannot run again', () async {
      await run();
      expect(
          c.canSubmitAndComplete(
              recipientName: 'Maria', hasProofPhoto: true, hasInvoicePhoto: true, proofRecorded: true, invoiceRecorded: true),
          isFalse);
    });

    test('the button is disabled while processing', () async {
      uploader.gate = Completer<void>();
      final pending = run();
      expect(c.isCommitting, isTrue);
      expect(
          c.canSubmitAndComplete(
              recipientName: 'Maria', hasProofPhoto: true, hasInvoicePhoto: true, proofRecorded: false, invoiceRecorded: false),
          isFalse);
      uploader.gate!.complete();
      await pending;
    });
  });

  group('recorded evidence on the order (mirrors the server rule)', () {
    Delivery order({
      String? proofUrl = 'https://storage/p.jpg',
      String? proofPath,
      DateTime? proofAt,
      String? recipient = 'Maria',
      String? invoiceUrl = 'https://storage/i.jpg',
      String? invoicePath,
      DateTime? invoiceAt,
    }) =>
        Delivery(
          id: orderId,
          orderNumber: 'VT-ORD-1',
          clinicName: 'Clinic',
          clinicAddress: 'Address',
          vaccineName: 'Vaccine',
          quantity: 1,
          unit: 'vials',
          priority: 'Standard',
          status: 'in_transit',
          statusLabel: 'In Transit',
          proofOfDeliveryUrl: proofUrl,
          proofOfDeliveryPath: proofPath,
          proofSubmittedAt: proofAt,
          proofRecipientName: recipient,
          invoiceUrl: invoiceUrl,
          invoicePath: invoicePath,
          invoiceSubmittedAt: invoiceAt,
        );
    final at = DateTime(2026, 10, 5);

    test('canonical, submitted evidence counts', () {
      final d = order(
          proofPath: proofObjectPath(orderId), proofAt: at, invoicePath: invoiceObjectPath(orderId), invoiceAt: at);
      expect(d.hasRecordedProof, isTrue);
      expect(d.hasRecordedInvoice, isTrue);
      expect(d.hasRecordedEvidence, isTrue);
    });

    test('a bare legacy URL or an unsubmitted file does not', () {
      expect(order().hasRecordedProof, isFalse, reason: 'bare URLs only');
      expect(order(proofPath: proofObjectPath(orderId)).hasRecordedProof, isFalse, reason: 'never submitted');
      expect(order(proofAt: at).hasRecordedProof, isFalse, reason: 'no canonical path');
      expect(order(proofPath: proofObjectPath('other'), proofAt: at).hasRecordedProof, isFalse);
      expect(order(invoicePath: invoiceObjectPath(orderId)).hasRecordedInvoice, isFalse);
      expect(order(proofPath: proofObjectPath(orderId), proofAt: at, recipient: ' ').hasRecordedProof, isFalse);
    });
  });

  group('13. Dashboard and Completed tab', () {
    Delivery d(String id, String status) => Delivery(
          id: id,
          orderNumber: id,
          clinicName: 'C',
          clinicAddress: 'A',
          vaccineName: 'V',
          quantity: 1,
          unit: 'vials',
          priority: 'Standard',
          status: status,
          statusLabel: status,
        );

    test('a server-completed order moves from Active to Completed and the counts follow', () {
      final before = DeliveryBuckets([d('a', 'in_transit'), d('b', 'assigned'), d('c', 'delivered')]);
      expect([before.total, before.done, before.remaining], [3, 1, 2]);
      expect(before.active.map((x) => x.id), ['a', 'b']);

      // The live stream's next snapshot after the callable succeeded.
      final after = DeliveryBuckets([d('a', 'delivered'), d('b', 'assigned'), d('c', 'delivered')]);
      expect([after.total, after.done, after.remaining], [3, 2, 1]);
      expect(after.completed.map((x) => x.id), ['a', 'c']);
      expect(after.active.map((x) => x.id), ['b']);
    });

    test('cancelled orders are neither active nor completed', () {
      final b = DeliveryBuckets([d('x', 'cancelled')]);
      expect([b.total, b.done, b.remaining], [1, 0, 0]);
    });
  });

  group('the confirmation sheet', () {
    final pixel = MemoryImage(Uint8List.fromList(const [
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
      0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
      0x42, 0x60, 0x82,
    ]));

    Future<bool?> openSheet(WidgetTester tester, Future<void> Function() onConfirm) async {
      bool? popped;
      await tester.pumpWidget(MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () async {
                  popped = await showModalBottomSheet<bool>(
                    context: context,
                    isScrollControlled: true,
                    builder: (_) => CompleteDeliveryConfirmSheet(
                      orderNumber: 'VT-ORD-1791190448932-UCWU',
                      destinationTitle: 'Laguna Clinic',
                      destinationSubtitle: '1 National Highway',
                      proofImage: pixel,
                      invoiceImage: pixel,
                      title: 'Submit proof & complete this delivery?',
                      confirmLabel: 'Submit & Complete',
                      progress: c,
                      progressText: () => c.progressText,
                      onConfirm: onConfirm,
                    ),
                  );
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      return popped;
    }

    testWidgets('shows order, destination, both previews and the stock warning', (tester) async {
      await openSheet(tester, () async {});
      expect(find.text('Submit proof & complete this delivery?'), findsOneWidget);
      expect(find.text('Order VT-ORD-1791190448932-UCWU'), findsOneWidget);
      expect(find.text('Laguna Clinic'), findsOneWidget);
      expect(find.text('Proof of delivery'), findsOneWidget);
      expect(find.text('Invoice'), findsOneWidget);
      expect(find.byType(Image), findsNWidgets(2));
      expect(find.textContaining('cannot be casually reversed'), findsOneWidget);
      expect(find.text('Submit & Complete'), findsOneWidget);
    });

    testWidgets('14. narrates progress, then on a completion failure stays open with the pending message and retries',
        (tester) async {
      uploader.gate = Completer<void>();
      completer.results.add(const WorkflowException('unavailable', 'UNAVAILABLE'));
      Future<void> confirm() async {
        final ok = await run();
        if (!ok) {
          throw ProofException('not-completed', c.errorMessage!);
        }
      }

      await openSheet(tester, confirm);
      await tester.tap(find.text('Submit & Complete'));
      await tester.pump();
      expect(find.byKey(const ValueKey('confirm-sheet-progress')), findsOneWidget);
      expect(find.text('Uploading proof photo (1 of 2)…'), findsOneWidget);

      uploader.gate!.complete();
      await tester.pumpAndSettle();
      // Still open, not completed, with the exact pending message.
      expect(find.text(ProofSubmissionController.completionPendingMessage), findsOneWidget);
      expect(find.text('Submit & Complete'), findsOneWidget);

      // Retry from the same sheet: completion only.
      log.calls.clear();
      await tester.tap(find.text('Submit & Complete'));
      await tester.pumpAndSettle();
      expect(log.calls, ['complete:$orderId:in_transit']);
      expect(find.text('Submit & Complete'), findsNothing, reason: 'closed on success');
    });
  });
}
