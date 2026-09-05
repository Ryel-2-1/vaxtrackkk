import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:vaxtrack_mobile/utils/map_fit.dart';

/// Regression cover for the "Infinity or NaN toInt" map crash.
///
/// The old guard was `pts.length < 2`, a COUNT check. Two identical points
/// passed it, produced a zero-area bounds, and the fit computation divided by
/// that zero span to reach an infinite zoom. These tests pin the extent-based
/// behaviour that replaced it.
void main() {
  group('resolveMapFit — empty input', () {
    test('no points resolves to none, so the caller keeps its fallback', () {
      final fit = resolveMapFit(const <LatLng>[]);
      expect(fit.kind, MapFitKind.none);
      expect(fit.center, isNull);
      expect(fit.boundsPoints, isEmpty);
    });

    test('only unusable points resolves to none, never a bounds', () {
      final fit = resolveMapFit([
        LatLng(double.nan, double.nan),
        LatLng(double.infinity, 120.98),
      ]);
      expect(fit.kind, MapFitKind.none);
    });
  });

  group('resolveMapFit — single point', () {
    test('one destination centers on it rather than fitting bounds', () {
      final fit = resolveMapFit([const LatLng(14.5995, 120.9842)]);
      expect(fit.kind, MapFitKind.center);
      expect(fit.center!.latitude, closeTo(14.5995, 1e-9));
      expect(fit.center!.longitude, closeTo(120.9842, 1e-9));
      expect(fit.boundsPoints, isEmpty);
    });

    test('one route point behaves the same as one marker', () {
      final fit = resolveMapFit([const LatLng(14.61, 121.02)]);
      expect(fit.kind, MapFitKind.center);
    });

    test('reported zoom is capped', () {
      final fit = resolveMapFit(
        [const LatLng(14.5995, 120.9842)],
        singlePointZoom: 99,
        maxZoom: 18,
      );
      expect(fit.zoom, lessThanOrEqualTo(18));
    });
  });

  group('resolveMapFit — identical / near-identical points', () {
    test('rider exactly on the destination centers, never bounds', () {
      // The reproduced arrival case: Dispatcher read "rider is 0 m from the
      // destination" at the moment the Rider map failed.
      const same = LatLng(14.5995, 120.9842);
      final fit = resolveMapFit(const [same, same]);
      expect(fit.kind, MapFitKind.center);
      expect(fit.center!.latitude, closeTo(14.5995, 1e-9));
    });

    test('sub-metre separation still centers', () {
      final fit = resolveMapFit(const [
        LatLng(14.599500, 120.984200),
        LatLng(14.599502, 120.984201),
      ]);
      expect(fit.kind, MapFitKind.center);
    });

    test('many coincident route points still center', () {
      const p = LatLng(14.5995, 120.9842);
      final fit = resolveMapFit(const [p, p, p, p, p]);
      expect(fit.kind, MapFitKind.center);
    });
  });

  group('resolveMapFit — normal multi-point input', () {
    test('rider and a distinct destination fit bounds as before', () {
      final fit = resolveMapFit(const [
        LatLng(14.5995, 120.9842),
        LatLng(14.6510, 121.0490),
      ]);
      expect(fit.kind, MapFitKind.bounds);
      expect(fit.boundsPoints, hasLength(2));
      expect(fit.center, isNull);
    });

    test('a full route keeps every usable point', () {
      final fit = resolveMapFit(const [
        LatLng(14.5995, 120.9842),
        LatLng(14.6100, 121.0000),
        LatLng(14.6200, 121.0200),
        LatLng(14.6510, 121.0490),
      ]);
      expect(fit.kind, MapFitKind.bounds);
      expect(fit.boundsPoints, hasLength(4));
    });

    test('unusable points are dropped but valid extent still fits bounds', () {
      final fit = resolveMapFit([
        const LatLng(14.5995, 120.9842),
        LatLng(double.nan, 121.0),
        const LatLng(14.6510, 121.0490),
      ]);
      expect(fit.kind, MapFitKind.bounds);
      expect(fit.boundsPoints, hasLength(2));
    });

    test('one valid point among unusable ones centers', () {
      final fit = resolveMapFit([
        LatLng(double.infinity, double.infinity),
        const LatLng(14.5995, 120.9842),
      ]);
      expect(fit.kind, MapFitKind.center);
    });
  });
}
