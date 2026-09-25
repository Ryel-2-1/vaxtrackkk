import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/models/delivery.dart';
import 'package:vaxtrack_mobile/utils/trip_route.dart';

/// Pure multi-stop trip helpers: ordering the rider's stops by the dispatcher's
/// optimized sequence, and turning them into a Google Maps directions link.

Delivery _order({
  required String id,
  int? seq,
  double? lat,
  double? lng,
  String? tripId = 'trip1',
}) {
  return Delivery(
    id: id,
    orderNumber: id,
    clinicName: 'Clinic $id',
    clinicAddress: '',
    vaccineName: 'V',
    quantity: 1,
    unit: 'vials',
    priority: 'Standard',
    status: 'in_transit',
    statusLabel: 'In Transit',
    clinicLat: lat,
    clinicLng: lng,
    tripId: seq == null ? null : tripId,
    stopSequence: seq,
    tripStopCount: 3,
  );
}

void main() {
  group('orderedTripStops', () {
    test('returns trip stops sorted by visiting order', () {
      final list = [
        _order(id: 'c', seq: 3, lat: 14.60, lng: 121.03),
        _order(id: 'a', seq: 1, lat: 14.55, lng: 121.01),
        _order(id: 'b', seq: 2, lat: 14.58, lng: 121.02),
      ];
      expect(orderedTripStops(list).map((d) => d.id).toList(), ['a', 'b', 'c']);
    });

    test('excludes orders that are not on a trip or have no coordinates', () {
      final list = [
        _order(id: 'a', seq: 1, lat: 14.55, lng: 121.01),
        _order(id: 'noseq', seq: null, lat: 14.5, lng: 121.0), // not on a trip
        _order(id: 'nocoords', seq: 2), // on a trip but no coords
        _order(id: 'b', seq: 3, lat: 14.58, lng: 121.02),
      ];
      expect(orderedTripStops(list).map((d) => d.id).toList(), ['a', 'b']);
    });

    test('is empty when nothing is on a trip', () {
      final list = [_order(id: 'x', seq: null, lat: 14.5, lng: 121.0)];
      expect(orderedTripStops(list), isEmpty);
    });
  });

  group('googleMapsMultiStopUrl', () {
    test('routes through waypoints in order with the last stop as destination', () {
      final stops = [
        _order(id: 'a', seq: 1, lat: 14.55, lng: 121.01),
        _order(id: 'b', seq: 2, lat: 14.58, lng: 121.02),
        _order(id: 'c', seq: 3, lat: 14.60, lng: 121.03),
      ];
      final uri = googleMapsMultiStopUrl(stops)!;
      expect(uri.host, 'www.google.com');
      expect(uri.path, '/maps/dir/');
      expect(uri.queryParameters['travelmode'], 'driving');
      expect(uri.queryParameters['destination'], '14.6,121.03');
      // Earlier stops are waypoints, in order; the final stop is NOT a waypoint.
      expect(uri.queryParameters['waypoints'], '14.55,121.01|14.58,121.02');
    });

    test('a single stop has no waypoints, just the destination', () {
      final uri = googleMapsMultiStopUrl([
        _order(id: 'a', seq: 1, lat: 14.55, lng: 121.01),
      ])!;
      expect(uri.queryParameters['destination'], '14.55,121.01');
      expect(uri.queryParameters.containsKey('waypoints'), isFalse);
    });

    test('returns null for no stops', () {
      expect(googleMapsMultiStopUrl(const []), isNull);
    });
  });
}
