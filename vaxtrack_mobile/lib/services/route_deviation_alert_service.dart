import 'package:cloud_firestore/cloud_firestore.dart';

/// LOCAL-ONLY route-deviation → Firestore incident bridge.
///
/// This turns the pure, device-proven `DeviationEvent.deviated` /
/// `DeviationEvent.returnedToRoute` transitions (from the
/// `RouteComplianceMonitor`) into ONE idempotent document in the existing
/// `alerts` collection, so it appears in the current Admin Alerts page with no
/// new collection and no new admin screen.
///
/// Design goals:
///  * **Idempotent** — a deterministic document id per (rider + delivery) means
///    retries / app restarts never create duplicate unresolved alerts.
///  * **Transactional** — create / reopen / update / resolve are decided inside
///    a Firestore transaction from the latest snapshot, so deviation and return
///    cannot corrupt each other.
///  * **Testable** — all the decision logic lives in the PURE top-level
///    `planDeviationWrite` / `planReturnWrite` functions and the deterministic
///    id helper, which touch no Firebase and are unit-tested directly. The
///    service methods are a thin transaction adapter around them.
///
/// Firestore is resolved LAZILY (`_db`) so merely constructing this service —
/// or the screen that owns it — never touches Firebase. The Firebase-free dev
/// harness passes a null alert context, so the write methods are never reached.

/// The alert `type` value shared with the web Admin Alerts renderer.
const String kRouteDeviationType = 'route_deviation';

/// Minimal, confirmed-only identity + display context for one incident. Built
/// by the real delivery screen from Firestore data + Auth; the dev harness
/// passes null (→ no Firebase calls at all).
class RouteDeviationContext {
  /// Firestore ORDER document id (`Delivery.id`) — the incident identity.
  final String orderId;

  /// Authenticated rider UID (`FirebaseAuth.currentUser.uid`).
  final String riderUid;

  /// Human-readable order number (display metadata only — never an id).
  final String? orderNumber;

  /// Destination clinic name (display).
  final String? clinicName;

  /// Assigned rider display name (display).
  final String? riderName;

  const RouteDeviationContext({
    required this.orderId,
    required this.riderUid,
    this.orderNumber,
    this.clinicName,
    this.riderName,
  });

  /// Both identity parts must be present for any write to be attempted.
  bool get isValid => orderId.trim().isNotEmpty && riderUid.trim().isNotEmpty;
}

/// What a planned write does to the deterministic incident document.
enum IncidentAction { create, updateActive, reopen, resolve, noop }

/// A pure, Firebase-free description of the write to apply. [data] holds the
/// concrete field values; [serverTimestampFields] names the fields the adapter
/// must set to `FieldValue.serverTimestamp()` (kept out of [data] so the plan
/// stays pure and directly assertable in tests).
class IncidentPlan {
  final IncidentAction action;
  final Map<String, Object?> data;
  final List<String> serverTimestampFields;

  const IncidentPlan(this.action, this.data, this.serverTimestampFields);
}

/// Deterministic incident id from `type + order doc id + rider uid`. Stable for
/// the same (order, rider), so retries/restarts reuse the same document.
///
/// Prefixed with the alert type so it can never match Firestore's reserved
/// `__.*__` id pattern; rejects empty parts and `/` so the result is always a
/// valid Firestore document id.
String routeDeviationAlertId(String orderId, String riderUid) {
  final o = orderId.trim();
  final r = riderUid.trim();
  if (o.isEmpty || r.isEmpty) {
    throw ArgumentError('orderId and riderUid must both be non-empty');
  }
  if (o.contains('/') || r.contains('/')) {
    throw ArgumentError('orderId/riderUid must not contain "/"');
  }
  return '${kRouteDeviationType}_${o}_$r';
}

String _deviationMessage(RouteDeviationContext c, double distanceMeters) {
  final order = (c.orderNumber != null && c.orderNumber!.trim().isNotEmpty)
      ? c.orderNumber!.trim()
      : c.orderId;
  final clinic = (c.clinicName != null && c.clinicName!.trim().isNotEmpty)
      ? c.clinicName!.trim()
      : 'the delivery destination';
  final rider = (c.riderName != null && c.riderName!.trim().isNotEmpty)
      ? c.riderName!.trim()
      : 'Rider';
  final dist = distanceMeters.isFinite ? distanceMeters.round() : 0;
  return '$rider left the assigned route for order $order to $clinic '
      '- now ${dist}m off the planned route.';
}

Map<String, Object?> _detectionFields({
  required double latitude,
  required double longitude,
  required double distanceMeters,
  double? accuracyMeters,
}) {
  return <String, Object?>{
    'latitude': latitude,
    'longitude': longitude,
    'distanceMeters': distanceMeters.isFinite ? distanceMeters : null,
    'accuracyMeters': ?accuracyMeters,
  };
}

/// Decide the write for a CONFIRMED deviation, given the current document data
/// ([existing] == null when the document does not exist yet).
///
///  * no doc            → [IncidentAction.create] (episodeCount 1, active;
///                        createdAt AND firstCreatedAt both stamped now)
///  * doc resolved      → [IncidentAction.reopen]  (episodeCount + 1, active;
///                        createdAt REFRESHED to now so the reopened incident
///                        resurfaces as recent in the createdAt-ordered Admin
///                        list, while firstCreatedAt keeps the ORIGINAL time)
///  * doc unresolved    → [IncidentAction.updateActive] (latest detection only;
///                        NO new document, NO episode increment, timestamps kept)
IncidentPlan planDeviationWrite({
  required Map<String, dynamic>? existing,
  required RouteDeviationContext context,
  required double latitude,
  required double longitude,
  required double distanceMeters,
  double? accuracyMeters,
}) {
  if (!context.isValid) {
    throw ArgumentError('RouteDeviationContext missing orderId/riderUid');
  }

  final detection = _detectionFields(
    latitude: latitude,
    longitude: longitude,
    distanceMeters: distanceMeters,
    accuracyMeters: accuracyMeters,
  );
  final message = _deviationMessage(context, distanceMeters);

  if (existing == null) {
    return IncidentPlan(
      IncidentAction.create,
      <String, Object?>{
        'type': kRouteDeviationType,
        'severity': 'critical',
        'status': 'active',
        'read': false,
        'title': 'Route Deviation Detected',
        'message': message,
        // Identity: the Firestore order doc id (NOT the order number).
        'orderId': context.orderId,
        'deliveryId': context.orderId,
        // Display metadata.
        'orderNumber': context.orderNumber,
        'riderId': context.riderUid,
        'riderName': context.riderName,
        'clinicName': context.clinicName,
        'location': context.clinicName,
        'resolutionReason': null,
        'resolvedAt': null,
        'episodeCount': 1,
        ...detection,
      },
      // firstCreatedAt is stamped once, at creation, and never rewritten.
      const <String>[
        'createdAt',
        'firstCreatedAt',
        'updatedAt',
        'lastDetectedAt',
      ],
    );
  }

  final status = (existing['status'] ?? 'active').toString();
  if (status == 'resolved') {
    final prev = existing['episodeCount'];
    final prevCount = (prev is num) ? prev.toInt() : 1;
    return IncidentPlan(
      IncidentAction.reopen,
      <String, Object?>{
        'status': 'active',
        'read': false,
        'severity': 'critical',
        'message': message,
        'resolutionReason': null,
        'resolvedAt': null,
        'episodeCount': prevCount + 1,
        ...detection,
      },
      // createdAt is REFRESHED to now (the reopened incident should resurface
      // as recent); firstCreatedAt is intentionally absent here, preserving the
      // ORIGINAL creation time.
      const <String>['createdAt', 'reopenedAt', 'updatedAt', 'lastDetectedAt'],
    );
  }

  // Already unresolved: a retry / restart. Refresh latest detection only.
  return IncidentPlan(
    IncidentAction.updateActive,
    <String, Object?>{
      'message': message,
      ...detection,
      // status, episodeCount and createdAt intentionally untouched.
    },
    const <String>['updatedAt', 'lastDetectedAt'],
  );
}

/// Decide the write for a confirmed return-to-route. Updates ONLY the same
/// incident to resolved/returned; if it does not exist, it is a safe no-op (a
/// return must never create a return-only alert).
IncidentPlan planReturnWrite({
  required Map<String, dynamic>? existing,
  required RouteDeviationContext context,
  double? latitude,
  double? longitude,
  double? distanceMeters,
  double? accuracyMeters,
}) {
  if (!context.isValid) {
    throw ArgumentError('RouteDeviationContext missing orderId/riderUid');
  }
  if (existing == null) {
    return const IncidentPlan(
      IncidentAction.noop,
      <String, Object?>{},
      <String>[],
    );
  }
  return IncidentPlan(
    IncidentAction.resolve,
    <String, Object?>{
      'status': 'resolved',
      'resolutionReason': 'returned_to_route',
      'latitude': ?latitude,
      'longitude': ?longitude,
      if (distanceMeters != null && distanceMeters.isFinite)
        'distanceMeters': distanceMeters,
      'accuracyMeters': ?accuracyMeters,
    },
    const <String>['resolvedAt', 'updatedAt'],
  );
}

/// Thin transaction adapter over the pure planners above.
class RouteDeviationAlertService {
  RouteDeviationAlertService({FirebaseFirestore? firestore})
    : _injected = firestore;

  final FirebaseFirestore? _injected;

  // Resolved lazily so constructing the service never touches Firebase (keeps
  // the Firebase-free dev harness fully functional).
  FirebaseFirestore get _db => _injected ?? FirebaseFirestore.instance;

  static const String alertsCollection = 'alerts';

  DocumentReference<Map<String, dynamic>> _docFor(RouteDeviationContext c) {
    return _db
        .collection(alertsCollection)
        .doc(routeDeviationAlertId(c.orderId, c.riderUid));
  }

  /// Create / reopen / refresh the deterministic incident for a confirmed
  /// deviation, inside a transaction.
  Future<void> recordDeviation({
    required RouteDeviationContext context,
    required double latitude,
    required double longitude,
    required double distanceMeters,
    double? accuracyMeters,
  }) async {
    if (!context.isValid) {
      throw ArgumentError('RouteDeviationContext missing orderId/riderUid');
    }
    final ref = _docFor(context);
    await _db.runTransaction((tx) async {
      final snap = await tx.get(ref);
      final plan = planDeviationWrite(
        existing: snap.exists ? snap.data() : null,
        context: context,
        latitude: latitude,
        longitude: longitude,
        distanceMeters: distanceMeters,
        accuracyMeters: accuracyMeters,
      );
      _apply(tx, ref, plan, isCreate: plan.action == IncidentAction.create);
    });
  }

  /// Resolve the SAME incident on a confirmed return-to-route; no-op if none
  /// exists.
  Future<void> recordReturn({
    required RouteDeviationContext context,
    double? latitude,
    double? longitude,
    double? distanceMeters,
    double? accuracyMeters,
  }) async {
    if (!context.isValid) {
      throw ArgumentError('RouteDeviationContext missing orderId/riderUid');
    }
    final ref = _docFor(context);
    await _db.runTransaction((tx) async {
      final snap = await tx.get(ref);
      if (!snap.exists) return; // safe no-op — never create a return-only alert
      final plan = planReturnWrite(
        existing: snap.data(),
        context: context,
        latitude: latitude,
        longitude: longitude,
        distanceMeters: distanceMeters,
        accuracyMeters: accuracyMeters,
      );
      if (plan.action == IncidentAction.noop) return;
      _apply(tx, ref, plan, isCreate: false);
    });
  }

  void _apply(
    Transaction tx,
    DocumentReference<Map<String, dynamic>> ref,
    IncidentPlan plan, {
    required bool isCreate,
  }) {
    final data = <String, Object?>{...plan.data};
    for (final field in plan.serverTimestampFields) {
      data[field] = FieldValue.serverTimestamp();
    }
    if (isCreate) {
      tx.set(ref, data);
    } else {
      tx.update(ref, data);
    }
  }
}
