import 'dart:async';
import 'dart:io';

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/screens/proof_submission_controller.dart';
import 'package:vaxtrack_mobile/services/image_upload_service.dart';
import 'package:vaxtrack_mobile/services/proof_service.dart';
import 'package:vaxtrack_mobile/utils/proof_validation.dart';

/// Records every call so a test can assert HOW MANY happened, not just that the
/// end state looked right. Counting is the whole point: the defects this
/// controller fixes were all about doing something twice, or doing the wrong
/// half of it again.
class _FakeUploader implements ProofUploader {
  int proofUploads = 0;
  int invoiceUploads = 0;
  int existingLookups = 0;

  Object? uploadError;
  Object? existingError;
  String? existingUrl;

  /// Completed manually so a test can hold an upload open and fire more calls
  /// while it is still in flight.
  Completer<EvidenceUpload>? gate;

  @override
  Future<EvidenceUpload> uploadProof(String orderId, File file) async {
    proofUploads += 1;
    if (uploadError != null) throw uploadError!;
    if (gate != null) return gate!.future;
    return EvidenceUpload(
      downloadUrl: 'https://storage/$orderId/proof.jpg',
      storagePath: proofObjectPath(orderId),
    );
  }

  @override
  Future<EvidenceUpload> uploadInvoice(String orderId, File file) async {
    invoiceUploads += 1;
    return EvidenceUpload(
      downloadUrl: 'https://storage/$orderId/invoice.jpg',
      storagePath: invoiceObjectPath(orderId),
    );
  }

  @override
  Future<String?> existingProofUrl(String orderId) async {
    existingLookups += 1;
    if (existingError != null) throw existingError!;
    return existingUrl;
  }
}

class _SavedProof {
  _SavedProof(this.orderId, this.recipientName, this.proofUrl, this.storagePath);
  final String orderId;
  final String recipientName;
  final String proofUrl;
  final String? storagePath;
}

class _FakeWriter implements ProofMetadataWriter {
  final List<_SavedProof> proofSaves = [];
  final List<String> invoiceSaves = [];

  /// Number of leading proof saves that should fail, so a test can make the
  /// first attempt fail and the retry succeed.
  int failProofSaves = 0;
  bool failInvoiceSaves = false;

  @override
  Future<void> saveProofOfDelivery({
    required String orderId,
    required String recipientName,
    required String proofUrl,
    String? storagePath,
  }) async {
    if (failProofSaves > 0) {
      failProofSaves -= 1;
      throw const ProofException('unavailable', 'network unavailable');
    }
    proofSaves.add(_SavedProof(orderId, recipientName, proofUrl, storagePath));
  }

  @override
  Future<void> saveInvoicePhoto({
    required String orderId,
    required String invoiceUrl,
    String? storagePath,
  }) async {
    if (failInvoiceSaves) {
      throw const ProofException('unavailable', 'network unavailable');
    }
    invoiceSaves.add(orderId);
  }
}

void main() {
  const orderId = 'JDP0JzdWMnegoeAz3Zq9';
  final photo = File('proof-source.jpg');

  late _FakeUploader uploader;
  late _FakeWriter writer;

  ProofSubmissionController build({bool allowManualUrl = false}) =>
      ProofSubmissionController(
        uploader: uploader,
        writer: writer,
        allowManualUrl: allowManualUrl,
      );

  setUp(() {
    uploader = _FakeUploader();
    writer = _FakeWriter();
  });

  group('duplicate-submission guard', () {
    test('five calls in ONE event turn produce one upload and one save', () {
      // The regression case. A disabled button is feedback, not concurrency
      // control: `onPressed: null` only applies after a rebuild, so several
      // taps delivered in the same turn all reach the handler first. The guard
      // is set synchronously at the top of submit(), before any await.
      final c = build();
      final futures = <Future<void>>[];
      for (var i = 0; i < 5; i++) {
        futures.add(c.submit(
          orderId: orderId,
          recipientName: 'Maria Santos',
          proofPhoto: photo,
        ));
      }

      return Future.wait(futures).then((_) {
        expect(uploader.proofUploads, 1);
        expect(writer.proofSaves.length, 1);
        expect(c.phase, ProofPhase.submitted);
      });
    });

    test('re-entrant calls DURING an in-flight upload are ignored', () async {
      // Holds the upload open, then fires four more calls while it is running —
      // the case a guard reset too early would let through.
      uploader.gate = Completer<EvidenceUpload>();
      final c = build();

      final first = c.submit(
          orderId: orderId, recipientName: 'Maria Santos', proofPhoto: photo);
      await Future<void>.delayed(Duration.zero);
      expect(c.phase, ProofPhase.uploadingPhoto);

      for (var i = 0; i < 4; i++) {
        await c.submit(
            orderId: orderId, recipientName: 'Maria Santos', proofPhoto: photo);
      }
      expect(uploader.proofUploads, 1);

      uploader.gate!.complete(EvidenceUpload(
        downloadUrl: 'https://storage/$orderId/proof.jpg',
        storagePath: proofObjectPath(orderId),
      ));
      await first;

      expect(uploader.proofUploads, 1);
      expect(writer.proofSaves.length, 1);
    });

    test('the guard is released so a later, deliberate retry still works', () {
      // Reset in `finally`: a guard that leaked would leave the screen dead
      // after the first failure.
      writer.failProofSaves = 1;
      final c = build();
      return c
          .submit(
              orderId: orderId,
              recipientName: 'Maria Santos',
              proofPhoto: photo)
          .then((_) {
        expect(c.errorMessage, isNotNull);
        return c.submit(
            orderId: orderId,
            recipientName: 'Maria Santos',
            proofPhoto: photo);
      }).then((_) {
        expect(writer.proofSaves.length, 1);
        expect(c.phase, ProofPhase.submitted);
      });
    });
  });

  group('partial failure', () {
    test('upload succeeds, save fails: the retry saves and does NOT re-upload',
        () async {
      // The orphan case. The object is already stored and cannot be deleted, so
      // a retry that uploaded again would leave a second undeletable copy.
      writer.failProofSaves = 1;
      final c = build();

      await c.submit(
          orderId: orderId, recipientName: 'Maria Santos', proofPhoto: photo);
      expect(uploader.proofUploads, 1);
      expect(writer.proofSaves, isEmpty);
      expect(c.errorMessage, isNotNull);
      expect(c.hasPendingUpload, isTrue,
          reason: 'the completed upload must survive the failed save');
      expect(c.phase, ProofPhase.idle);

      await c.submit(
          orderId: orderId, recipientName: 'Maria Santos', proofPhoto: photo);

      expect(uploader.proofUploads, 1, reason: 'no second object');
      expect(writer.proofSaves.length, 1);
      expect(writer.proofSaves.single.storagePath, proofObjectPath(orderId));
      expect(c.hasPendingUpload, isFalse);
    });

    test('the pending upload is cleared only once the save succeeds', () async {
      final c = build();
      await c.submit(
          orderId: orderId, recipientName: 'Maria Santos', proofPhoto: photo);
      expect(c.hasPendingUpload, isFalse);
      expect(writer.proofSaves.length, 1);
    });

    test('an invoice failure does not present the proof as unsaved', () async {
      // The proof is already recorded; reporting the whole submission as failed
      // would push the rider into retrying a write that already landed.
      writer.failInvoiceSaves = true;
      final c = build();

      await c.submit(
        orderId: orderId,
        recipientName: 'Maria Santos',
        proofPhoto: photo,
        invoicePhoto: File('invoice-source.jpg'),
      );

      expect(writer.proofSaves.length, 1);
      expect(c.phase, ProofPhase.submitted);
      expect(c.errorMessage, isNull);
      expect(c.noticeMessage, contains('invoice'));
    });

    test('retrying after an invoice failure retries ONLY the invoice', () async {
      // The proof write is one-shot: attempting it again would be refused by
      // the rules, and the rider has already supplied the photo and the name.
      // The retry must therefore skip the proof entirely and reuse the invoice
      // object that was already uploaded.
      writer.failInvoiceSaves = true;
      final c = build();
      await c.submit(
        orderId: orderId,
        recipientName: 'Maria Santos',
        proofPhoto: photo,
        invoicePhoto: File('invoice-source.jpg'),
      );
      expect(uploader.invoiceUploads, 1);
      expect(writer.proofSaves.length, 1);
      expect(c.hasOutstandingInvoice, isTrue);
      expect(c.isProofSaved, isTrue);

      writer.failInvoiceSaves = false;
      // No photo, no name — an invoice-only retry needs neither.
      await c.submit(orderId: orderId, recipientName: '');

      expect(uploader.proofUploads, 1, reason: 'proof not re-uploaded');
      expect(writer.proofSaves.length, 1, reason: 'proof not written twice');
      expect(uploader.invoiceUploads, 1, reason: 'no second invoice object');
      expect(writer.invoiceSaves.length, 1);
      expect(c.hasOutstandingInvoice, isFalse);
    });

    test('canSubmit offers the invoice retry once the proof is saved', () {
      writer.failInvoiceSaves = true;
      final c = build();
      return c
          .submit(
            orderId: orderId,
            recipientName: 'Maria Santos',
            proofPhoto: photo,
            invoicePhoto: File('invoice-source.jpg'),
          )
          .then((_) {
        // An empty name would normally block submission; with the proof
        // already recorded the only outstanding work is the invoice.
        expect(c.canSubmit(recipientName: '', hasPhoto: false), isTrue);
      });
    });
  });

  group('recovering an orphaned object', () {
    test('adopts the canonical object when the order has no proof yet',
        () async {
      // Reopening after a crash between upload and save: the object is at a
      // known path precisely because the name is deterministic.
      uploader.existingUrl = 'https://storage/$orderId/proof.jpg';
      final c = build();

      await c.recoverPendingUpload(orderId);
      expect(c.hasPendingUpload, isTrue);
      expect(c.errorMessage, isNull);

      await c.submit(orderId: orderId, recipientName: 'Maria Santos');

      expect(uploader.proofUploads, 0, reason: 'nothing re-uploaded');
      expect(writer.proofSaves.length, 1);
      expect(writer.proofSaves.single.storagePath, proofObjectPath(orderId));
      expect(writer.proofSaves.single.proofUrl,
          'https://storage/$orderId/proof.jpg');
    });

    test('a missing object is the ordinary new-upload case', () async {
      // ImageUploadService maps Storage `object-not-found` to null; nothing is
      // adopted and the screen asks for a photo as usual.
      uploader.existingUrl = null;
      final c = build();

      await c.recoverPendingUpload(orderId);

      expect(c.hasPendingUpload, isFalse);
      expect(c.errorMessage, isNull);
      expect(c.noticeMessage, isNull);

      await c.submit(
          orderId: orderId, recipientName: 'Maria Santos', proofPhoto: photo);
      expect(uploader.proofUploads, 1);
    });

    test('any OTHER storage error is surfaced, not swallowed', () async {
      // Treating a permission or network failure as "no object here" would
      // cause the duplicate this recovery exists to prevent.
      uploader.existingError =
          FirebaseException(plugin: 'firebase_storage', code: 'unauthorized');
      final c = build();

      await c.recoverPendingUpload(orderId);

      expect(c.hasPendingUpload, isFalse);
      expect(c.errorMessage, isNotNull);
    });

    test('choosing a new photo discards the recovered object', () async {
      uploader.existingUrl = 'https://storage/$orderId/proof.jpg';
      final c = build();
      await c.recoverPendingUpload(orderId);
      expect(c.hasPendingUpload, isTrue);

      c.clearPendingUpload();

      expect(c.hasPendingUpload, isFalse);
    });
  });

  group('validation before any network call', () {
    test('an invalid recipient name blocks the upload entirely', () async {
      final c = build();
      for (final name in ['', '   ', 'a' * 121]) {
        await c.submit(
            orderId: orderId, recipientName: name, proofPhoto: photo);
        expect(uploader.proofUploads, 0, reason: name);
        expect(writer.proofSaves, isEmpty, reason: name);
        expect(c.errorMessage, isNotNull, reason: name);
      }
    });

    test('a missing photo blocks the save', () async {
      final c = build();
      await c.submit(orderId: orderId, recipientName: 'Maria Santos');
      expect(writer.proofSaves, isEmpty);
      expect(c.errorMessage, isNotNull);
    });

    test('canSubmit requires both a valid name and an image', () {
      final c = build();
      expect(c.canSubmit(recipientName: '', hasPhoto: true), isFalse);
      expect(c.canSubmit(recipientName: 'Maria', hasPhoto: false), isFalse);
      expect(c.canSubmit(recipientName: 'Maria', hasPhoto: true), isTrue);
      expect(c.canSubmit(recipientName: 'a' * 121, hasPhoto: true), isFalse);
    });

    test('canSubmit accepts a recovered upload in place of a new photo',
        () async {
      uploader.existingUrl = 'https://storage/$orderId/proof.jpg';
      final c = build();
      await c.recoverPendingUpload(orderId);
      expect(c.canSubmit(recipientName: 'Maria Santos', hasPhoto: false),
          isTrue);
    });
  });

  group('manual-URL fallback', () {
    test('is refused in a build where it is not enabled', () async {
      // Release builds construct the controller with allowManualUrl: false, so
      // even a reachable code path cannot write a manual link.
      final c = build();
      await c.submit(
        orderId: orderId,
        recipientName: 'Maria Santos',
        manualUrl: 'https://example.com/proof.png',
      );
      expect(writer.proofSaves, isEmpty);
      expect(c.errorMessage, isNotNull);
    });

    test('is gated on debug builds only', () {
      expect(manualProofUrlEnabled(isDebugBuild: false), isFalse);
      expect(manualProofUrlEnabled(isDebugBuild: true), isTrue);
    });

    test('still enforces the recipient name when enabled', () async {
      final c = build(allowManualUrl: true);
      await c.submit(
        orderId: orderId,
        recipientName: '   ',
        manualUrl: 'https://example.com/proof.png',
      );
      expect(writer.proofSaves, isEmpty);
      expect(c.errorMessage, isNotNull);
    });

    test('requires https and records no storage path when enabled', () async {
      final c = build(allowManualUrl: true);
      await c.submit(
        orderId: orderId,
        recipientName: 'Maria Santos',
        manualUrl: 'http://example.com/proof.png',
      );
      expect(writer.proofSaves, isEmpty);

      await c.submit(
        orderId: orderId,
        recipientName: 'Maria Santos',
        manualUrl: 'https://example.com/proof.png',
      );
      expect(writer.proofSaves.length, 1);
      expect(uploader.proofUploads, 0);
      expect(writer.proofSaves.single.storagePath, isNull);
    });
  });

  group('progress and state', () {
    test('reports preparing, uploading and saving in order', () async {
      final c = build();
      final phases = <ProofPhase>[];
      c.addListener(() => phases.add(c.phase));

      await c.submit(
          orderId: orderId, recipientName: 'Maria Santos', proofPhoto: photo);

      expect(
        phases,
        containsAllInOrder([
          ProofPhase.preparing,
          ProofPhase.uploadingPhoto,
          ProofPhase.savingDetails,
          ProofPhase.submitted,
        ]),
      );
    });

    test('each phase shows its own distinct progress line', () async {
      // Read off a real submission rather than restating the mapping, so this
      // fails if two phases ever collapse to the same message.
      final c = build();
      final texts = <String>[];
      c.addListener(() {
        final t = c.progressText;
        if (t != null && (texts.isEmpty || texts.last != t)) texts.add(t);
      });

      await c.submit(
          orderId: orderId, recipientName: 'Maria Santos', proofPhoto: photo);

      expect(texts, [
        'Preparing proof…',
        'Uploading photo…',
        'Saving proof details…',
      ]);
      expect(texts.toSet().length, 3, reason: 'no two phases share a message');
      expect(c.progressText, isNull, reason: 'nothing in progress once done');
    });

    test('is not committing before or after a submission', () async {
      final c = build();
      expect(c.isCommitting, isFalse);
      await c.submit(
          orderId: orderId, recipientName: 'Maria Santos', proofPhoto: photo);
      expect(c.isCommitting, isFalse);
    });

    test('is committing while a write is in flight', () async {
      uploader.gate = Completer<EvidenceUpload>();
      final c = build();
      final pending = c.submit(
          orderId: orderId, recipientName: 'Maria Santos', proofPhoto: photo);
      await Future<void>.delayed(Duration.zero);

      expect(c.isCommitting, isTrue,
          reason: 'the screen refuses to pop during this window');

      uploader.gate!.complete(EvidenceUpload(
        downloadUrl: 'https://x/p.jpg',
        storagePath: proofObjectPath(orderId),
      ));
      await pending;
      expect(c.isCommitting, isFalse);
    });
  });

  test('the saved proof carries the trimmed name and canonical path', () async {
    final c = build();
    await c.submit(
        orderId: orderId,
        recipientName: '  Maria Santos  ',
        proofPhoto: photo);

    final saved = writer.proofSaves.single;
    expect(saved.orderId, orderId);
    expect(saved.recipientName, 'Maria Santos');
    expect(saved.storagePath, 'proof_of_delivery/$orderId/proof.jpg');
  });

  test('submission never changes the order status', () async {
    // The writer interface exposes proof and invoice metadata only — there is
    // no status operation for the controller to reach. Recorded as a test so
    // adding one has to be a deliberate act with this assertion in the way.
    final c = build();
    await c.submit(
      orderId: orderId,
      recipientName: 'Maria Santos',
      proofPhoto: photo,
      invoicePhoto: File('invoice-source.jpg'),
    );
    expect(writer.proofSaves.length, 1);
    expect(writer.invoiceSaves.length, 1);
    expect(c.phase, ProofPhase.submitted);
  });
}
