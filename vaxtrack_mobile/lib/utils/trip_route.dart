import '../models/delivery.dart';

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
/// order. Returns null when there are no stops.
///
/// This gives real turn-by-turn through the whole optimized trip without the
/// gated Navigation SDK. Google Maps' universal URL caps the waypoint count;
/// typical rider loads are within it.
Uri? googleMapsMultiStopUrl(List<Delivery> stops) {
  if (stops.isEmpty) return null;
  String coord(Delivery d) => '${d.clinicLat},${d.clinicLng}';
  final destination = coord(stops.last);
  final params = <String, String>{
    'api': '1',
    'travelmode': 'driving',
    'destination': destination,
  };
  if (stops.length > 1) {
    params['waypoints'] =
        stops.sublist(0, stops.length - 1).map(coord).join('|');
  }
  return Uri.https('www.google.com', '/maps/dir/', params);
}
