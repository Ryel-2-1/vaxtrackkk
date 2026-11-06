import 'dart:math' as math;

import 'package:latlong2/latlong.dart';

/// Where the rider is along the saved plan, for drawing only: the part already
/// ridden (grey) and the part still ahead (green), split at the point of the
/// plan nearest the rider. The server alone decides on/off route; this never
/// feeds that decision.
class RouteSplit {
  const RouteSplit({required this.ridden, required this.ahead, required this.segment, required this.offRouteMeters});

  /// The plan from its start to the rider's point on it (empty when the rider
  /// is at the start, or not placed).
  final List<LatLng> ridden;

  /// From the rider's point on the plan to its end (the whole plan when the
  /// rider is not placed).
  final List<LatLng> ahead;

  /// Index of the plan segment the rider was placed on (−1: not placed). Pass
  /// it back as [hintSegment] so progress does not jump to an earlier pass of
  /// a road the trip uses twice.
  final int segment;

  /// Metres from the rider to that point (infinity: not placed).
  final double offRouteMeters;

  static RouteSplit unplaced(List<LatLng> points) =>
      RouteSplit(ridden: const [], ahead: points, segment: -1, offRouteMeters: double.infinity);
}

const double _mPerDegLat = 111320.0;

/// Split [points] at the point nearest [rider].
///
/// With [hintSegment] (the previous split), segments from there on are tried
/// first and kept when the rider is within [stickyMeters] of them, so a trip
/// that rides the same road out and back keeps its progress instead of
/// snapping back to the outbound pass. Otherwise the nearest segment wins.
RouteSplit splitRouteAt(List<LatLng> points, LatLng? rider, {int hintSegment = -1, double stickyMeters = 60}) {
  if (rider == null || points.length < 2) return RouteSplit.unplaced(points);
  final mPerDegLng = _mPerDegLat * math.cos(rider.latitude * math.pi / 180);
  double x(LatLng p) => (p.longitude - rider.longitude) * mPerDegLng;
  double y(LatLng p) => (p.latitude - rider.latitude) * _mPerDegLat;

  ({int i, double t, double d}) best(int from) {
    var bi = -1;
    var bt = 0.0;
    var bd = double.infinity;
    for (var i = math.max(0, from); i < points.length - 1; i++) {
      final ax = x(points[i]), ay = y(points[i]);
      final bx = x(points[i + 1]), by = y(points[i + 1]);
      final dx = bx - ax, dy = by - ay;
      final len2 = dx * dx + dy * dy;
      final t = len2 == 0 ? 0.0 : ((-ax * dx - ay * dy) / len2).clamp(0.0, 1.0);
      final px = ax + t * dx, py = ay + t * dy;
      final d = math.sqrt(px * px + py * py);
      if (d < bd) {
        bd = d;
        bi = i;
        bt = t;
      }
    }
    return (i: bi, t: bt, d: bd);
  }

  var hit = hintSegment >= 0 ? best(hintSegment) : (i: -1, t: 0.0, d: double.infinity);
  if (hit.i < 0 || hit.d > stickyMeters) {
    final global = best(0);
    if (global.d < hit.d) hit = global;
  }
  if (hit.i < 0) return RouteSplit.unplaced(points);

  final a = points[hit.i];
  final b = points[hit.i + 1];
  final at = LatLng(a.latitude + (b.latitude - a.latitude) * hit.t, a.longitude + (b.longitude - a.longitude) * hit.t);
  return RouteSplit(
    ridden: [...points.sublist(0, hit.i + 1), at],
    ahead: [at, ...points.sublist(hit.i + 1)],
    segment: hit.i,
    offRouteMeters: hit.d,
  );
}

/// Great-circle metres between two points.
double straightLineMeters(LatLng a, LatLng b) => const Distance().as(LengthUnit.Meter, a, b);

/// "350 m" / "1.2 km" / "12 km".
String shortDistance(double meters) {
  if (meters < 1000) return '${(meters / 10).round() * 10} m';
  final km = meters / 1000;
  return km < 10 ? '${km.toStringAsFixed(1)} km' : '${km.round()} km';
}
