import 'dart:io';

import 'package:flutter/foundation.dart';

import '../services/image_upload_service.dart';
import '../services/proof_service.dart';
import '../utils/proof_validation.dart';

/// Where a submission has got to. The screen renders one line of text per
/// phase, so a rider on a slow connection can tell an upload that is still
/// running from a save that is about to finish.
enum ProofPhase {
  idle,
  preparing,
  uploadingPhoto,
  savingDetails,
  submitted,
}

/// Whether the temporary manual-URL fallback may be offered.
///
/// Debug builds only. It writes a link with no Storage object behind it, which
/// is why the canonical-path checks in the service and the rules have to treat
/// the path as optional; letting it reach a release build would make that
/// weakening permanent and shippable. Pure so it can be asserted directly.
bool manualProofUrlEnabled({required bool isDebugBuild}) => isDebugBuild;

/// Owns one proof submission: the duplicate guard, the phase the rider sees,
/// and the upload result that must survive a failed save.
class ProofSubmissionController extends ChangeNotifier {
  ProofSubmissionController({
    required ProofUploader uploader,
    required ProofMetadataWriter writer,
    bool allowManualUrl = false,
  })  : _uploader = uploader,
        _writer = writer,
        _allowManualUrl = allowManualUrl;

  final ProofUploader _uploader;
  final ProofMetadataWriter _writer;
  final bool _allowManualUrl;

  /// The duplicate guard.
  ///
  /// A disabled button is feedback, not concurrency control: `onPressed: null`
  /// only takes effect after the widget rebuilds, so several taps delivered in
  /// the same event turn all reach the handler before any rebuild happens. This
  /// flag is set synchronously at the very top of [submit], before validation,
  /// before any notify, and before the first `await` — which is what makes five
  /// calls in one turn produce exactly one upload and one save.
  bool _inFlight = false;

  ProofPhase _phase = ProofPhase.idle;
  String? _errorMessage;
  String? _noticeMessage;

  /// A completed upload whose Firestore write has not succeeded yet.
  ///
  /// Kept across failures on purpose: retrying must save the metadata for THIS
  /// object, not upload a second copy. Cleared only once the save succeeds.
  EvidenceUpload? _pendingProof;
  EvidenceUpload? _pendingInvoice;

  /// The proof itself has been recorded during this session.
  ///
  /// Once it has, a further submit is an invoice-only retry: it must not ask
  /// for another photo or another recipient name, and it must not attempt the
  /// proof write again — that write is one-shot and would now be refused.
  bool _proofSaved = false;

  ProofPhase get phase => _phase;
  String? get errorMessage => _errorMessage;

  /// A non-fatal outcome worth telling the rider about — currently only an
  /// invoice photo that failed after the proof itself was safely recorded.
  String? get noticeMessage => _noticeMessage;

  /// True while a write is actually in progress. The screen refuses to pop
  /// during this window rather than abandoning a half-finished submission.
  bool get isCommitting =>
      _phase == ProofPhase.uploadingPhoto || _phase == ProofPhase.savingDetails;

  /// True when a photo is already uploaded and only the save remains, so the
  /// screen can offer "Retry saving" instead of asking for another photo.
  bool get hasPendingUpload => _pendingProof != null;

  /// The proof landed but its optional invoice photo did not. The screen keeps
  /// a retry available for just that, so the notice it shows is actionable.
  bool get hasOutstandingInvoice => _pendingInvoice != null;

  /// The proof write for this session has succeeded.
  bool get isProofSaved => _proofSaved;

  /// Human-readable progress for the current phase.
  String? get progressText {
    switch (_phase) {
      case ProofPhase.preparing:
        return 'Preparing proof…';
      case ProofPhase.uploadingPhoto:
        return 'Uploading photo…';
      case ProofPhase.savingDetails:
        return 'Saving proof details…';
      case ProofPhase.idle:
      case ProofPhase.submitted:
        return null;
    }
  }

  /// Whether [submit] currently has everything it needs. The screen disables the
  /// button on this, so it can never be pressed into a validation failure.
  bool canSubmit({
    required String recipientName,
    required bool hasPhoto,
    String? manualUrl,
  }) {
    if (isCommitting) return false;
    // Proof already recorded: the only thing left to submit is the invoice
    // that failed to attach. No name, no photo.
    if (_proofSaved) return hasOutstandingInvoice;
    if (!validateRecipientName(recipientName).valid) return false;
    if (manualUrl != null) return manualUrl.trim().isNotEmpty;
    return hasPhoto || hasPendingUpload;
  }

  /// Discard a chosen photo and the upload recovered for it, so "Retake" really
  /// does start over rather than silently re-saving the previous object.
  void clearPendingUpload() {
    _pendingProof = null;
    notifyListeners();
  }

  /// Adopt an already-stored canonical object as this order's pending upload.
  ///
  /// Called when the screen opens on an order that has no proof metadata but
  /// does have an object at the canonical path — the signature of a submission
  /// that uploaded and then failed to save. Recovering it is what stops the
  /// next attempt creating a second object.
  ///
  /// A missing object is the ordinary case and leaves the screen alone. Any
  /// other Storage error is surfaced: treating it as "nothing there" would hide
  /// a real fault and cause the duplicate this exists to prevent.
  Future<void> recoverPendingUpload(String orderId) async {
    try {
      final url = await _uploader.existingProofUrl(orderId);
      if (url == null) return;
      _pendingProof = EvidenceUpload(
        downloadUrl: url,
        storagePath: proofObjectPath(orderId),
      );
      _noticeMessage =
          'A photo from an earlier attempt was found. Add the recipient name '
          'and submit to finish saving it.';
      notifyListeners();
    } on ProofException catch (e) {
      _errorMessage = e.message;
      notifyListeners();
    } catch (_) {
      _errorMessage =
          'Could not check for an earlier upload. Check your connection and '
          'try again.';
      notifyListeners();
    }
  }

  /// Submit proof for [orderId].
  ///
  /// Re-entrant calls return immediately. On failure the chosen photo, the
  /// recipient name and any completed upload are all left in place, so the
  /// rider retries rather than starting from nothing.
  Future<void> submit({
    required String orderId,
    required String recipientName,
    File? proofPhoto,
    File? invoicePhoto,
    String? manualUrl,
  }) async {
    if (_inFlight) return;
    _inFlight = true;
    try {
      await _run(
        orderId: orderId,
        recipientName: recipientName,
        proofPhoto: proofPhoto,
        invoicePhoto: invoicePhoto,
        manualUrl: manualUrl,
      );
    } finally {
      _inFlight = false;
    }
  }

  Future<void> _run({
    required String orderId,
    required String recipientName,
    File? proofPhoto,
    File? invoicePhoto,
    String? manualUrl,
  }) async {
    _errorMessage = null;
    _noticeMessage = null;
    _setPhase(ProofPhase.preparing);

    try {
      // An invoice-only retry skips the proof entirely: it is already recorded,
      // the write is one-shot, and asking again for a photo and a name the
      // rider has already given would be nonsense.
      if (!_proofSaved) {
        await _runProof(
          orderId: orderId,
          recipientName: recipientName,
          proofPhoto: proofPhoto,
          manualUrl: manualUrl,
        );
      }

      if (invoicePhoto != null || _pendingInvoice != null) {
        await _submitInvoice(orderId, invoicePhoto);
      }

      _setPhase(ProofPhase.submitted);
    } on ProofException catch (e) {
      _fail(e.message);
    } catch (e) {
      _fail(_friendlyFailure(e));
    }
  }

  Future<void> _runProof({
    required String orderId,
    required String recipientName,
    File? proofPhoto,
    String? manualUrl,
  }) async {
    final name = validateRecipientName(recipientName);
    if (!name.valid) {
      throw ProofException(name.code!, name.message!);
    }

    String proofUrl;
    String? storagePath;

    if (manualUrl != null) {
      // The temporary fallback still goes through the same authorization and
      // the same recipient validation; only the Storage object is absent.
      if (!_allowManualUrl) {
        throw const ProofException(
          'manual-url-disabled',
          'Manual proof links are not available in this build.',
        );
      }
      final trimmed = manualUrl.trim();
      if (!trimmed.startsWith('https://')) {
        throw const ProofException(
          'manual-url-invalid',
          'The proof image link must start with https://',
        );
      }
      proofUrl = trimmed;
      storagePath = null;
    } else {
      if (_pendingProof == null) {
        if (proofPhoto == null) {
          throw const ProofException(
            'photo-required',
            'Take a proof photo before submitting.',
          );
        }
        _setPhase(ProofPhase.uploadingPhoto);
        _pendingProof = await _uploader.uploadProof(orderId, proofPhoto);
      }
      proofUrl = _pendingProof!.downloadUrl;
      storagePath = _pendingProof!.storagePath;
    }

    _setPhase(ProofPhase.savingDetails);
    await _writer.saveProofOfDelivery(
      orderId: orderId,
      recipientName: name.value,
      proofUrl: proofUrl,
      storagePath: storagePath,
    );
    // Only now is the object referenced by the order; nothing is orphaned.
    _pendingProof = null;
    _proofSaved = true;
  }

  /// The invoice photo is optional and secondary: once the proof itself is
  /// recorded, a failure here must not present the delivery as unproven. It is
  /// reported as a notice and retried on the next submit, which reuses the
  /// already-uploaded object exactly as the proof path does.
  Future<void> _submitInvoice(String orderId, File? invoicePhoto) async {
    try {
      if (_pendingInvoice == null && invoicePhoto != null) {
        _setPhase(ProofPhase.uploadingPhoto);
        _pendingInvoice = await _uploader.uploadInvoice(orderId, invoicePhoto);
      }
      if (_pendingInvoice == null) return;
      _setPhase(ProofPhase.savingDetails);
      await _writer.saveInvoicePhoto(
        orderId: orderId,
        invoiceUrl: _pendingInvoice!.downloadUrl,
        storagePath: _pendingInvoice!.storagePath,
      );
      _pendingInvoice = null;
    } catch (_) {
      _noticeMessage =
          'Proof was saved. The invoice photo could not be attached — submit '
          'again to retry just the invoice.';
    }
  }

  void _fail(String message) {
    _errorMessage = message;
    _setPhase(ProofPhase.idle);
  }

  String _friendlyFailure(Object error) {
    final text = error.toString();
    if (text.contains('permission-denied')) {
      return 'You are not allowed to submit proof for this delivery. '
          'It may have been reassigned — pull to refresh and check.';
    }
    if (text.contains('unavailable') || text.contains('network')) {
      return 'No connection. Your photo is kept — try again once you are back '
          'online.';
    }
    return 'Could not save the proof. Your photo and details are kept — please '
        'try again.';
  }

  void _setPhase(ProofPhase phase) {
    _phase = phase;
    notifyListeners();
  }
}
