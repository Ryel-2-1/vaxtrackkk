import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import '../models/delivery.dart';

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
