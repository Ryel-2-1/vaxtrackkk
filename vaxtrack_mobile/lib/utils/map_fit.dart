import 'package:latlong2/latlong.dart';

/// Pure, Flutter-free camera-fit resolution for the delivery maps.
///
/// Extracted from the map widgets because the previous inline logic guarded the
/// camera fit by point COUNT (`pts.length < 2`) rather than by geographic
/// EXTENT. With no dispatcher-generated route the point set is exactly
/// `[rider, clinic]`, so two *identical* coordinates passed that guard,
/// `LatLngBounds.fromPoints` produced a zero-area bounds, and the fit
/// computation divided by that zero span to reach an infinite zoom — which
/// flutter_map converts with `.toInt()`, throwing
/// `Unsupported operation: Infinity or NaN toInt` and replacing the whole map
/// with an error widget.
///
/// That case is not exotic: rider and destination coincide exactly when the
/// rider ARRIVES, which is when the screen matters most.
///
/// This resolver decides by extent instead, and is unit-tested directly against
/// empty, single-point, identical-point and multi-point inputs.

/// What the camera should do for a given set of points.
enum MapFitKind {
  /// No usable points — the caller keeps whatever fallback camera it set.
  none,

  /// A single point, or a cluster too tight to have usable extent — center on
  /// it at a fixed, capped zoom rather than fitting a degenerate bounds.
  center,

  /// Two or more points with real extent — fit their bounds.
  bounds,
}

/// A pure description of the camera move a point set warrants.
class MapFit {
  const MapFit(
    this.kind, {
    this.center,
    this.zoom,
    this.boundsPoints = const <LatLng>[],
  });

  final MapFitKind kind;

  /// Set only when [kind] is [MapFitKind.center].
  final LatLng? center;

  /// Set only when [kind] is [MapFitKind.center]. Always <= the `maxZoom` used.
  final double? zoom;

  /// Set only when [kind] is [MapFitKind.bounds]. Contains the usable points
  /// (non-finite / out-of-range coordinates already removed).
  final List<LatLng> boundsPoints;
}

/// Zoom used when the point set collapses to a single location.
const double kSinglePointZoom = 16;

/// Hard ceiling applied to any zoom this resolver reports, and the value the
/// widgets pass to `CameraFit.bounds` — the "cap the calculated zoom" guard.
const double kMaxFitZoom = 18;

/// Below this span in BOTH axes the points are treated as one location.
/// 1e-5 degrees is roughly 1.1 m — comfortably "the same place" for a delivery
/// map, and far above the floating-point noise that produced infinite zoom.
const double kMinSpanDegrees = 1e-5;

bool _isUsable(LatLng p) =>
    p.latitude.isFinite &&
    p.longitude.isFinite &&
    p.latitude.abs() <= 90 &&
    p.longitude.abs() <= 180;

/// Resolve the camera action for [points].
///
/// Never throws, and never returns a degenerate bounds: a set whose extent is
/// below [minSpanDegrees] in both axes resolves to [MapFitKind.center].
MapFit resolveMapFit(
  Iterable<LatLng> points, {
  double singlePointZoom = kSinglePointZoom,
  double maxZoom = kMaxFitZoom,
  double minSpanDegrees = kMinSpanDegrees,
}) {
  final usable = points.where(_isUsable).toList(growable: false);
  if (usable.isEmpty) return const MapFit(MapFitKind.none);

  var minLat = usable.first.latitude;
  var maxLat = minLat;
  var minLng = usable.first.longitude;
  var maxLng = minLng;
  for (final p in usable) {
    if (p.latitude < minLat) minLat = p.latitude;
    if (p.latitude > maxLat) maxLat = p.latitude;
    if (p.longitude < minLng) minLng = p.longitude;
    if (p.longitude > maxLng) maxLng = p.longitude;
  }

  final latSpan = maxLat - minLat;
  final lngSpan = maxLng - minLng;

  if (usable.length == 1 ||
      (latSpan < minSpanDegrees && lngSpan < minSpanDegrees)) {
    return MapFit(
      MapFitKind.center,
      center: LatLng((minLat + maxLat) / 2, (minLng + maxLng) / 2),
      zoom: singlePointZoom.clamp(0.0, maxZoom).toDouble(),
    );
  }

  return MapFit(MapFitKind.bounds, boundsPoints: usable);
}
