import 'dart:math' as math;
import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:vaxtrack_mobile/utils/deviation_detector.dart';

// A horizontal route (constant latitude) so a north offset is a clean
// perpendicular distance from the route, letting us build samples at precise
// distances to drive the state machine deterministically.
const double _r = 6371008.8;
const double _d2r = math.pi / 180.0;
final List<LatLng> _route = <LatLng>[
  LatLng(14.6000, 120.9800),
  LatLng(14.6000, 120.9900),
];

// A point [meters] north of the route midpoint (distance ≈ meters).
LatLng _north(double meters) =>
    LatLng(14.6000 + meters / (_r * _d2r), 120.9850);

// Convenience samples, well clear of the thresholds.
LatLng get _offRoute => _north(200); // > 150
LatLng get _recovery => _north(50); //  < 100
LatLng get _band => _north(125); //     100..150
LatLng get _onRoute => _north(30); //   < 100

DeviationDetector _detector() => DeviationDetector()..updateRoute(_route);

// Drive the detector to a confirmed deviated state (3 off-route samples).
DeviationDetector _deviated() {
  final d = _detector();
  d.addSample(_offRoute);
  d.addSample(_offRoute);
  d.addSample(_offRoute);
  return d;
}

void main() {
  test('initial state is onRoute with zeroed diagnostics', () {
    final d = _detector();
    expect(d.state, DeviationState.onRoute);
    expect(d.isDeviated, isFalse);
    expect(d.consecutiveOffRoute, 0);
    expect(d.consecutiveRecovery, 0);
    expect(d.deviationEventCount, 0);
    expect(d.returnedToRouteEventCount, 0);
  });

  test('one/two off-route samples do NOT confirm deviation', () {
    final d = _detector();
    expect(d.addSample(_offRoute), isNull);
    expect(d.consecutiveOffRoute, 1);
    expect(d.addSample(_offRoute), isNull);
    expect(d.consecutiveOffRoute, 2);
    expect(d.state, DeviationState.onRoute);
    expect(d.deviationEventCount, 0);
  });

  test(
    'third consecutive off-route sample confirms deviation exactly once',
    () {
      final d = _detector();
      expect(d.addSample(_offRoute), isNull);
      expect(d.addSample(_offRoute), isNull);
      expect(d.addSample(_offRoute), DeviationEvent.deviated);
      expect(d.state, DeviationState.deviated);
      expect(d.deviationEventCount, 1);
      // latest distance reflects the raw measurement (~200 m).
      expect(d.latestDistanceMeters, closeTo(200, 3));
    },
  );

  test('an on-route sample resets a pending off-route sequence', () {
    final d = _detector();
    d.addSample(_offRoute);
    d.addSample(_offRoute); // streak 2
    expect(d.addSample(_onRoute), isNull); // resets
    expect(d.consecutiveOffRoute, 0);
    expect(d.state, DeviationState.onRoute);
    // Now a single off-route only starts a fresh streak of 1.
    d.addSample(_offRoute);
    expect(d.consecutiveOffRoute, 1);
    expect(d.state, DeviationState.onRoute);
  });

  test('hysteresis band never triggers either transition', () {
    // onRoute: band samples do not accumulate deviation.
    final d = _detector();
    d.addSample(_band);
    d.addSample(_band);
    d.addSample(_band);
    expect(d.state, DeviationState.onRoute);
    expect(d.consecutiveOffRoute, 0);
    expect(d.deviationEventCount, 0);

    // deviated: band samples do not accumulate recovery.
    final dev = _deviated();
    dev.addSample(_band);
    dev.addSample(_band);
    dev.addSample(_band);
    expect(dev.state, DeviationState.deviated);
    expect(dev.consecutiveRecovery, 0);
    expect(dev.returnedToRouteEventCount, 0);
  });

  test('one/two recovery samples do NOT confirm return', () {
    final d = _deviated();
    expect(d.addSample(_recovery), isNull);
    expect(d.consecutiveRecovery, 1);
    expect(d.addSample(_recovery), isNull);
    expect(d.consecutiveRecovery, 2);
    expect(d.state, DeviationState.deviated);
    expect(d.returnedToRouteEventCount, 0);
  });

  test('third recovery sample confirms return exactly once', () {
    final d = _deviated();
    expect(d.addSample(_recovery), isNull);
    expect(d.addSample(_recovery), isNull);
    expect(d.addSample(_recovery), DeviationEvent.returnedToRoute);
    expect(d.state, DeviationState.onRoute);
    expect(d.returnedToRouteEventCount, 1);
  });

  test('an off-route sample resets a pending recovery sequence', () {
    final d = _deviated();
    d.addSample(_recovery);
    d.addSample(_recovery); // streak 2
    expect(d.addSample(_offRoute), isNull); // resets recovery
    expect(d.consecutiveRecovery, 0);
    expect(d.state, DeviationState.deviated);
  });

  test(
    'poor-accuracy sample is ignored (no state/counter/distance change)',
    () {
      final d = _detector();
      // 200 m off-route but accuracy 60 m (> 50) -> ignored.
      expect(d.addSample(_offRoute, accuracyMeters: 60), isNull);
      expect(d.consecutiveOffRoute, 0);
      expect(d.state, DeviationState.onRoute);
      expect(d.latestDistanceMeters, isNull);
      // A good-accuracy off-route sample still counts.
      d.addSample(_offRoute, accuracyMeters: 10);
      expect(d.consecutiveOffRoute, 1);
    },
  );

  test('missing / insufficient route ignores samples safely', () {
    final noRoute = DeviationDetector(); // never given a route
    expect(noRoute.addSample(_offRoute), isNull);
    expect(noRoute.consecutiveOffRoute, 0);
    expect(noRoute.state, DeviationState.onRoute);
    expect(noRoute.latestDistanceMeters, isNull);

    final onePoint = DeviationDetector()
      ..updateRoute(<LatLng>[LatLng(14.60, 120.98)]);
    expect(onePoint.addSample(_offRoute), isNull);
    expect(onePoint.consecutiveOffRoute, 0);
  });

  test('duplicate deviation events are suppressed while deviated', () {
    final d = _deviated();
    expect(d.deviationEventCount, 1);
    // More off-route samples while already deviated must not re-fire.
    expect(d.addSample(_offRoute), isNull);
    expect(d.addSample(_offRoute), isNull);
    expect(d.addSample(_offRoute), isNull);
    expect(d.deviationEventCount, 1);
    expect(d.state, DeviationState.deviated);
  });

  test('duplicate return events are suppressed while on-route', () {
    final d = _deviated();
    d.addSample(_recovery);
    d.addSample(_recovery);
    expect(d.addSample(_recovery), DeviationEvent.returnedToRoute);
    expect(d.returnedToRouteEventCount, 1);
    // Further recovery samples while back on-route must not re-fire.
    expect(d.addSample(_recovery), isNull);
    expect(d.addSample(_recovery), isNull);
    expect(d.addSample(_recovery), isNull);
    expect(d.returnedToRouteEventCount, 1);
    expect(d.state, DeviationState.onRoute);
  });

  test(
    'route revision resets pending counters but does NOT resolve a confirmed '
    'deviation',
    () {
      final d = _deviated();
      // Build a pending recovery, then a route change arrives.
      d.addSample(_recovery); // recovery streak 1
      expect(d.consecutiveRecovery, 1);

      d.updateRoute(_route); // route revision
      expect(d.state, DeviationState.deviated); // still deviated
      expect(d.consecutiveRecovery, 0); // pending reset
      expect(d.consecutiveOffRoute, 0);
      expect(d.returnedToRouteEventCount, 0); // not silently resolved

      // Recovery must still require a full 3 consecutive samples.
      expect(d.addSample(_recovery), isNull);
      expect(d.addSample(_recovery), isNull);
      expect(d.addSample(_recovery), DeviationEvent.returnedToRoute);
      expect(d.state, DeviationState.onRoute);
      expect(d.returnedToRouteEventCount, 1);
    },
  );
}
