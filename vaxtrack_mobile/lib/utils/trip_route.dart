import '../models/delivery.dart';
import 'google_maps_url.dart';

/// Multi-stop trip helpers for the Rider app.
///
/// The dispatcher optimizes a rider's stops on the web and writes each order's
/// place in the tour (`stopSequence`) plus the whole-trip route. The rider app
/// only READS those fields; these pure helpers turn them into an ordered stop
/// list and a Google Maps directions link, with no Firebase or Flutter imports
/// so they can be unit-tested directly.

/// The rider's trip stops in visiting order.
///
/// Only orders that are part of an optimized trip AND carry clinic coordinates
/// are included — a stop with no coordinates cannot be a map waypoint. Sorted by
/// `stopSequence` (the optimized order); ties keep their input order.
List<Delivery> orderedTripStops(List<Delivery> deliveries) {
  final stops =
      deliveries.where((d) => d.isOnTrip && d.hasClinicCoords).toList();
  stops.sort((a, b) => (a.stopSequence ?? 0).compareTo(b.stopSequence ?? 0));
  return stops;
}

/// A Google Maps directions URL that routes through every stop in [stops] in the
/// given order: the device's current location is the origin (omitted, so Maps
/// uses it), the last stop is the destination, and the rest are waypoints in
/// order. Motorcycle (two-wheeler) mode, opened into navigation — see
/// [googleMapsDirectionsUrl]. Returns null when there are no stops.
///
/// This gives real turn-by-turn through the whole optimized trip without the
/// gated Navigation SDK. Google Maps' universal URL caps the waypoint count;
/// typical rider loads are within it.
Uri? googleMapsMultiStopUrl(List<Delivery> stops) {
  if (stops.isEmpty) return null;
  // Callers pass [orderedTripStops] output, which guarantees coordinates.
  String coord(Delivery d) => '${d.clinicLat},${d.clinicLng}';
  return googleMapsDirectionsUrl(
    destination: coord(stops.last),
    waypoints: stops.sublist(0, stops.length - 1).map(coord).toList(),
  );
}

/// Google Maps' Android app takes the destination plus at most 9 waypoints.
const int kGoogleMapsMaxStops = 10;

/// The stops to hand to Google Maps when the rider taps Start navigation on
/// [current]: THIS stop first, then the trip's other unfinished stops in the
/// planned visiting order (`stopSequence`). Stops planned before [current]
/// that are still unfinished come last — they still have to be delivered.
///
/// Only stops of the SAME trip (`tripId`) with a pin count; delivered,
/// cancelled and failed stops are left out. An order that is not on a trip,
/// or has no pin, is navigated alone — exactly as before.
///
/// [truncated] is true when the trip has more stops than Google Maps accepts;
/// [stops] then holds the first [kGoogleMapsMaxStops] of them.
({List<Delivery> stops, bool truncated}) remainingTripFrom(
  Delivery current,
  List<Delivery> deliveries,
) {
  if (!current.isOnTrip || !current.hasClinicCoords) {
    return (stops: [current], truncated: false);
  }
  bool unfinished(Delivery d) =>
      !d.isDelivered && !d.isCancelled && !d.isDeliveryFailed;
  // The freshest copy of each order; [current] stands in if the list lacks it.
  final byId = {for (final d in deliveries) d.id: d};
  byId.putIfAbsent(current.id, () => current);
  final trip = orderedTripStops(
    byId.values
        .where((d) => d.tripId == current.tripId && (d.id == current.id || unfinished(d)))
        .toList(),
  );
  final at = trip.indexWhere((d) => d.id == current.id);
  final rotated = at < 0 ? [current] : [...trip.sublist(at), ...trip.sublist(0, at)];
  final truncated = rotated.length > kGoogleMapsMaxStops;
  return (
    stops: truncated ? rotated.sublist(0, kGoogleMapsMaxStops) : rotated,
    truncated: truncated,
  );
}
