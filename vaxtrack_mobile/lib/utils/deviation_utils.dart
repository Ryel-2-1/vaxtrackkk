import 'dart:math' as math;
import 'package:latlong2/latlong.dart';

/// Pure-Dart geometry for route-deviation detection (Phase 1).
///
/// Depends ONLY on `dart:math` and the `LatLng` value type (already a project
/// dependency, and the type produced by `decodePolyline` in `route_utils.dart`).
/// No Geolocator, Firebase, Flutter platform channels, or additional packages.
/// All distances are returned in METRES.
///
/// Geometry: an OpenRouteService driving route is a chain of short, city-scale
/// segments. We project every coordinate into a *local equirectangular frame*
/// centred on the rider [point]: metres north = Δlat · (R·π/180), metres east =
/// Δlng · (R·π/180) · cos(latitude) — i.e. east/west metres shrink toward the
/// poles. The rider becomes the origin, so each segment collapses to a plain
/// 2-D point-to-segment problem. Using ONE reference latitude for the whole
/// polyline makes the answer independent of segment/route direction. At
/// Metro-Manila scale the equirectangular error over a single segment is
/// sub-metre — well below the deviation thresholds this feeds.
const double _earthRadiusM = 6371008.8; // IUGG mean Earth radius
const double _degToRad = math.pi / 180.0;

/// Metres per degree of latitude (constant everywhere); longitude scales by
/// cos(latitude) at the reference point.
const double _metersPerDegLat = _earthRadiusM * _degToRad; // ≈ 111195 m

/// Shortest distance in metres from [point] to the polyline [routePoints],
/// measured to the nearest *segment* — the perpendicular projection clamped to
/// each segment's endpoints — not merely to the nearest vertex.
///
/// Contract:
/// * empty route            -> [double.infinity]
/// * single-point route     -> great-circle distance to that one point
/// * duplicate/zero-length segments are handled (treated as their endpoint)
/// * never returns NaN; result is always >= 0 for a non-empty route
double distanceToPolylineMeters(LatLng point, List<LatLng> routePoints) {
  if (routePoints.isEmpty) return double.infinity;
  if (routePoints.length == 1) {
    return _haversineMeters(point, routePoints.first);
  }

  // Single local frame centred on the rider -> direction/endpoint-order
  // independent, and the rider sits at the origin (0, 0).
  final double mPerDegLng =
      _metersPerDegLat * math.cos(point.latitude * _degToRad);

  double x(LatLng c) =>
      _normalizeLngDeg(c.longitude - point.longitude) * mPerDegLng;
  double y(LatLng c) => (c.latitude - point.latitude) * _metersPerDegLat;

  double best = double.infinity;
  double ax = x(routePoints.first);
  double ay = y(routePoints.first);
  for (int i = 1; i < routePoints.length; i++) {
    final double bx = x(routePoints[i]);
    final double by = y(routePoints[i]);
    final double d = _originToSegment(ax, ay, bx, by);
    if (d < best) best = d;
    ax = bx;
    ay = by;
  }
  return best;
}

/// Distance from the origin (0,0) to the segment a->b, all coordinates already
/// in local metres.
double _originToSegment(double ax, double ay, double bx, double by) {
  final double dx = bx - ax;
  final double dy = by - ay;
  final double segLenSq = dx * dx + dy * dy;

  // Zero-length segment (duplicate consecutive route points): fall back to the
  // shared endpoint. Also guards the division below against NaN.
  if (segLenSq == 0.0) {
    return math.sqrt(ax * ax + ay * ay);
  }

  // Parameter t of the perpendicular foot from the origin onto the segment.
  // Clamping to [0,1] means a rider "before" a or "past" b measures to that
  // endpoint rather than to the infinite line.
  double t = -(ax * dx + ay * dy) / segLenSq;
  if (t < 0.0) {
    t = 0.0;
  } else if (t > 1.0) {
    t = 1.0;
  }

  final double px = ax + t * dx;
  final double py = ay + t * dy;
  return math.sqrt(px * px + py * py);
}

/// Great-circle (haversine) distance in metres. Used for a single-point route.
/// `asin(min(1, ...))` avoids a NaN when floating-point rounding pushes the
/// argument fractionally above 1.
double _haversineMeters(LatLng a, LatLng b) {
  final double lat1 = a.latitude * _degToRad;
  final double lat2 = b.latitude * _degToRad;
  final double dLat = (b.latitude - a.latitude) * _degToRad;
  final double dLng = _normalizeLngDeg(b.longitude - a.longitude) * _degToRad;
  final double h = math.sin(dLat / 2) * math.sin(dLat / 2) +
      math.cos(lat1) * math.cos(lat2) * math.sin(dLng / 2) * math.sin(dLng / 2);
  return 2 * _earthRadiusM * math.asin(math.min(1.0, math.sqrt(h)));
}

/// Normalise a longitude *difference* into (-180, 180] so a pair straddling the
/// antimeridian (e.g. +179 and -179) is measured the short way around.
double _normalizeLngDeg(double deltaDeg) {
  double d = deltaDeg;
  while (d > 180.0) {
    d -= 360.0;
  }
  while (d < -180.0) {
    d += 360.0;
  }
  return d;
}
