import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import '../models/delivery.dart';
import '../utils/order_mapping.dart';
import '../utils/order_workflow.dart';
import '../utils/safe_log.dart';

/// The rider's deliveries plus the Firestore sync metadata for that snapshot,
/// so the UI can honestly show a cached / pending-sync / synced indicator.
class RiderDeliveriesSnapshot {
  const RiderDeliveriesSnapshot({
    required this.deliveries,
    required this.isFromCache,
    required this.hasPendingWrites,
    this.malformedDocIds = const <String>[],
  });

  final List<Delivery> deliveries;

  /// The snapshot was served from the local cache (previously-loaded data).
  final bool isFromCache;

  /// At least one local write in this snapshot has not reached the server yet.
  final bool hasPendingWrites;

  /// Document ids in this snapshot that could not be parsed into a [Delivery]
  /// and were therefore skipped. Ids only — never document contents.
  final List<String> malformedDocIds;

  /// True when at least one order in this snapshot was unreadable.
  bool get hasMalformedDocs => malformedDocIds.isNotEmpty;
}

/// Firestore adapter over the pure [mapOrderEntries].
///
/// Previously every document went through `Delivery.fromFirestore` inside a
/// single `.map()`, so one malformed order threw out of the whole snapshot
/// mapping and the rider saw an error instead of ANY deliveries — a single bad
/// document could hide every valid one assigned to them.
///
/// All the isolation logic lives in [mapOrderEntries] (pure, unit-tested); this
/// only unwraps the snapshot and logs. Diagnostics carry the document id and
/// the error TYPE — never the error message, which can embed document values.
///
/// This deliberately isolates ONLY per-document normalization failures.
/// Stream-level errors (permission-denied, network) never reach here and still
/// surface through the stream's error channel.
({List<Delivery> deliveries, List<String> malformedIds}) _mapOrderDocs(
  QuerySnapshot<Map<String, dynamic>> snap,
) {
  final result = mapOrderEntries(
    snap.docs.map((doc) => (id: doc.id, data: doc.data())),
  );

  for (final bad in result.malformed) {
    logSuppressedError(
      'DeliveryService',
      'skipped unreadable order ${bad.id}',
      bad.error,
    );
  }

  return (
    deliveries: result.deliveries,
    malformedIds: result.malformed.map((m) => m.id).toList(growable: false),
  );
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
        .map((snap) => _mapOrderDocs(snap).deliveries);
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
      final mapped = _mapOrderDocs(snap);
      return RiderDeliveriesSnapshot(
        deliveries: mapped.deliveries,
        isFromCache: snap.metadata.isFromCache,
        hasPendingWrites: snap.metadata.hasPendingWrites,
        malformedDocIds: mapped.malformedIds,
      );
    });
  }

  // The rider's lifecycle authority, and nothing more.
  //
  // `updateStatus`, `startLoading` and `startTransit` are gone. The first
  // accepted ANY status string, so a screen could send whatever it liked; the
  // other two performed assigned → loading and loading → in_transit, which are
  // Cargo Loading's authority — the dispatcher confirms the cargo is loaded and
  // finalizes the run. Removing the buttons alone would have left those methods
  // callable, so the methods went too.
  //
  // Each remaining method validates the move against the shared policy BEFORE
  // touching Firestore, using the delivery's current status. That is a client
  // guard for fast, clear feedback; the Firestore rules re-check every one of
  // these independently and remain the authority.

  /// in_transit → delayed. [currentStatus] is the delivery's status as stored.
  Future<void> reportDelay(String orderId, String currentStatus, String reason) {
    assertTransition(kActorRider, currentStatus, 'delayed');
    final trimmed = reason.trim();
    if (trimmed.isEmpty) {
      throw const WorkflowException(
          'delay-reason-required', 'Please give a reason for the delay.');
    }
    return _db.collection('orders').doc(orderId).update({
      'status': 'delayed',
      'delayReason': trimmed,
      'delayedAt': FieldValue.serverTimestamp(),
      ..._auditFields(),
    });
  }

  /// delayed → in_transit.
  Future<void> resumeTransit(String orderId, String currentStatus) {
    assertTransition(kActorRider, currentStatus, 'in_transit');
    return _db.collection('orders').doc(orderId).update({
      'status': 'in_transit',
      'startedAt': FieldValue.serverTimestamp(),
      ..._auditFields(),
    });
  }

  /// in_transit → delivered, or delayed → delivered.
  Future<void> markDelivered(String orderId, String currentStatus) {
    assertTransition(kActorRider, currentStatus, 'delivered');
    return _db.collection('orders').doc(orderId).update({
      'status': 'delivered',
      'deliveredAt': FieldValue.serverTimestamp(),
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
