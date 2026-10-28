import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/utils/route_utils.dart';
import 'package:vaxtrack_mobile/models/delivery.dart';

void main() {
  test('route provenance stays separate for single route and trip', () {
    final single = Delivery.fromFirestore('qa', {
      'routeProvider': 'valhalla',
      'routeProfile': 'motorcycle-no-expressways-v1',
    });
    expect(single.isMotorcycleRoute(), isTrue);
    expect(single.isMotorcycleRoute(trip: true), isFalse);
    expect(single.routeDescription(trip: true), contains('unverified'));
    final trip = Delivery.fromFirestore('qa', {
      'routeProvider': 'valhalla',
      'tripRouteProvider': 'valhalla',
      'tripRouteProfile': 'motorcycle-no-expressways-v1',
    });
    expect(trip.isMotorcycleRoute(), isFalse);
    expect(trip.isMotorcycleRoute(trip: true), isTrue);
    expect(trip.routeDescription(trip: true), startsWith('Motorcycle route'));
    expect(Delivery.fromFirestore('qa', {
      'routeProvider': 'openrouteservice',
      'routeProfile': 123,
      'tripRouteProvider': [],
    }).isMotorcycleRoute(), isFalse);
  });

  final fixture =
      jsonDecode(
            File('test/fixtures/motorcycle_routes.json').readAsStringSync(),
          )
          as Map<String, dynamic>;

  for (final raw in fixture['routes'] as List<dynamic>) {
    final route = raw as Map<String, dynamic>;
    test('Rider decodes generated motorcycle ${route['name']}', () {
      final points = decodePolyline(route['polyline'] as String);
      final first = route['first'] as List<dynamic>;
      final last = route['last'] as List<dynamic>;
      expect(points.length, route['pointCount']);
      expect(points.first.latitude, first[0]);
      expect(points.first.longitude, first[1]);
      expect(points.last.latitude, last[0]);
      expect(points.last.longitude, last[1]);

      // Real public-coordinate fixtures near Biñan/Santa Rosa. A precision-6
      // shape saved without conversion would fail these geographic bounds.
      expect(
        points.every(
          (p) =>
              p.latitude > 14 &&
              p.latitude < 15 &&
              p.longitude > 121 &&
              p.longitude < 122,
        ),
        isTrue,
      );
    });
  }
}
