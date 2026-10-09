import 'dart:io';

import 'package:flutter/foundation.dart';

import '../models/delivery.dart';
import '../services/delivery_service.dart';
import '../services/image_upload_service.dart';
import '../services/proof_service.dart';
import '../utils/evidence_errors.dart';
import '../utils/order_workflow.dart';
import '../utils/proof_eligibility.dart';
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
  // "Submit Proof & Complete Delivery" (submitAndComplete):
  uploadingProof,
  uploadingInvoice,
  completing,
  completed,
}

/// Owns one proof submission: the duplicate guard, the phase the rider sees,
/// and the upload result that must survive a failed save.
class ProofSubmissionController extends ChangeNotifier {
  ProofSubmissionController({
    required ProofUploader uploader,
    required ProofMetadataWriter writer,
    DeliveryCompleter? completer,
    DeliveryLoader? loader,
  })  : _uploader = uploader,
        _writer = writer,
        _completer = completer,
        _loader = loader;

  final ProofUploader _uploader;
  final ProofMetadataWriter _writer;

  /// The trusted, server-side completion (markOrderDeliveredWithInventoryConsumption).
  /// Required by [submitAndComplete] only.
  final DeliveryCompleter? _completer;

  /// Shown when both photos are recorded but the completion call failed. The
  /// order is still NOT delivered; retrying runs only the completion.
  static const String completionPendingMessage =
      'Evidence uploaded, but delivery completion is still pending. Retry completion.';

  static const String completedMessage = 'Delivery completed.';

  /// Re-reads the order before anything uploads (see [submitAndComplete]).
  final DeliveryLoader? _loader;

  static const String alreadyCompletedMessage =
      'This delivery has already been completed.';

  static const String refreshFailedMessage =
      'Could not confirm the latest delivery details. Check your connection '
      'and try again — nothing was uploaded.';

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

  /// The invoice has been recorded during this session (submitAndComplete).
  bool _invoiceSaved = false;

  /// Both photos are recorded but the completion call has not succeeded.
  bool _completionPending = false;

  /// The fresh read found the order already delivered — by this rider on
  /// another device, or before a stale screen caught up. Nothing more to do.
  bool _alreadyCompleted = false;

  /// The server's (or the network's) reason the completion failed, shown
  /// under [completionPendingMessage]. Never raw error text.
  String? _completionFailureDetail;

  ProofPhase get phase => _phase;
  String? get errorMessage => _errorMessage;

  /// A non-fatal outcome worth telling the rider about — currently only an
  /// invoice photo that failed after the proof itself was safely recorded.
  String? get noticeMessage => _noticeMessage;

  /// True while a write is actually in progress. The screen refuses to pop
  /// during this window rather than abandoning a half-finished submission.
  bool get isCommitting =>
      _phase == ProofPhase.preparing ||
      _phase == ProofPhase.uploadingPhoto ||
      _phase == ProofPhase.uploadingProof ||
      _phase == ProofPhase.uploadingInvoice ||
      _phase == ProofPhase.savingDetails ||
      _phase == ProofPhase.completing;

  /// Both photos are recorded but completion failed — retry runs completion only.
  bool get isCompletionPending => _completionPending;

  /// Why the last completion attempt failed, for display under the pending
  /// message. Null when there is nothing specific to add.
  String? get completionFailureDetail => _completionFailureDetail;

  /// The delivery has been completed by the server in this session.
  bool get isCompleted => _phase == ProofPhase.completed;

  /// The order turned out to be delivered already; submission is locked.
  bool get isAlreadyCompleted => _alreadyCompleted;

  /// An invoice photo uploaded in an earlier attempt is waiting to be recorded.
  bool get hasPendingInvoiceUpload => _pendingInvoice != null;

  /// The recovered/uploaded objects' URLs, for the confirmation previews.
  String? get pendingProofUrl => _pendingProof?.downloadUrl;
  String? get pendingInvoiceUrl => _pendingInvoice?.downloadUrl;

  /// True when a photo is already uploaded and only the save remains, so the
  /// screen can offer "Retry saving" instead of asking for another photo.
  bool get hasPendingUpload => _pendingProof != null;

  /// The proof landed but its optional invoice photo did not. The screen keeps
  /// a retry available for just that, so the notice it shows is actionable.
  bool get hasOutstandingInvoice => _pendingInvoice != null;

  /// The proof write for this session has succeeded.
  bool get isProofSaved => _proofSaved;

  /// The invoice write for this session has succeeded (submitAndComplete).
  bool get isInvoiceSaved => _invoiceSaved;

  /// Human-readable progress for the current phase.
  String? get progressText {
    switch (_phase) {
      case ProofPhase.preparing:
        return 'Preparing proof…';
      case ProofPhase.uploadingPhoto:
        return 'Uploading photo…';
      case ProofPhase.savingDetails:
        return 'Saving proof details…';
      case ProofPhase.uploadingProof:
        return 'Uploading proof photo (1 of 2)…';
      case ProofPhase.uploadingInvoice:
        return 'Uploading invoice photo (2 of 2)…';
      case ProofPhase.completing:
        return 'Completing delivery…';
      case ProofPhase.idle:
      case ProofPhase.submitted:
      case ProofPhase.completed:
        return null;
    }
  }

  /// Whether [submit] currently has everything it needs. The screen disables the
  /// button on this, so it can never be pressed into a validation failure.
  bool canSubmit({
    required String recipientName,
    required bool hasPhoto,
  }) {
    if (isCommitting) return false;
    // Proof already recorded: the only thing left to submit is the invoice
    // that failed to attach. No name, no photo.
    if (_proofSaved) return hasOutstandingInvoice;
    if (!validateRecipientName(recipientName).valid) return false;
    return hasPhoto || hasPendingUpload;
  }

  /// Discard a chosen photo and the upload recovered for it, so "Retake" really
  /// does start over rather than silently re-saving the previous object.
  void clearPendingUpload() {
    _pendingProof = null;
    notifyListeners();
  }

  /// The same for the invoice photo.
  void clearPendingInvoiceUpload() {
    _pendingInvoice = null;
    notifyListeners();
  }

  /// Forget everything about the previous order when the rider picks another.
  void resetForNewOrder() {
    _pendingProof = null;
    _pendingInvoice = null;
    _proofSaved = false;
    _invoiceSaved = false;
    _completionPending = false;
    _alreadyCompleted = false;
    _completionFailureDetail = null;
    _errorMessage = null;
    _noticeMessage = null;
    _phase = ProofPhase.idle;
    notifyListeners();
  }

  /// Whether "Submit Proof & Complete Delivery" has everything it needs.
  ///
  /// [proofRecorded] / [invoiceRecorded] say what the order already carries
  /// (Delivery.hasRecordedProof / hasRecordedInvoice). Each missing piece must
  /// be available as a chosen photo or an earlier upload, and a proof still to
  /// be recorded needs a valid recipient name. Both photos are required: the
  /// server refuses completion without them.
  bool canSubmitAndComplete({
    required String recipientName,
    required bool hasProofPhoto,
    required bool hasInvoicePhoto,
    required bool proofRecorded,
    required bool invoiceRecorded,
  }) {
    if (isCommitting || isCompleted || _alreadyCompleted) return false;
    final proofDone = proofRecorded || _proofSaved;
    final invoiceDone = invoiceRecorded || _invoiceSaved;
    if (!proofDone) {
      if (!validateRecipientName(recipientName).valid) return false;
      if (!hasProofPhoto && _pendingProof == null) return false;
    }
    if (!invoiceDone && !hasInvoicePhoto && _pendingInvoice == null) return false;
    return true;
  }

  /// Submit Proof & Complete Delivery for [orderId], after the rider confirmed.
  ///
  /// In order, each step only if still needed, so a retry resumes where the
  /// last attempt stopped and reuses every upload it already made:
  ///   1. check both photos are available (nothing uploads otherwise);
  ///   2. upload the proof photo, then the invoice photo;
  ///   3. record the proof, then the invoice (the rules' one-shot submissions);
  ///   4. call the trusted completion callable.
  ///
  /// Nothing here ever writes a status. The order becomes delivered only when
  /// the server's callable succeeds — and the server re-checks the assignment
  /// and that both photos are recorded. Resolves true only on that success.
  ///
  /// Re-entrant calls return false immediately (the duplicate guard is set
  /// before the first await). A server-side replay of an already-completed
  /// order is reported as success without consuming anything twice.
  Future<bool> submitAndComplete({
    required String orderId,
    required String currentStatus,
    required bool proofRecorded,
    required bool invoiceRecorded,
    String recipientName = '',
    File? proofPhoto,
    File? invoicePhoto,
    String? riderUid,
  }) async {
    if (_inFlight) return false;
    if (_alreadyCompleted) return false;
    // Completed in this session: nothing left to do. Report the success again
    // without fetching, uploading or calling the server a second time.
    if (isCompleted) return true;
    _inFlight = true;
    try {
      final completer = _completer;
      if (completer == null) {
        throw StateError('submitAndComplete needs a DeliveryCompleter');
      }
      _errorMessage = null;
      _noticeMessage = null;
      _completionFailureDetail = null;
      _setPhase(ProofPhase.preparing);

      // Stale-attempt guard. The screen's copy of the order can be out of date
      // (opened from an old list, completed on another device, cancelled or
      // reassigned by the dispatcher). Before ANY upload, read the order fresh
      // and stop unless it can still take proof and be completed by this
      // rider. The rules and the callable refuse a stale attempt anyway; this
      // stops it before a single byte is uploaded.
      final loader = _loader;
      if (loader != null) {
        final Delivery fresh;
        try {
          fresh = await loader.fetchDelivery(orderId);
        } catch (_) {
          _fail(refreshFailedMessage);
          return false;
        }
        final reason = proofIneligibility(fresh, riderUid: riderUid);
        if (reason == ProofIneligibility.completed) {
          _alreadyCompleted = true;
          _pendingProof = null;
          _pendingInvoice = null;
          _completionPending = false;
          _fail(alreadyCompletedMessage);
          return false;
        }
        if (reason != null) {
          _fail(proofIneligibilityMessage(reason));
          return false;
        }
        // What the server already holds beats what the screen last saw.
        proofRecorded = proofRecorded || fresh.hasRecordedProof;
        invoiceRecorded = invoiceRecorded || fresh.hasRecordedInvoice;
        currentStatus = fresh.status;
      }

      if (!_completionPending) {
        final recorded = await _recordEvidence(
          orderId: orderId,
          proofRecorded: proofRecorded,
          invoiceRecorded: invoiceRecorded,
          recipientName: recipientName,
          proofPhoto: proofPhoto,
          invoicePhoto: invoicePhoto,
        );
        if (!recorded) return false;
      }

      _setPhase(ProofPhase.completing);
      try {
        await completer.markDelivered(orderId, currentStatus);
      } catch (e) {
        // Both photos are recorded; only the completion is outstanding. The
        // order is NOT delivered — say exactly that, and keep the retry to the
        // completion alone.
        _completionPending = true;
        _completionFailureDetail = _completionFailureReason(e);
        _fail(completionPendingMessage);
        return false;
      }
      _completionPending = false;
      _noticeMessage = completedMessage;
      _setPhase(ProofPhase.completed);
      return true;
    } finally {
      _inFlight = false;
    }
  }

  /// Steps 1–3. Returns false (with the message set) on any failure; every
  /// upload and record already made is kept for the retry.
  Future<bool> _recordEvidence({
    required String orderId,
    required bool proofRecorded,
    required bool invoiceRecorded,
    required String recipientName,
    File? proofPhoto,
    File? invoicePhoto,
  }) async {
    try {
      var proofDone = proofRecorded || _proofSaved;
      var invoiceDone = invoiceRecorded || _invoiceSaved;

      // 1. Everything required is present BEFORE anything uploads, so a
      //    missing invoice can never leave a lone proof photo recorded.
      String? name;
      if (!proofDone) {
        final check = validateRecipientName(recipientName);
        if (!check.valid) throw ProofException(check.code!, check.message!);
        name = check.value;
        if (_pendingProof == null && proofPhoto == null) {
          throw const ProofException(
            'photo-required',
            'Take a proof photo before submitting.',
          );
        }
      }
      if (!invoiceDone && _pendingInvoice == null && invoicePhoto == null) {
        throw const ProofException(
          'invoice-required',
          'Add the invoice photo before submitting.',
        );
      }

      // 2. Upload both — each reused if an earlier attempt already uploaded it.
      if (!proofDone && _pendingProof == null) {
        _setPhase(ProofPhase.uploadingProof);
        _pendingProof = await _uploader.uploadProof(orderId, proofPhoto!);
      }
      if (!invoiceDone && _pendingInvoice == null) {
        _setPhase(ProofPhase.uploadingInvoice);
        _pendingInvoice = await _uploader.uploadInvoice(orderId, invoicePhoto!);
      }

      // 3. Record both. Only after BOTH uploads succeeded.
      _setPhase(ProofPhase.savingDetails);
      if (!proofDone) {
        try {
          await _writer.saveProofOfDelivery(
            orderId: orderId,
            recipientName: name!,
            proofUrl: _pendingProof!.downloadUrl,
            storagePath: _pendingProof!.storagePath,
          );
        } on ProofException catch (e) {
          // Already recorded (a previous attempt's save landed but its reply
          // was lost). The server re-checks who recorded it at completion.
          if (e.code != 'proof-already-finalized') rethrow;
        }
        _pendingProof = null;
        _proofSaved = true;
        proofDone = true;
      }
      if (!invoiceDone) {
        try {
          await _writer.saveInvoicePhoto(
            orderId: orderId,
            invoiceUrl: _pendingInvoice!.downloadUrl,
            storagePath: _pendingInvoice!.storagePath,
          );
        } on ProofException catch (e) {
          if (e.code != 'invoice-already-finalized') rethrow;
        }
        _pendingInvoice = null;
        _invoiceSaved = true;
        invoiceDone = true;
      }
      return proofDone && invoiceDone;
    } on ProofException catch (e) {
      _fail(e.message);
      return false;
    } catch (e) {
      _fail(_friendlyFailure(e));
      return false;
    }
  }

  /// A rider-facing reason for a failed completion call.
  String? _completionFailureReason(Object error) {
    if (classifyEvidenceError(error) == EvidenceErrorKind.network) {
      return 'No connection. Retry once you are back online.';
    }
    // The callable's domain refusals carry a sentence written for the rider
    // (e.g. "This delivery is not assigned to you."); a generic server or
    // transport failure adds nothing to the pending message.
    if (error is WorkflowException &&
        !['internal', 'unknown', 'delivery-failed'].contains(error.code)) {
      return error.message;
    }
    return null;
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
  Future<void> recoverPendingUpload(
    String orderId, {
    bool includeInvoice = false,
  }) async {
    try {
      final url = await _uploader.existingProofUrl(orderId);
      if (url != null) {
        _pendingProof = EvidenceUpload(
          downloadUrl: url,
          storagePath: proofObjectPath(orderId),
        );
      }
      if (includeInvoice) {
        final invoiceUrl = await _uploader.existingInvoiceUrl(orderId);
        if (invoiceUrl != null) {
          _pendingInvoice = EvidenceUpload(
            downloadUrl: invoiceUrl,
            storagePath: invoiceObjectPath(orderId),
          );
        }
      }
      if (_pendingProof == null && _pendingInvoice == null) return;
      // Recovered objects are only reused — never recorded or completed
      // without the rider confirming. A file in Storage is not evidence.
      _noticeMessage = includeInvoice
          ? 'Photos from an earlier attempt were found and will be reused. '
              'Check them, add the recipient name and submit to finish.'
          : 'A photo from an earlier attempt was found. Add the recipient name '
              'and submit to finish saving it.';
      notifyListeners();
    } on ProofException catch (e) {
      _errorMessage = e.message;
      notifyListeners();
    } catch (e) {
      // A Storage 403 is a refusal by the rules, not a connection fault —
      // say which, so the rider is not sent chasing signal.
      _errorMessage = recoveryCheckMessage(e);
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
  }) async {
    if (_inFlight) return;
    _inFlight = true;
    try {
      await _run(
        orderId: orderId,
        recipientName: recipientName,
        proofPhoto: proofPhoto,
        invoicePhoto: invoicePhoto,
      );
    } finally {
      _inFlight = false;
    }
  }

  /// Whether an invoice-only submission may run right now.
  ///
  /// Used for an active delivery whose proof is already recorded but whose
  /// invoice was never attached — the invoice is required before completion, so
  /// the screen must be able to add just it. True when a new invoice photo is
  /// chosen, or an earlier invoice upload is waiting to be saved.
  bool canSubmitInvoiceOnly({required bool hasInvoicePhoto}) {
    if (isCommitting) return false;
    return hasInvoicePhoto || hasOutstandingInvoice;
  }

  /// Attach (or retry) ONLY the invoice photo for [orderId], for a delivery
  /// whose proof is already recorded.
  ///
  /// Unlike the best-effort invoice step inside a full submission, this SURFACES
  /// failures (the invoice is required to complete, not an optional extra) and
  /// reuses an already-uploaded object on retry rather than creating a duplicate.
  /// The duplicate guard makes repeated taps a single upload and save.
  Future<void> submitInvoiceOnly({
    required String orderId,
    File? invoicePhoto,
  }) async {
    if (_inFlight) return;
    _inFlight = true;
    try {
      _errorMessage = null;
      _noticeMessage = null;
      _setPhase(ProofPhase.preparing);

      if (_pendingInvoice == null) {
        if (invoicePhoto == null) {
          throw const ProofException(
            'invoice-required',
            'Choose an invoice photo before submitting.',
          );
        }
        _setPhase(ProofPhase.uploadingPhoto);
        _pendingInvoice = await _uploader.uploadInvoice(orderId, invoicePhoto);
      }

      _setPhase(ProofPhase.savingDetails);
      await _writer.saveInvoicePhoto(
        orderId: orderId,
        invoiceUrl: _pendingInvoice!.downloadUrl,
        storagePath: _pendingInvoice!.storagePath,
      );
      _pendingInvoice = null;
      _setPhase(ProofPhase.submitted);
    } on ProofException catch (e) {
      _fail(e.message);
    } catch (e) {
      _fail(_friendlyInvoiceFailure(e));
    } finally {
      _inFlight = false;
    }
  }

  /// The invoice-only path's own wording, so an invoice failure is never
  /// reported as a proof failure. Raw error text (paths, Firebase internals) is
  /// only inspected for its category, never shown.
  String _friendlyInvoiceFailure(Object error) {
    switch (classifyEvidenceError(error)) {
      case EvidenceErrorKind.permissionDenied:
        return 'You are not allowed to add an invoice photo to this delivery '
            '(permission denied — not a connection problem). It may have been '
            'reassigned — pull to refresh and check.';
      case EvidenceErrorKind.notSignedIn:
        return 'Your sign-in could not be verified. Sign out and sign in '
            'again, then retry — your invoice photo is kept.';
      case EvidenceErrorKind.network:
        return 'No connection. Your invoice photo is kept — try again once you '
            'are back online.';
      case EvidenceErrorKind.other:
        return 'Could not save the invoice photo. Please try again.';
    }
  }

  Future<void> _run({
    required String orderId,
    required String recipientName,
    File? proofPhoto,
    File? invoicePhoto,
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
  }) async {
    final name = validateRecipientName(recipientName);
    if (!name.valid) {
      throw ProofException(name.code!, name.message!);
    }

    // Proof is a camera photo uploaded to Storage — the only path. A completed
    // upload recovered from an earlier attempt is reused rather than re-uploaded.
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
    final proofUrl = _pendingProof!.downloadUrl;
    final storagePath = _pendingProof!.storagePath;

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
    // Storage reports a rules refusal as `unauthorized` and Firestore as
    // `permission-denied`; the classifier treats both as the same thing.
    switch (classifyEvidenceError(error)) {
      case EvidenceErrorKind.permissionDenied:
        return 'You are not allowed to submit proof for this delivery '
            '(permission denied — not a connection problem). It may have been '
            'reassigned — pull to refresh and check.';
      case EvidenceErrorKind.notSignedIn:
        return 'Your sign-in could not be verified. Sign out and sign in '
            'again, then retry — your photo and details are kept.';
      case EvidenceErrorKind.network:
        return 'No connection. Your photo is kept — try again once you are '
            'back online.';
      case EvidenceErrorKind.other:
        return 'Could not save the proof. Your photo and details are kept — '
            'please try again.';
    }
  }

  void _setPhase(ProofPhase phase) {
    _phase = phase;
    notifyListeners();
  }
}
