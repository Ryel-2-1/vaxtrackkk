import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
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

/// Reads one order authoritatively. Delivery Detail uses it to reload after the
/// rider returns from Proof of Delivery; tests supply a fake.
abstract class DeliveryLoader {
  Future<Delivery> fetchDelivery(String orderId);
}

/// Runs the trusted completion. [DeliveryService] implements it with the
/// server-side, inventory-settling callable; tests supply a fake.
abstract class DeliveryCompleter {
  Future<void> markDelivered(String orderId, String currentStatus);
}

class DeliveryService implements DeliveryLoader, DeliveryCompleter {
  final FirebaseFirestore _db = FirebaseFirestore.instance;

  /// Same region as the deployed functions and as staging Firestore. A
  /// mismatch fails loudly at call time rather than reaching a different
  /// deployment.
  final FirebaseFunctions _functions =
      FirebaseFunctions.instanceFor(region: 'asia-southeast1');

  Map<String, dynamic> _auditFields() {
    final user = FirebaseAuth.instance.currentUser;
    return {
      'statusUpdatedByUid': user?.uid,
      'statusUpdatedByEmail': user?.email,
      'statusUpdatedAt': FieldValue.serverTimestamp(),
      'updatedAt': FieldValue.serverTimestamp(),
    };
  }

  /// One authoritative read of a single order, from the SERVER (not the cache).
  ///
  /// Delivery Detail calls this when the rider returns from Proof of Delivery,
  /// so newly recorded proof/invoice URLs — and any status or assignment change
  /// made meanwhile — come from the server rather than a stale snapshot.
  /// Throws when the order cannot be read (offline, reassigned so the rules deny
  /// it, deleted, or unparseable); callers must then treat the evidence on
  /// screen as UNCONFIRMED rather than assume an upload landed.
  @override
  Future<Delivery> fetchDelivery(String orderId) async {
    final snap = await _db
        .collection('orders')
        .doc(orderId)
        .get(const GetOptions(source: Source.server));
    final data = snap.data();
    if (!snap.exists || data == null) {
      throw StateError('order-not-found');
    }
    return Delivery.fromFirestore(snap.id, data);
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
    final checked = validateReason(reason, label: 'reason for the delay');
    if (!checked.valid) {
      throw WorkflowException(checked.code!, checked.message!);
    }
    return _db.collection('orders').doc(orderId).update({
      'status': 'delayed',
      'delayReason': checked.value,
      'delayedAt': FieldValue.serverTimestamp(),
      ..._auditFields(),
    });
  }

  /// in_transit → delivery_failed, or delayed → delivery_failed.
  ///
  /// The rider reports that the delivery could not be completed and stops
  /// there. Retrying or cancelling is the dispatcher's decision, so nothing
  /// here moves the order onward — it parks in `delivery_failed` until the
  /// dispatcher acts.
  ///
  /// Runs on the SERVER (callable `reportDeliveryFailure`). A failure moves
  /// stock: the order's reserved units — exact batches and quantities — become
  /// return-pending (neither reserved nor available) until an Admin confirms
  /// their condition, and a return record is written. That has to commit with
  /// the status change, so Firestore rules now refuse a direct
  /// `delivery_failed` write from any client.
  ///
  /// The rider's identity comes from the authenticated call, never an
  /// argument; the server re-checks that the caller is the assigned rider and
  /// that the order is in transit or delayed. A repeated report by the same
  /// rider is answered as a replay, not a second return.
  Future<void> reportDeliveryFailure(
      String orderId, String currentStatus, String reason) async {
    assertTransition(kActorRider, currentStatus, 'delivery_failed');
    final checked = validateReason(reason, label: 'reason this delivery failed');
    if (!checked.valid) {
      throw WorkflowException(checked.code!, checked.message!);
    }
    if (FirebaseAuth.instance.currentUser?.uid == null) {
      throw const WorkflowException(
          'not-signed-in', 'Your session has expired. Please sign in again.');
    }
    try {
      await _functions
          .httpsCallable('reportDeliveryFailure')
          .call<Map<String, dynamic>>({'orderId': orderId, 'reason': checked.value});
    } on FirebaseFunctionsException catch (e) {
      // Same mapping as markDelivered: the server's domain code when present,
      // Firebase's own code otherwise (a dropped connection is not a refusal).
      final code = (e.details is Map) ? e.details['code'] as String? : null;
      throw WorkflowException(
        code ?? e.code,
        e.message ?? 'Could not report this delivery as failed. Please try again.',
      );
    }
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
  ///
  /// Runs on the server. Completing a delivery CONSUMES the order's reserved
  /// stock — the reservation closes and each batch's on-hand figure drops — and
  /// that has to commit in the same transaction as the status change, or an
  /// order could read as delivered while its stock was never deducted.
  /// Firestore rules now refuse a direct `delivered` write from any client, so
  /// this callable is the only path.
  ///
  /// The client-side transition check stays as fast, local feedback; the server
  /// re-reads the order and re-checks everything independently, including that
  /// the caller is the CURRENTLY assigned rider.
  ///
  /// The server also requires BOTH evidence photos to be recorded on the order
  /// by this rider (functions/src/deliveryEvidence.js), so the Rider app calls
  /// this only from "Submit Proof & Complete Delivery", after recording them.
  @override
  Future<void> markDelivered(String orderId, String currentStatus) async {
    assertTransition(kActorRider, currentStatus, 'delivered');
    try {
      await _functions
          .httpsCallable('markOrderDeliveredWithInventoryConsumption')
          .call<Map<String, dynamic>>({'orderId': orderId});
    } on FirebaseFunctionsException catch (e) {
      // The server's domain code travels in `details`; its message is already
      // written for the rider. Anything else is reported as a service problem
      // rather than dressed up as a delivery problem.
      // Without a domain code, keep Firebase's own (e.g. 'unavailable'), so a
      // dropped connection is never reported as a refusal.
      final code = (e.details is Map) ? e.details['code'] as String? : null;
      throw WorkflowException(
        code ?? e.code,
        e.message ?? 'Could not complete this delivery. Please try again.',
      );
    }
  }

  // Proof of delivery lives in ProofService, not here.
  //
  // `saveProofOfDelivery` and `saveInvoicePhoto` used to sit at this spot: two
  // unconditional `update()` calls that took any order id and any string and
  // verified nothing — not the caller, not the assignment, not the order's
  // state, not which object the URL pointed at. Leaving them in place while the
  // screen moved to the validated path would have left the unchecked write
  // callable from anywhere, so they went with it.
  //
  // See services/proof_service.dart: the same two operations, re-read
  // transactionally and authorized against the order as it is on the server.
}
