import '../models/delivery.dart';

/// Pure, Firestore-free normalization of a batch of raw order documents.
///
/// WHY THIS IS PUBLIC (and why it is a separate file):
///
/// The isolation contract this implements — one unreadable order must never
/// hide the rider's other orders — is the exact behaviour that failed in
/// production, so it needs direct test coverage. Testing it through
/// `DeliveryService` would require faking a `QuerySnapshot`, i.e. adding a
/// Firestore mocking dependency purely for a test.
///
/// Taking `(id, data)` pairs instead of a `QuerySnapshot` removes the Firebase
/// coupling entirely: the decision logic becomes ordinary Dart that a unit test
/// can call directly. `DeliveryService` keeps a private three-line adapter that
/// unwraps the snapshot and delegates here, so no Firestore type appears in
/// this file and no new production surface exists beyond this one function.
///
/// This mirrors the pattern the codebase already uses for route deviation:
/// pure decision logic in `utils/` (`deviation_detector.dart`), a thin
/// Firestore adapter in `services/` (`route_deviation_alert_service.dart`).

/// One raw order: its Firestore document id and its data map.
typedef OrderEntry = ({String id, Map<String, dynamic> data});

/// An order that could not be normalized, and why. The [error] is retained for
/// the caller's diagnostics; it is never rendered into UI.
typedef MalformedOrder = ({String id, Object error});

/// Deliveries that normalized successfully, plus the ones that did not.
typedef OrderMappingResult = ({
  List<Delivery> deliveries,
  List<MalformedOrder> malformed,
});

/// Normalize [entries] into [Delivery] objects, ISOLATING per-entry failures.
///
/// Guarantees:
///  * a single entry that throws is skipped and recorded in `malformed`;
///  * every other entry is still returned — a bad document can never hide a
///    good one;
///  * skipped entries are never replaced with placeholder/invented orders;
///  * document ids are preserved on the returned deliveries;
///  * results are sorted newest-first by `createdAt` (missing dates sort last),
///    matching the order the rider's list has always used;
///  * this function itself never throws, so the caller's stream stays alive.
///
/// It deliberately isolates only NORMALIZATION failures. Transport-level
/// problems (permission-denied, network) are not seen here and must keep
/// flowing through the stream's error channel.
OrderMappingResult mapOrderEntries(Iterable<OrderEntry> entries) {
  final deliveries = <Delivery>[];
  final malformed = <MalformedOrder>[];

  for (final entry in entries) {
    try {
      deliveries.add(Delivery.fromFirestore(entry.id, entry.data));
    } catch (error) {
      malformed.add((id: entry.id, error: error));
    }
  }

  deliveries.sort((a, b) {
    final aMs = a.createdAt?.millisecondsSinceEpoch ?? 0;
    final bMs = b.createdAt?.millisecondsSinceEpoch ?? 0;
    return bMs - aMs;
  });

  return (deliveries: deliveries, malformed: malformed);
}
