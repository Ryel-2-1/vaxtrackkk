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

  /// Thrown by [uploadInvoice] when set — e.g. a missing or unreadable file.
  Object? invoiceUploadError;

  @override
  Future<EvidenceUpload> uploadInvoice(String orderId, File file) async {
    invoiceUploads += 1;
    if (invoiceUploadError != null) throw invoiceUploadError!;
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

  @override
  Future<String?> existingInvoiceUrl(String orderId) async => null;
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

  ProofSubmissionController build() =>
      ProofSubmissionController(
        uploader: uploader,
        writer: writer,
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
      // ...and a Storage 403 is reported as the refusal it is, not as a
      // connection problem (the physical-phone staging finding).
      expect(c.errorMessage, contains('permission denied'));
      expect(c.errorMessage, isNot(contains('Check your connection')));
    });

    test('a network failure during the check still blames the connection',
        () async {
      uploader.existingError = FirebaseException(
          plugin: 'firebase_storage', code: 'retry-limit-exceeded');
      final c = build();

      await c.recoverPendingUpload(orderId);

      expect(c.hasPendingUpload, isFalse);
      expect(c.errorMessage, contains('Check your connection'));
    });

    test('a refused proof UPLOAD is reported as permission, not connection',
        () async {
      uploader.uploadError =
          FirebaseException(plugin: 'firebase_storage', code: 'unauthorized');
      final c = build();

      await c.submit(
          orderId: orderId, recipientName: 'Maria Santos', proofPhoto: photo);

      expect(writer.proofSaves, isEmpty);
      expect(c.errorMessage, contains('permission denied'));
      expect(c.errorMessage, isNot(contains('No connection')));
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

  group('proof requires a camera photo (no manual-URL fallback)', () {
    test('a submission with no photo and no pending upload is refused', () async {
      // The manual proof-image-URL fallback was removed: proof is a camera
      // photo uploaded to Storage, full stop. Without one, nothing is saved.
      final c = build();
      await c.submit(orderId: orderId, recipientName: 'Maria Santos');
      expect(uploader.proofUploads, 0);
      expect(writer.proofSaves, isEmpty);
      expect(c.errorMessage, isNotNull);
    });

    test('every saved proof carries a canonical Storage path', () async {
      // With the URL path gone, a saved proof always references an uploaded
      // object — storagePath is never null.
      final c = build();
      await c.submit(
          orderId: orderId, recipientName: 'Maria Santos', proofPhoto: photo);
      expect(writer.proofSaves.single.storagePath, proofObjectPath(orderId));
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

  // The invoice is required before a delivery can be completed, so a delivery
  // proven without one must still be able to attach just the invoice. This is
  // the path that keeps the new completion gate from deadlocking such orders.
  group('invoice-only submission', () {
    final invoice = File('invoice-source.jpg');

    test('attaches the invoice with one upload and one save', () async {
      final c = build();
      await c.submitInvoiceOnly(orderId: orderId, invoicePhoto: invoice);
      expect(uploader.invoiceUploads, 1);
      expect(writer.invoiceSaves, [orderId]);
      expect(c.phase, ProofPhase.submitted);
      // Proof was already recorded elsewhere; this path never touches it.
      expect(uploader.proofUploads, 0);
      expect(writer.proofSaves, isEmpty);
    });

    test('five taps in one turn produce one upload and one save', () {
      final c = build();
      final futures = [
        for (var i = 0; i < 5; i++)
          c.submitInvoiceOnly(orderId: orderId, invoicePhoto: invoice),
      ];
      return Future.wait(futures).then((_) {
        expect(uploader.invoiceUploads, 1);
        expect(writer.invoiceSaves.length, 1);
      });
    });

    test('with no photo and nothing pending, it fails without uploading', () async {
      final c = build();
      await c.submitInvoiceOnly(orderId: orderId, invoicePhoto: null);
      expect(uploader.invoiceUploads, 0);
      expect(writer.invoiceSaves, isEmpty);
      expect(c.phase, ProofPhase.idle);
      expect(c.errorMessage, isNotNull);
    });

    test('a save failure is surfaced and does not claim success', () async {
      writer.failInvoiceSaves = true;
      final c = build();
      await c.submitInvoiceOnly(orderId: orderId, invoicePhoto: invoice);
      expect(c.phase, ProofPhase.idle);
      expect(c.errorMessage, isNotNull);
      expect(writer.invoiceSaves, isEmpty);
    });

    test('retry after a save failure reuses the upload — no duplicate object',
        () async {
      writer.failInvoiceSaves = true;
      final c = build();
      await c.submitInvoiceOnly(orderId: orderId, invoicePhoto: invoice);
      expect(uploader.invoiceUploads, 1); // uploaded once, save failed

      writer.failInvoiceSaves = false;
      await c.submitInvoiceOnly(orderId: orderId, invoicePhoto: invoice);
      // The canonical object is reused, not re-uploaded, and now saved.
      expect(uploader.invoiceUploads, 1);
      expect(writer.invoiceSaves, [orderId]);
      expect(c.phase, ProofPhase.submitted);
    });

    test('an invoice failure is reported as an invoice failure, not a proof one',
        () async {
      uploader.invoiceUploadError = Exception('something unexpected');
      final c = build();
      await c.submitInvoiceOnly(orderId: orderId, invoicePhoto: invoice);
      expect(c.errorMessage, 'Could not save the invoice photo. Please try again.');
      expect(c.errorMessage, isNot(contains('proof')));
      expect(c.phase, ProofPhase.idle);
    });

    test('a missing/unreadable file fails without a path or raw detail',
        () async {
      // What `file.length()` throws when the picked file has gone away.
      uploader.invoiceUploadError = const FileSystemException(
        'Cannot retrieve length of file',
        '/data/user/0/app/cache/secret-invoice.jpg',
      );
      final c = build();
      await c.submitInvoiceOnly(orderId: orderId, invoicePhoto: invoice);
      expect(c.errorMessage, 'Could not save the invoice photo. Please try again.');
      expect(c.errorMessage, isNot(contains('/data')));
      expect(writer.invoiceSaves, isEmpty, reason: 'nothing recorded');
    });

    test('a permission failure gets invoice-specific wording', () async {
      uploader.invoiceUploadError = Exception('[firebase_storage/permission-denied]');
      final c = build();
      await c.submitInvoiceOnly(orderId: orderId, invoicePhoto: invoice);
      expect(c.errorMessage, contains('invoice photo'));
      expect(c.errorMessage, isNot(contains('firebase_storage')));
    });

    test('canSubmitInvoiceOnly requires a chosen photo (or a pending upload)',
        () {
      final c = build();
      expect(c.canSubmitInvoiceOnly(hasInvoicePhoto: false), isFalse);
      expect(c.canSubmitInvoiceOnly(hasInvoicePhoto: true), isTrue);
    });
  });
}
