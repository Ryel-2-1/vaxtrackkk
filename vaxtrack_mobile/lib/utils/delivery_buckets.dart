import '../models/delivery.dart';

/// The one split of a rider's deliveries that both the Dashboard (its counts
/// and sections) and the Deliveries screen (Active / Completed / All tabs) use.
///
/// Both screens are driven by the live `riderDeliveries` stream, so when the
/// server completes an order its status becomes `delivered` and the next
/// snapshot moves it from [active] to [completed] — nothing local marks it
/// done. Keeping the rule in one place means the two screens cannot disagree.
class DeliveryBuckets {
  DeliveryBuckets(List<Delivery> deliveries)
      : all = List.unmodifiable(deliveries),
        active = List.unmodifiable(deliveries.where((d) => d.isActive)),
        completed = List.unmodifiable(deliveries.where((d) => d.isDelivered));

  final List<Delivery> all;

  /// Not delivered and not cancelled.
  final List<Delivery> active;

  /// Delivered (including the legacy `completed` spelling).
  final List<Delivery> completed;

  /// Dashboard stat cards: Deliveries / Completed / Remaining.
  int get total => all.length;
  int get done => completed.length;
  int get remaining => active.length;
}
