import 'dart:async';
import 'dart:io';

import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/screens/proof_submission_controller.dart';
import 'package:vaxtrack_mobile/services/delivery_service.dart';
import 'package:vaxtrack_mobile/services/image_upload_service.dart';
import 'package:vaxtrack_mobile/services/proof_service.dart';
import 'package:vaxtrack_mobile/utils/delivery_geofence_messages.dart';
import 'package:vaxtrack_mobile/utils/order_workflow.dart';
import 'package:vaxtrack_mobile/utils/proof_validation.dart';
import 'package:vaxtrack_mobile/widgets/complete_delivery_confirm_sheet.dart';

/// Clinic delivery geofence in the Rider app: the SERVER preflight runs before
/// any upload; a refusal uploads, records and completes nothing and keeps the
/// photos; the completion's own server re-check is reported as its real
/// reason with a completion-only retry. Every collaborator is a logging fake.

const orderId = 'GeoOrder123';
final proofFile = File('proof.jpg');
final invoiceFile = File('invoice.jpg');

class _Log {
  final List<String> calls = [];
}

class _Uploader implements ProofUploader {
  _Uploader(this.log);
  final _Log log;
  final List<File> proofFiles = [];
  final List<File> invoiceFiles = [];

  @override
  Future<EvidenceUpload> uploadProof(String id, File file) async {
    log.calls.add('upload-proof');
    proofFiles.add(file);
    return EvidenceUpload(downloadUrl: 'https://storage/$id/proof.jpg', storagePath: proofObjectPath(id));
  }

  @override
  Future<EvidenceUpload> uploadInvoice(String id, File file) async {
    log.calls.add('upload-invoice');
    invoiceFiles.add(file);
    return EvidenceUpload(downloadUrl: 'https://storage/$id/invoice.jpg', storagePath: invoiceObjectPath(id));
  }

  @override
  Future<String?> existingProofUrl(String id) async => null;

  @override
  Future<String?> existingInvoiceUrl(String id) async => null;
}

class _Writer implements ProofMetadataWriter {
  _Writer(this.log);
  final _Log log;

  @override
  Future<void> saveProofOfDelivery({
    required String orderId,
    required String recipientName,
    required String proofUrl,
    String? storagePath,
  }) async =>
      log.calls.add('record-proof');

  @override
  Future<void> saveInvoicePhoto({required String orderId, required String invoiceUrl, String? storagePath}) async =>
      log.calls.add('record-invoice');
}

class _Completer implements DeliveryCompleter {
  _Completer(this.log);
  final _Log log;
  final List<Object?> results = [];

  @override
  Future<void> markDelivered(String id, String currentStatus) async {
    log.calls.add('complete');
    final next = results.isEmpty ? null : results.removeAt(0);
    if (next != null) throw next;
  }
}

class _Geofence implements DeliveryGeofenceChecker {
  _Geofence(this.log);
  final _Log log;

  /// Errors thrown by the next checks, in order; null = eligible.
  final List<Object?> results = [];
  Completer<void>? gate;

  @override
  Future<DeliveryGeofenceResult> checkDeliveryGeofence(String id) async {
    log.calls.add('geofence');
    if (gate != null) await gate!.future;
    final next = results.isEmpty ? null : results.removeAt(0);
    if (next != null) throw next;
    return const DeliveryGeofenceResult(eligible: true, distanceM: 40, radiusM: 300, locationAgeSeconds: 25, accuracyM: 9);
  }
}

WorkflowException refusal(String code, {Map<String, Object?>? info}) =>
    WorkflowException(code, deliveryLocationMessage(code, info: info) ?? code);

void main() {
  late _Log log;
  late _Uploader uploader;
  late _Completer completer;
  late _Geofence geofence;
  late ProofSubmissionController c;

  setUp(() {
    log = _Log();
    uploader = _Uploader(log);
    completer = _Completer(log);
    geofence = _Geofence(log);
    c = ProofSubmissionController(
      uploader: uploader,
      writer: _Writer(log),
      completer: completer,
      geofence: geofence,
    );
  });

  Future<bool> run({bool proofRecorded = false, bool invoiceRecorded = false}) => c.submitAndComplete(
        orderId: orderId,
        currentStatus: 'in_transit',
        proofRecorded: proofRecorded,
        invoiceRecorded: invoiceRecorded,
        recipientName: 'Maria Santos',
        proofPhoto: proofFile,
        invoicePhoto: invoiceFile,
      );

  test('the server preflight runs before either upload; eligible continues with one upload per image', () async {
    expect(await run(), isTrue);
    expect(log.calls, ['geofence', 'upload-proof', 'upload-invoice', 'record-proof', 'record-invoice', 'complete']);
    expect(uploader.proofFiles, [proofFile]);
    expect(uploader.invoiceFiles, [invoiceFile]);
    expect(c.isCompleted, isTrue);
  });

  test('"Checking delivery location…" is shown while the server decides', () async {
    geofence.gate = Completer<void>();
    final pending = run();
    await pumpEventQueue();
    expect(c.progressText, 'Checking delivery location…');
    expect(c.isCommitting, isTrue);
    geofence.gate!.complete();
    expect(await pending, isTrue);
  });

  group('every refusal uploads, records and completes nothing — and keeps the photos', () {
    final cases = <String, (WorkflowException, String)>{
      'outside': (
        refusal(kGeofenceOutside, info: {'distanceM': 452, 'radiusM': 300}),
        'You are 452 m from the clinic. Move within the 300 m delivery area before submitting.'
      ),
      'stale': (refusal(kGeofenceStale), kStaleLocationMessage),
      'inaccurate': (refusal(kGeofenceInaccurate), kInaccurateLocationMessage),
      'tracking stopped': (refusal(kGeofenceUnavailable), kTrackingStoppedMessage),
      'destination invalid': (refusal(kGeofenceDestinationInvalid), kDestinationInvalidMessage),
      'reassigned': (refusal('not-assigned-rider'), kNotCompletableMessage),
      'inactive': (refusal('invalid-status-transition'), kNotCompletableMessage),
    };
    cases.forEach((name, value) {
      test(name, () async {
        final (error, message) = value;
        geofence.results.add(error);
        expect(await run(), isFalse);
        expect(log.calls, ['geofence'], reason: 'no upload, record or completion');
        expect(c.errorMessage, message);
        expect(c.isCommitting, isFalse);
        expect(c.hasPendingUpload, isFalse);
        expect(c.isProofSaved, isFalse);
        // The same selected photos are still usable: pressing again (now
        // eligible) uploads each exactly once and completes.
        expect(
            c.canSubmitAndComplete(
                recipientName: 'Maria Santos',
                hasProofPhoto: true,
                hasInvoicePhoto: true,
                proofRecorded: false,
                invoiceRecorded: false),
            isTrue);
        expect(await run(), isTrue);
        expect(log.calls,
            ['geofence', 'geofence', 'upload-proof', 'upload-invoice', 'record-proof', 'record-invoice', 'complete']);
        expect(uploader.proofFiles, [proofFile]);
      });
    });
  });

  test('a refusal never completes by itself later — only a new press does', () async {
    geofence.results.add(refusal(kGeofenceOutside, info: {'distanceM': 600, 'radiusM': 300}));
    expect(await run(), isFalse);
    await pumpEventQueue();
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(log.calls, ['geofence']);
  });

  test('a connection failure at the preflight keeps the photos and uploads nothing', () async {
    geofence.results.add(FirebaseFunctionsException(code: 'unavailable', message: 'unavailable'));
    expect(await run(), isFalse);
    expect(log.calls, ['geofence']);
    expect(c.errorMessage, contains('Your photos are kept'));
  });

  test('repeated taps: one preflight, one upload each, one completion', () async {
    geofence.gate = Completer<void>();
    final taps = List.generate(5, (_) => run());
    geofence.gate!.complete();
    final results = await Future.wait(taps);
    expect(results.where((r) => r).length, 1);
    expect(log.calls, ['geofence', 'upload-proof', 'upload-invoice', 'record-proof', 'record-invoice', 'complete']);
  });

  group('the final server re-check (location changed during upload)', () {
    test('refusal at completion: real reason shown, nothing delivered, retry is completion-only', () async {
      completer.results.add(refusal(kGeofenceOutside, info: {'distanceM': 340, 'radiusM': 300}));
      expect(await run(), isFalse);
      expect(c.isCompletionPending, isTrue);
      expect(c.isCompleted, isFalse);
      expect(c.errorMessage, 'You are 340 m from the clinic. Move within the 300 m delivery area before submitting.');
      expect(c.completionFailureDetail, ProofSubmissionController.evidenceKeptMessage);

      // Back inside: the retry re-checks, then completes — no upload, no record.
      expect(await run(), isTrue);
      expect(log.calls, [
        'geofence', 'upload-proof', 'upload-invoice', 'record-proof', 'record-invoice', 'complete',
        'geofence', 'complete',
      ]);
    });

    test('reassignment after the preflight: the not-completable reason, no duplicate evidence', () async {
      completer.results.add(refusal('not-assigned-rider'));
      expect(await run(), isFalse);
      expect(c.errorMessage, kNotCompletableMessage);
      expect(c.isCompletionPending, isTrue);
    });

    test('a refused preflight during a completion-only retry calls nothing and keeps the retry', () async {
      completer.results.add(refusal(kGeofenceStale));
      expect(await run(), isFalse);
      geofence.results.add(refusal(kGeofenceStale));
      expect(await run(), isFalse);
      // Only the first attempt uploaded and recorded (2 uploads + 2 records).
      expect(log.calls.where((x) => x.startsWith('upload') || x.startsWith('record')).length, 4);
      expect(log.calls.where((x) => x == 'complete').length, 1, reason: 'no completion call after the refused preflight');
      expect(c.isCompletionPending, isTrue);
      expect(c.errorMessage, kStaleLocationMessage);
      expect(c.completionFailureDetail, ProofSubmissionController.evidenceKeptMessage);
    });
  });

  group('callable errors become Rider wording (DeliveryService)', () {
    WorkflowException map(String code, [Map<String, Object?>? info, String message = 'server text']) =>
        callableFailure(
          FirebaseFunctionsException(
              code: 'failed-precondition', message: message, details: {'code': code, 'info': ?info}),
          'fallback',
        );

    test('each geofence code maps to its message; the decision values are display-only', () {
      expect(map(kGeofenceOutside, {'distanceM': 452, 'radiusM': 300}).message,
          'You are 452 m from the clinic. Move within the 300 m delivery area before submitting.');
      expect(map(kGeofenceStale).message, kStaleLocationMessage);
      expect(map(kGeofenceInaccurate).message, kInaccurateLocationMessage);
      expect(map(kGeofenceUnavailable).message, kTrackingStoppedMessage);
      expect(map(kGeofenceDestinationInvalid).message, kDestinationInvalidMessage);
      expect(map('not-assigned-rider').message, kNotCompletableMessage);
      expect(map('invalid-status-transition').code, 'invalid-status-transition');
      // Other domain refusals keep the server's sentence.
      expect(map('order-not-fully-reserved', null, 'Needs dispatcher review.').message, 'Needs dispatcher review.');
      // No domain code: Firebase's own code survives (a dropped connection).
      final dropped = callableFailure(FirebaseFunctionsException(code: 'unavailable', message: 'x'), 'fallback');
      expect(dropped.code, 'unavailable');
    });
  });

  group('long messages fit at 320 dp and large text', () {
    final longest = [
      'You are 99999 m from the clinic. Move within the 1000 m delivery area before submitting.\n'
          '${ProofSubmissionController.evidenceKeptMessage}',
      kInaccurateLocationMessage,
      kDestinationInvalidMessage,
    ];
    for (final scale in [1.0, 1.5, 2.0]) {
      for (final message in longest) {
        testWidgets('scale $scale: ${message.substring(0, 24)}…', (tester) async {
          tester.view.physicalSize = const Size(320, 900);
          tester.view.devicePixelRatio = 1.0;
          addTearDown(tester.view.reset);
          await tester.pumpWidget(MaterialApp(
            builder: (context, child) =>
                MediaQuery(data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)), child: child!),
            home: Builder(
              builder: (context) => Scaffold(
                body: Center(
                  child: ElevatedButton(
                    onPressed: () => showModalBottomSheet<bool>(
                      context: context,
                      isScrollControlled: true,
                      builder: (_) => CompleteDeliveryConfirmSheet(
                        orderNumber: 'VT-ORD-1785072279117',
                        destinationTitle: 'Dr. Ana Reyes — Laguna Provincial Clinic and Diagnostics',
                        destinationSubtitle: '1 National Highway, Barangay San Antonio, Santa Rosa, Laguna',
                        proofImageUrl: 'https://example.test/proof.jpg',
                        invoiceImageUrl: 'https://example.test/invoice.jpg',
                        onConfirm: () async => throw ProofException('not-completed', message),
                      ),
                    ),
                    child: const Text('open'),
                  ),
                ),
              ),
            ),
          ));
          await tester.tap(find.text('open'));
          await tester.pumpAndSettle();
          await tester.ensureVisible(find.text('Confirm Delivery'));
          await tester.pumpAndSettle();
          await tester.tap(find.text('Confirm Delivery'));
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull, reason: 'no RenderFlex overflow');
          await tester.ensureVisible(find.textContaining(message.split('\n').first));
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
          expect(find.textContaining(message.split('\n').first), findsOneWidget);
        });
      }
    }
  });
}
