import 'dart:io';

import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';

import '../models/delivery.dart';
import '../services/delivery_service.dart';
import '../services/image_upload_service.dart';
import '../services/proof_service.dart';
import 'offline_delivery_queue.dart';
import 'offline_delivery_record.dart';
import 'offline_file_store.dart';

/// The real server calls behind [OfflineDeliveryQueue].
class FirebaseOfflineDeliverySender implements OfflineDeliverySender {
  // Created on first use, so merely showing the queue (the dashboard banner)
  // never touches Firebase.
  late final DeliveryService _deliveries = DeliveryService();
  late final FirebaseFunctions _functions = FirebaseFunctions.instanceFor(region: 'asia-southeast1');

  @override
  Future<Delivery> fetchDelivery(String orderId) => _deliveries.fetchDelivery(orderId);

  @override
  Future<void> reportDeliveryFailure(String orderId, String currentStatus, String reason) =>
      _deliveries.reportDeliveryFailure(orderId, currentStatus, reason);

  /// submitOfflineDeliveryCompletion: only the order id and the handoff fix are
  /// sent; the server decides (functions/src/offlineCompletion.js).
  @override
  Future<OfflineSubmitResult> submitOfflineCompletion(String orderId, OfflineCapture capture) async {
    try {
      final result = await _functions
          .httpsCallable('submitOfflineDeliveryCompletion')
          .call<Map<String, dynamic>>({'orderId': orderId, 'capture': capture.toPayload()});
      final data = result.data;
      if (data['status'] == 'delivered') return const OfflineSubmitResult(delivered: true);
      return OfflineSubmitResult(delivered: false, reviewReason: data['reason'] as String?);
    } on FirebaseFunctionsException catch (e) {
      throw callableFailure(e, 'Could not send this delivery. It stays saved on your phone.');
    }
  }
}

class _LazyUploader implements ProofUploader {
  late final ImageUploadService _s = ImageUploadService();
  @override
  Future<EvidenceUpload> uploadProof(String orderId, File file) => _s.uploadProof(orderId, file);
  @override
  Future<EvidenceUpload> uploadInvoice(String orderId, File file) => _s.uploadInvoice(orderId, file);
  @override
  Future<String?> existingProofUrl(String orderId) => _s.existingProofUrl(orderId);
  @override
  Future<String?> existingInvoiceUrl(String orderId) => _s.existingInvoiceUrl(orderId);
}

class _LazyWriter implements ProofMetadataWriter {
  late final ProofService _s = ProofService();
  @override
  Future<void> saveProofOfDelivery({required String orderId, required String recipientName, required String proofUrl, String? storagePath}) =>
      _s.saveProofOfDelivery(orderId: orderId, recipientName: recipientName, proofUrl: proofUrl, storagePath: storagePath);
  @override
  Future<void> saveInvoicePhoto({required String orderId, required String invoiceUrl, String? storagePath}) =>
      _s.saveInvoicePhoto(orderId: orderId, invoiceUrl: invoiceUrl, storagePath: storagePath);
}

/// The app-wide queue (loaded and synced by HomeScreen).
/// The signed-in rider, or null — also when Firebase is not set up (widget
/// tests), so nothing offline is shown or sent there.
String? _signedInRider() {
  try {
    return FirebaseAuth.instance.currentUser?.uid;
  } catch (_) {
    return null;
  }
}

final OfflineDeliveryQueue offlineDeliveries = OfflineDeliveryQueue(
  currentRider: _signedInRider,
  store: OfflineFileStore(),
  sender: FirebaseOfflineDeliverySender(),
  uploader: _LazyUploader(),
  writer: _LazyWriter(),
);
