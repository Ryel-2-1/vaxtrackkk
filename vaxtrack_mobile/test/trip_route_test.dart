import 'dart:io';

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
      // Riders ride motorcycles: Google's two-wheeler mode, opened to navigate.
      expect(uri.queryParameters['travelmode'], 'two-wheeler');
      expect(uri.queryParameters['dir_action'], 'navigate');
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

  // The field bug (Android): Start navigation on a multi-stop trip opened
  // Google Maps with ONE destination. It must open this stop, then the rest of
  // the trip in the planned order.
  group('remainingTripFrom (Start navigation on a trip)', () {
    Delivery stop(String id, int seq, {String status = 'in_transit', String trip = 'trip1'}) => Delivery(
          id: id,
          orderNumber: id,
          clinicName: 'Clinic $id',
          clinicAddress: '',
          vaccineName: 'V',
          quantity: 1,
          unit: 'vials',
          priority: 'Standard',
          status: status,
          statusLabel: status,
          clinicLat: 14.5 + seq / 100,
          clinicLng: 121.0 + seq / 100,
          tripId: trip,
          stopSequence: seq,
          tripStopCount: 4,
        );

    test('from the first stop: every stop, in the planned order', () {
      final all = [stop('c', 3), stop('a', 1), stop('b', 2)];
      final r = remainingTripFrom(all[1], all);
      expect(r.stops.map((d) => d.id), ['a', 'b', 'c']);
      expect(r.truncated, isFalse);
      final uri = googleMapsMultiStopUrl(r.stops)!;
      expect(uri.queryParameters['destination'], '14.53,121.03');
      expect(uri.queryParameters['waypoints'], '14.51,121.01|14.52,121.02');
      expect(uri.queryParameters['travelmode'], 'two-wheeler');
    });

    test('delivered, cancelled and failed stops are skipped; earlier unfinished stops come last', () {
      final all = [
        stop('a', 1, status: 'delivered'),
        stop('b', 2),
        stop('c', 3, status: 'cancelled'),
        stop('d', 4, status: 'delivery_failed'),
        stop('e', 5),
        stop('f', 6),
      ];
      expect(remainingTripFrom(all[4], all).stops.map((d) => d.id), ['e', 'f', 'b']);
    });

    test('only stops of the same trip; an order off any trip is navigated alone', () {
      final all = [stop('a', 1), stop('x', 2, trip: 'other'), stop('b', 3)];
      expect(remainingTripFrom(all[0], all).stops.map((d) => d.id), ['a', 'b']);
      final loose = _order(id: 'z', lat: 14.6, lng: 121.0);
      expect(remainingTripFrom(loose, [loose, ...all]).stops.map((d) => d.id), ['z']);
    });

    test('the current stop is kept even if the list does not have it yet', () {
      final current = stop('a', 1);
      expect(remainingTripFrom(current, [stop('b', 2)]).stops.map((d) => d.id), ['a', 'b']);
    });

    test('more stops than Google Maps accepts: the next 10, marked truncated', () {
      final all = List.generate(12, (i) => stop('s$i', i + 1));
      final r = remainingTripFrom(all[0], all);
      expect(r.stops.length, kGoogleMapsMaxStops);
      expect(r.truncated, isTrue);
      expect(googleMapsMultiStopUrl(r.stops)!.queryParameters['waypoints']!.split('|').length, 9);
    });
  });

  test('Start navigation on the delivery screen opens the remaining trip, falling back to one stop', () {
    final screen = File('lib/screens/delivery_detail_screen.dart').readAsStringSync().replaceAll('\r\n', '\n');
    expect(screen, contains('final trip = d.isOnTrip && d.hasClinicCoords ? await _remainingTrip() : null;'));
    expect(screen, contains('uri = googleMapsMultiStopUrl(trip.stops)!;'));
    expect(screen, contains('return remainingTripFrom(d, deliveries);'));
    expect(screen, contains('.timeout(const Duration(seconds: 5));'));
  });
}
