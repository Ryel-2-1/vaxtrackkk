import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import '../models/delivery.dart';

/// The rider's deliveries plus the Firestore sync metadata for that snapshot,
/// so the UI can honestly show a cached / pending-sync / synced indicator.
class RiderDeliveriesSnapshot {
  const RiderDeliveriesSnapshot({
    required this.deliveries,
    required this.isFromCache,
    required this.hasPendingWrites,
  });

  final List<Delivery> deliveries;

  /// The snapshot was served from the local cache (previously-loaded data).
  final bool isFromCache;

  /// At least one local write in this snapshot has not reached the server yet.
  final bool hasPendingWrites;
}

class DeliveryService {
  final FirebaseFirestore _db = FirebaseFirestore.instance;

  Map<String, dynamic> _auditFields() {
    final user = FirebaseAuth.instance.currentUser;
    return {
      'statusUpdatedByUid': user?.uid,
      'statusUpdatedByEmail': user?.email,
      'statusUpdatedAt': FieldValue.serverTimestamp(),
      'updatedAt': FieldValue.serverTimestamp(),
    };
  }

  Stream<List<Delivery>> riderDeliveries(String riderId) {
    return _db
        .collection('orders')
        .where('assignedRiderId', isEqualTo: riderId)
        .snapshots()
        .map((snap) {
      final list = snap.docs
          .map((doc) => Delivery.fromFirestore(doc.id, doc.data()))
          .toList();
      list.sort((a, b) {
        final aMs = a.createdAt?.millisecondsSinceEpoch ?? 0;
        final bMs = b.createdAt?.millisecondsSinceEpoch ?? 0;
        return bMs - aMs;
      });
      return list;
    });
  }

  /// Same UID-scoped query as [riderDeliveries], but keeps the snapshot's sync
  /// metadata instead of discarding it. `includeMetadataChanges: true` lets the
  /// stream re-emit when only metadata changes (e.g. a pending write clears to
  /// synced) so the indicator updates without needing a data change.
  Stream<RiderDeliveriesSnapshot> riderDeliveriesWithSync(String riderId) {
    return _db
        .collection('orders')
        .where('assignedRiderId', isEqualTo: riderId)
        .snapshots(includeMetadataChanges: true)
        .map((snap) {
      final list = snap.docs
          .map((doc) => Delivery.fromFirestore(doc.id, doc.data()))
          .toList();
      list.sort((a, b) {
        final aMs = a.createdAt?.millisecondsSinceEpoch ?? 0;
        final bMs = b.createdAt?.millisecondsSinceEpoch ?? 0;
        return bMs - aMs;
      });
      return RiderDeliveriesSnapshot(
        deliveries: list,
        isFromCache: snap.metadata.isFromCache,
        hasPendingWrites: snap.metadata.hasPendingWrites,
      );
    });
  }

  Future<void> updateStatus(String orderId, String newStatus) {
    return _db.collection('orders').doc(orderId).update({
      'status': newStatus,
      ..._auditFields(),
    });
  }

  Future<void> startLoading(String orderId) {
    return _db.collection('orders').doc(orderId).update({
      'status': 'loading',
      'startedAt': FieldValue.serverTimestamp(),
      ..._auditFields(),
    });
  }

  Future<void> startTransit(String orderId) {
    return _db.collection('orders').doc(orderId).update({
      'status': 'in_transit',
      'startedAt': FieldValue.serverTimestamp(),
      ..._auditFields(),
    });
  }

  Future<void> markDelivered(String orderId) {
    return _db.collection('orders').doc(orderId).update({
      'status': 'delivered',
      'deliveredAt': FieldValue.serverTimestamp(),
      ..._auditFields(),
    });
  }

  Future<void> reportDelay(String orderId, String reason) {
    return _db.collection('orders').doc(orderId).update({
      'status': 'delayed',
      'delayReason': reason,
      'delayedAt': FieldValue.serverTimestamp(),
      ..._auditFields(),
    });
  }

  Future<void> saveProofOfDelivery(String orderId, String imageUrl) {
    return _db.collection('orders').doc(orderId).update({
      'proofOfDeliveryUrl': imageUrl,
      'updatedAt': FieldValue.serverTimestamp(),
    });
  }

  Future<void> saveInvoicePhoto(String orderId, String imageUrl) {
    return _db.collection('orders').doc(orderId).update({
      'invoiceUrl': imageUrl,
      'updatedAt': FieldValue.serverTimestamp(),
    });
  }
}
