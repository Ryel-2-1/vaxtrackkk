import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';

import '../models/delivery.dart';
import '../services/delivery_service.dart';
import '../services/image_upload_service.dart';
import '../services/proof_service.dart';
import '../utils/evidence_errors.dart';
import '../utils/order_workflow.dart';
import '../utils/proof_validation.dart';
import 'offline_delivery_record.dart';

/// Where offline records and their photos live on the phone.
abstract class OfflineRecordStore {
  Future<List<OfflineDeliveryRecord>> load();
  Future<void> save(List<OfflineDeliveryRecord> records);

  /// Copy [photo] into the app's own storage (the camera's file is in a
  /// cache the system may clear) and return the kept path.
  Future<String> keepPhoto(String orderId, String name, File photo);

  /// Remove a record's kept photos once they are no longer needed.
  Future<void> deletePhotos(String orderId);
}

/// The server's answer to an offline completion record.
class OfflineSubmitResult {
  final bool delivered;
  final String? reviewReason;
  const OfflineSubmitResult({required this.delivered, this.reviewReason});
}

/// The server calls the queue needs (DeliveryService in the app; fakes in tests).
abstract class OfflineDeliverySender implements DeliveryLoader {
  Future<OfflineSubmitResult> submitOfflineCompletion(String orderId, OfflineCapture capture);
  Future<void> reportDeliveryFailure(String orderId, String currentStatus, String reason);
}

/// Rider-facing text for each review reason the server gives
/// (functions/src/offlineCompletion.js REVIEW_REASONS).
const Map<String, String> kOfflineReviewReasons = {
  'too_old': 'it was sent more than 3 hours after it was recorded',
  'clock_ahead': "the phone's clock did not match",
  'before_dispatch': 'it was recorded before the order left the hub',
  'poor_accuracy': 'GPS accuracy was too low at the clinic',
  'outside_geofence': 'the recorded position is outside the clinic area',
  'no_track': 'there is no earlier tracked position to check it against',
  'implausible_track': 'it does not fit your tracked route',
  'destination_invalid': "the clinic's location is not set up correctly",
  'mocked_location': 'a mock-location app was on when it was recorded',
};

/// Delivery outcomes recorded without signal, sent by themselves once online.
///
/// * [saveCompletion] / [saveFailure] keep the record (and copies of the
///   photos) on the phone at once — nothing needs a connection.
/// * [sync] sends every waiting record: for a completion it re-reads the
///   order, uploads and records whichever photo the order does not have yet,
///   then submits the handoff fix; for a failure it sends the report. A
///   record with no signal stays waiting; one the server refused is kept with
///   the reason so the Rider sees it. Sends never run twice at once, and every
///   step is safe to repeat (uploads reuse the canonical object, the server
///   replays a completed order).
/// * The app calls [sync] when it starts, when it returns to the foreground,
///   and every [retryEvery] while something is waiting.
class OfflineDeliveryQueue extends ChangeNotifier {
  OfflineDeliveryQueue({
    required OfflineRecordStore store,
    required OfflineDeliverySender sender,
    required ProofUploader uploader,
    required ProofMetadataWriter writer,
    required String? Function() currentRider,
    DateTime Function()? clock,
    this.retryEvery = const Duration(seconds: 30),
  })  : _currentRider = currentRider,
        _store = store,
        _sender = sender,
        _uploader = uploader,
        _writer = writer,
        _clock = clock ?? DateTime.now;

  /// The signed-in rider (Firebase Auth's current user), read each time.
  final String? Function() _currentRider;
  final OfflineRecordStore _store;
  final OfflineDeliverySender _sender;
  final ProofUploader _uploader;
  final ProofMetadataWriter _writer;
  final DateTime Function() _clock;
  final Duration retryEvery;

  List<OfflineDeliveryRecord> _records = const [];
  bool _loaded = false;
  bool _syncing = false;
  Timer? _timer;

  /// The signed-in rider's records only. A phone can be shared: another
  /// rider's records stay on it (waiting for that rider to sign back in) but
  /// are never shown or sent in this session.
  List<OfflineDeliveryRecord> get _mine {
    final uid = _currentRider();
    if (uid == null || uid.isEmpty) return const [];
    return _records.where((r) => r.riderUid == uid).toList();
  }

  List<OfflineDeliveryRecord> get records => List.unmodifiable(_mine);
  bool get hasWaiting => _mine.any((r) => r.isWaiting);
  bool get isSyncing => _syncing;

  /// Records are kept at most this long, whoever saved them (photos included).
  static const Duration keepFor = Duration(days: 7);

  /// The record for [orderId], if any (the newest wins).
  OfflineDeliveryRecord? recordFor(String orderId) {
    for (final r in _mine.reversed) {
      if (r.orderId == orderId) return r;
    }
    return null;
  }

  /// An order with a waiting record must not be completed or reported again.
  bool isWaitingFor(String orderId) => recordFor(orderId)?.isWaiting ?? false;

  Future<void> load() async {
    if (_loaded) return;
    try {
      _records = await _store.load();
    } catch (_) {
      _records = const [];
    }
    _loaded = true;
    // Drop records with no owner (saved by an older build) and any older than
    // [keepFor], with their photos: nothing about a delivery lingers on a
    // phone indefinitely.
    final oldest = _clock().subtract(keepFor).millisecondsSinceEpoch;
    final drop = _records.where((r) => r.riderUid == null || r.recordedAtMs < oldest).toList();
    if (drop.isNotEmpty) {
      _records = _records.where((r) => !drop.contains(r)).toList();
      for (final r in drop) {
        try {
          await _store.deletePhotos(r.orderId);
        } catch (_) {}
      }
      try {
        await _store.save(_records);
      } catch (_) {}
    }
    _scheduleRetry();
    _notify();
  }

  /// Keep a completion recorded at the clinic without signal. Throws a
  /// [ProofException] when something required is missing. A photo the order
  /// already has recorded is not needed again (pass null).
  Future<void> saveCompletion({
    required Delivery delivery,
    required String recipientName,
    required File? proofPhoto,
    required File? invoicePhoto,
    required OfflineCapture capture,
  }) async {
    await load();
    final uid = _signedIn();
    final needsProof = !delivery.hasRecordedProof;
    final name = validateRecipientName(recipientName);
    if (needsProof && !name.valid) throw ProofException(name.code!, name.message!);
    if (needsProof && proofPhoto == null) {
      throw const ProofException('photo-required', 'Take a proof photo before saving.');
    }
    if (!delivery.hasRecordedInvoice && invoicePhoto == null) {
      throw const ProofException('invoice-required', 'Add the invoice photo before saving.');
    }
    if (capture.accuracyMeters > kOfflineMaxAccuracyMeters) {
      throw const ProofException(
        'gps-inaccurate',
        'Your GPS accuracy is too low to record where you are. Move to an open area and try again.',
      );
    }
    final proofPath = proofPhoto == null ? null : await _store.keepPhoto(delivery.id, 'proof', proofPhoto);
    final invoicePath = invoicePhoto == null ? null : await _store.keepPhoto(delivery.id, 'invoice', invoicePhoto);
    await _put(OfflineDeliveryRecord(
      riderUid: uid,
      orderId: delivery.id,
      orderNumber: delivery.orderNumber,
      destinationName: delivery.clinicName,
      kind: OfflineRecordKind.completion,
      recordedAtMs: _clock().millisecondsSinceEpoch,
      recipientName: name.valid ? name.value : null,
      proofPhotoPath: proofPath,
      invoicePhotoPath: invoicePath,
      capture: capture,
    ));
  }

  /// Keep a failed-delivery report made without signal.
  Future<void> saveFailure({required Delivery delivery, required String reason}) async {
    await load();
    final uid = _signedIn();
    assertTransition(kActorRider, delivery.status, 'delivery_failed');
    final checked = validateReason(reason, label: 'reason this delivery failed');
    if (!checked.valid) throw WorkflowException(checked.code!, checked.message!);
    await _put(OfflineDeliveryRecord(
      riderUid: uid,
      orderId: delivery.id,
      orderNumber: delivery.orderNumber,
      destinationName: delivery.clinicName,
      kind: OfflineRecordKind.failure,
      recordedAtMs: _clock().millisecondsSinceEpoch,
      failureReason: checked.value,
    ));
  }

  String _signedIn() {
    final uid = _currentRider();
    if (uid == null || uid.isEmpty) {
      throw const ProofException('not-signed-in', 'Sign in again to save this delivery on your phone.');
    }
    return uid;
  }

  /// Forget a finished (sent / refused) record the Rider has seen.
  Future<void> dismiss(String orderId) async {
    final uid = _currentRider();
    _records = _records.where((r) => r.riderUid != uid || r.orderId != orderId || r.isWaiting).toList();
    await _persist();
  }

  /// [riderUid] is signing out. Their finished records (and photos) are
  /// removed; ones still waiting stay on the phone, unsent and unseen, until
  /// that rider signs in again (or [keepFor] passes).
  Future<void> onSignedOut(String riderUid) async {
    await load();
    final finished = _records.where((r) => r.riderUid == riderUid && !r.isWaiting).toList();
    _records = _records.where((r) => !finished.contains(r)).toList();
    for (final r in finished) {
      try {
        await _store.deletePhotos(r.orderId);
      } catch (_) {}
    }
    await _persist();
    _scheduleRetry();
  }

  /// How many of [riderUid]'s records have not been sent yet.
  int waitingCountFor(String? riderUid) =>
      riderUid == null ? 0 : _records.where((r) => r.riderUid == riderUid && r.isWaiting).length;

  Future<void> _put(OfflineDeliveryRecord record) async {
    _records = [..._records.where((r) => r.riderUid != record.riderUid || r.orderId != record.orderId), record];
    await _persist();
    _scheduleRetry();
    // Signal may already be back: try at once (never blocks the caller).
    unawaited(sync());
  }

  Future<void> _persist() async {
    await _store.save(_records);
    _notify();
  }

  void _scheduleRetry() {
    _timer?.cancel();
    _timer = null;
    if (hasWaiting) _timer = Timer.periodic(retryEvery, (_) => sync());
  }

  /// Send every waiting record. Safe to call any time, from anywhere.
  Future<void> sync() async {
    if (_syncing) return;
    await load();
    if (!hasWaiting) return;
    _syncing = true;
    _notify();
    try {
      for (final record in _mine.where((r) => r.isWaiting).toList()) {
        final next = await _send(record);
        if (next == null) break; // no signal: the rest would fail the same way
        _records = [for (final r in _records) identical(r, record) ? next : r];
        if (next.stage != OfflineRecordStage.waiting) {
          try {
            await _store.deletePhotos(record.orderId);
          } catch (_) {}
        }
        await _persist();
      }
    } finally {
      _syncing = false;
      _scheduleRetry();
      _notify();
    }
  }

  /// One record: its new state, or null when there was no signal.
  Future<OfflineDeliveryRecord?> _send(OfflineDeliveryRecord record) async {
    final attempted = record.copyWith(attempts: record.attempts + 1);
    try {
      final order = await _sender.fetchDelivery(record.orderId);
      if (record.kind == OfflineRecordKind.failure) {
        if (order.isDeliveryFailed) return attempted.copyWith(stage: OfflineRecordStage.done);
        await _sender.reportDeliveryFailure(order.id, order.status, record.failureReason ?? '');
        return attempted.copyWith(stage: OfflineRecordStage.done);
      }
      if (order.isDelivered) return attempted.copyWith(stage: OfflineRecordStage.done);
      if (!order.hasRecordedProof) {
        if (record.proofPhotoPath == null) throw const ProofException('photo-required', 'the proof photo is missing — open the delivery and take it again');
        final upload = await _uploader.uploadProof(order.id, File(record.proofPhotoPath!));
        try {
          await _writer.saveProofOfDelivery(
            orderId: order.id,
            recipientName: record.recipientName ?? '',
            proofUrl: upload.downloadUrl,
            storagePath: upload.storagePath,
          );
        } on ProofException catch (e) {
          if (e.code != 'proof-already-finalized') rethrow;
        }
      }
      if (!order.hasRecordedInvoice) {
        if (record.invoicePhotoPath == null) throw const ProofException('invoice-required', 'the invoice photo is missing — open the delivery and add it again');
        final upload = await _uploader.uploadInvoice(order.id, File(record.invoicePhotoPath!));
        try {
          await _writer.saveInvoicePhoto(orderId: order.id, invoiceUrl: upload.downloadUrl, storagePath: upload.storagePath);
        } on ProofException catch (e) {
          if (e.code != 'invoice-already-finalized') rethrow;
        }
      }
      final result = await _sender.submitOfflineCompletion(order.id, record.capture!);
      if (result.delivered) return attempted.copyWith(stage: OfflineRecordStage.done);
      return attempted.copyWith(
        stage: OfflineRecordStage.inReview,
        message: kOfflineReviewReasons[result.reviewReason] ?? 'it could not be checked automatically',
      );
    } catch (e) {
      final kind = classifyEvidenceError(e);
      if (kind == EvidenceErrorKind.network || _isTransportFailure(e)) {
        // Still no signal (or a dropped link): keep it exactly as it was.
        _records = [for (final r in _records) identical(r, record) ? attempted : r];
        return null;
      }
      return attempted.copyWith(stage: OfflineRecordStage.refused, message: _refusalText(e));
    }
  }

  static bool _isTransportFailure(Object e) =>
      e is StateError && e.message != 'order-not-found' ||
      e is WorkflowException && const {'unavailable', 'deadline-exceeded', 'internal'}.contains(e.code);

  static String _refusalText(Object e) {
    if (e is StateError && e.message == 'order-not-found') return 'this delivery no longer exists';
    if (e is WorkflowException) return e.message;
    if (e is ProofException) return e.message;
    if (classifyEvidenceError(e) == EvidenceErrorKind.permissionDenied) {
      return 'this delivery is no longer assigned to you';
    }
    return 'the delivery changed while you were offline — contact your dispatcher';
  }

  bool _disposed = false;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}
