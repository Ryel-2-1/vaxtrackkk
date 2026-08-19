import 'dart:math' as math;
import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:vaxtrack_mobile/utils/deviation_utils.dart';
import 'package:vaxtrack_mobile/utils/route_utils.dart';

// Same mean Earth radius the utility uses, so reference distances match tightly
// instead of drifting by ~0.1% against a different radius constant.
const double _r = 6371008.8;
const double _d2r = math.pi / 180.0;

/// Independent reference haversine (metres) for expected values in the tests.
double _refHaversine(LatLng a, LatLng b) {
  final lat1 = a.latitude * _d2r;
  final lat2 = b.latitude * _d2r;
  final dLat = (b.latitude - a.latitude) * _d2r;
  final dLng = (b.longitude - a.longitude) * _d2r;
  final h = math.sin(dLat / 2) * math.sin(dLat / 2) +
      math.cos(lat1) * math.cos(lat2) * math.sin(dLng / 2) * math.sin(dLng / 2);
  return 2 * _r * math.asin(math.min(1.0, math.sqrt(h)));
}

/// Degrees of latitude for a north/south offset of [meters].
double _latDegForMeters(double meters) => meters / (_r * _d2r);

/// Test-only precision-5 polyline ENCODER. This is the *inverse* of the
/// production decoder (`route_utils.decodePolyline`); it does not duplicate the
/// decoder. It only exists to build an encoded string for the integration test.
String _encodePolyline(List<LatLng> pts) {
  final sb = StringBuffer();
  int lastLat = 0, lastLng = 0;
  void enc(int v) {
    int value = v < 0 ? ~(v << 1) : (v << 1);
    while (value >= 0x20) {
      sb.writeCharCode((0x20 | (value & 0x1f)) + 63);
      value >>= 5;
    }
    sb.writeCharCode(value + 63);
  }

  for (final p in pts) {
    final lat = (p.latitude * 1e5).round();
    final lng = (p.longitude * 1e5).round();
    enc(lat - lastLat);
    enc(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
  }
  return sb.toString();
}

void main() {
  // A representative Metro-Manila east-west segment (constant latitude), so a
  // north offset from it is a clean perpendicular distance.
  final segA = LatLng(14.6000, 120.9800);
  final segB = LatLng(14.6000, 120.9900);
  final route = <LatLng>[segA, segB];

  test('point exactly on a segment returns ~0', () {
    final onLine = LatLng(14.6000, 120.9850); // midpoint, on the segment
    expect(distanceToPolylineMeters(onLine, route), lessThan(1.0));
  });

  test('point near the middle returns the perpendicular distance', () {
    final p = LatLng(14.6000 + _latDegForMeters(50), 120.9850); // 50 m north
    expect(distanceToPolylineMeters(p, route), closeTo(50.0, 1.0));
  });

  test('point beyond the start clamps to the start endpoint', () {
    final p = LatLng(14.6000, 120.9700); // due west of segA (line extended)
    expect(distanceToPolylineMeters(p, route),
        closeTo(_refHaversine(p, segA), 1.0));
  });

  test('point beyond the end clamps to the end endpoint', () {
    final p = LatLng(14.6000, 121.0000); // due east of segB
    expect(distanceToPolylineMeters(p, route),
        closeTo(_refHaversine(p, segB), 1.0));
  });

  test('single-point route uses point-to-point distance', () {
    final only = <LatLng>[LatLng(14.6000, 120.9800)];
    final p = LatLng(14.6100, 120.9800);
    expect(distanceToPolylineMeters(p, only),
        closeTo(_refHaversine(p, only.first), 0.5));
  });

  test('empty route returns infinity', () {
    expect(distanceToPolylineMeters(LatLng(14.6, 120.98), const <LatLng>[]),
        equals(double.infinity));
  });

  test('duplicate consecutive route points do not cause NaN or failure', () {
    final dup = <LatLng>[
      LatLng(14.6000, 120.9800),
      LatLng(14.6000, 120.9800), // duplicate -> zero-length segment
      LatLng(14.6000, 120.9900),
    ];
    final p = LatLng(14.6000 + _latDegForMeters(50), 120.9850);
    final d = distanceToPolylineMeters(p, dup);
    expect(d.isNaN, isFalse);
    expect(d.isFinite, isTrue);
    expect(d, closeTo(50.0, 1.0)); // same answer as the clean route
  });

  test('multi-segment route picks the nearest segment', () {
    final multi = <LatLng>[
      LatLng(14.6000, 120.9800),
      LatLng(14.6000, 120.9850), // segment 1 — far from p
      LatLng(14.7000, 121.0500),
      LatLng(14.7000, 121.0600), // segment 2 — next to p
    ];
    final p = LatLng(14.7000 + _latDegForMeters(30), 121.0550);
    expect(distanceToPolylineMeters(p, multi), closeTo(30.0, 1.5));
  });

  test('Manila coordinates produce a realistic known distance', () {
    // Rider ~200 m north of a short east-west route near Ermita, Manila.
    final a = LatLng(14.5995, 120.9840);
    final b = LatLng(14.5995, 120.9860);
    final rider = LatLng(14.5995 + _latDegForMeters(200), 120.9850);
    expect(distanceToPolylineMeters(rider, <LatLng>[a, b]), closeTo(200.0, 2.0));
  });

  test('a decoded precision-5 polyline works with the distance function', () {
    final pts = <LatLng>[
      LatLng(14.5995, 120.9840),
      LatLng(14.5995, 120.9860),
      LatLng(14.6010, 120.9875),
    ];
    final decoded = decodePolyline(_encodePolyline(pts)); // production decoder

    // round-trip sanity: decoder returns the same coords we encoded
    expect(decoded.length, equals(pts.length));
    for (var i = 0; i < pts.length; i++) {
      expect(decoded[i].latitude, closeTo(pts[i].latitude, 1e-5));
      expect(decoded[i].longitude, closeTo(pts[i].longitude, 1e-5));
    }

    // decoded coordinates flow straight into the distance utility
    final rider = LatLng(14.5995 + _latDegForMeters(100), 120.9850);
    final d = distanceToPolylineMeters(rider, decoded);
    expect(d.isFinite, isTrue);
    expect(d, closeTo(100.0, 2.0));
  });

  test('reversing the route-point order produces the same result', () {
    final multi = <LatLng>[
      LatLng(14.6000, 120.9800),
      LatLng(14.6050, 120.9850),
      LatLng(14.6100, 120.9900),
    ];
    final p = LatLng(14.6060, 120.9830);
    final forward = distanceToPolylineMeters(p, multi);
    final reversed = distanceToPolylineMeters(p, multi.reversed.toList());
    expect(reversed, closeTo(forward, 1e-6));
  });
}
