import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:vaxtrack_mobile/utils/route_progress.dart';

const _mPerDegLat = 111320.0;
LatLng north(double m, {double east = 0}) => LatLng(14.3 + m / _mPerDegLat, 121.0 + east / (_mPerDegLat * 0.969));

void main() {
  // A straight 1 km road north, in 100 m steps.
  final road = [for (var i = 0; i <= 10; i++) north(i * 100.0)];

  test('splits the plan at the point nearest the rider: ridden behind, ahead in front', () {
    final s = splitRouteAt(road, north(350, east: 20));
    expect(s.segment, 3);
    expect(s.offRouteMeters, closeTo(20, 1));
    expect(s.ridden.first, road.first);
    expect(s.ahead.last, road.last);
    expect(s.ridden.last, s.ahead.first, reason: 'the two parts meet at the rider\'s point');
    expect(s.ridden.last.latitude, closeTo(north(350).latitude, 1e-6));
  });

  test('not placed (no rider or no line): the whole plan is ahead', () {
    expect(splitRouteAt(road, null).ahead, road);
    expect(splitRouteAt(road, null).ridden, isEmpty);
    expect(splitRouteAt([road.first], north(10)).segment, -1);
  });

  test('a road ridden out and back keeps its progress instead of snapping back', () {
    final outAndBack = [...road, ...road.reversed.skip(1)];
    // Riding back at 300 m: the inbound pass (segments 10+) is the right one.
    final back = splitRouteAt(outAndBack, north(300), hintSegment: 15);
    expect(back.segment, greaterThanOrEqualTo(10));
    // With no hint the nearest (outbound) pass is used.
    expect(splitRouteAt(outAndBack, north(300)).segment, lessThan(10));
  });

  test('distances read naturally', () {
    expect(shortDistance(347), '350 m');
    expect(shortDistance(1240), '1.2 km');
    expect(shortDistance(12400), '12 km');
    // The helper's flat 111.32 km/degree is ~0.6% long at 14°N.
    expect(straightLineMeters(north(0), north(1000)), closeTo(1000, 10));
  });
}
