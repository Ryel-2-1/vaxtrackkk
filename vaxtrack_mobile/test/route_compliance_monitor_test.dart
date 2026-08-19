import 'dart:math' as math;
import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:vaxtrack_mobile/utils/deviation_detector.dart';
import 'package:vaxtrack_mobile/utils/route_compliance_monitor.dart';

// A horizontal route (constant latitude); a north offset is a clean
// perpendicular distance so samples can be placed at precise distances.
const double _r = 6371008.8;
const double _d2r = math.pi / 180.0;

// Initial baseline route (2 points).
final List<LatLng> _routeA = <LatLng>[
  LatLng(14.6000, 120.9800),
  LatLng(14.6000, 120.9900),
];
// A distinct-but-collinear candidate route (3 points) — same line, different
// point count so an adoption is observable via baselinePointCount.
final List<LatLng> _routeB = <LatLng>[
  LatLng(14.6000, 120.9800),
  LatLng(14.6000, 120.9850),
  LatLng(14.6000, 120.9900),
];

LatLng _north(double meters) =>
    LatLng(14.6000 + meters / (_r * _d2r), 120.9850);

LatLng get _off => _north(200); // > 150 from either route
LatLng get _recovery => _north(50); // < 100
LatLng get _on => _north(30); // < 100

RouteComplianceMonitor _monitorOnRoute() {
  final m = RouteComplianceMonitor();
  m.setInitialRoute(_routeA);
  m.addRawSample(_on); // a compliant sample so _lastRawPoint is near baseline
  return m;
}

void main() {
  test('initial valid route becomes the compliance baseline', () {
    final m = RouteComplianceMonitor();
    expect(m.hasBaseline, isFalse);
    m.setInitialRoute(_routeA);
    expect(m.hasBaseline, isTrue);
    expect(m.baselinePointCount, 2);
    expect(m.complianceBaselineRevision, 1);
    expect(m.sdkRouteRevision, 0); // initial route is not a route-change
    expect(m.detectorState, DeviationState.onRoute);
    expect(m.candidateStatus, CandidateStatus.none);
  });

  test('benign route change while safely on-route is accepted', () {
    final m = _monitorOnRoute();
    m.onRouteChanged(_routeB);
    expect(m.candidateStatus, CandidateStatus.accepted);
    expect(m.candidateDeferReason, CandidateDeferReason.none);
    expect(m.baselinePointCount, 3); // now the 3-point route
    expect(m.complianceBaselineRevision, 2);
    expect(m.sdkRouteRevision, 1);
    expect(m.detectorState, DeviationState.onRoute);
  });

  test('route change during one pending off-route sample is deferred', () {
    final m = _monitorOnRoute();
    m.addRawSample(_off); // consecutiveOffRoute = 1
    expect(m.consecutiveOffRoute, 1);
    m.onRouteChanged(_routeB);
    expect(m.candidateStatus, CandidateStatus.deferred);
    expect(m.candidateDeferReason, CandidateDeferReason.pendingOffRoute);
    expect(m.baselinePointCount, 2); // baseline retained
    expect(m.complianceBaselineRevision, 1);
    expect(m.sdkRouteRevision, 1); // revision still bumped
  });

  test('deferred route does not reset the pending off-route streak', () {
    final m = _monitorOnRoute();
    m.addRawSample(_off);
    m.addRawSample(_off); // streak 2
    m.onRouteChanged(_routeB); // deferred
    expect(m.consecutiveOffRoute, 2); // preserved, NOT reset
    expect(m.detectorState, DeviationState.onRoute);
  });

  test('third off-route sample after a route change confirms deviation against '
      'the OLD baseline', () {
    final m = _monitorOnRoute();
    m.addRawSample(_off);
    m.addRawSample(_off); // streak 2
    m.onRouteChanged(_routeB); // deferred (streak preserved)
    final event = m.addRawSample(_off); // 3rd, vs retained baseline
    expect(event, DeviationEvent.deviated);
    expect(m.isDeviated, isTrue);
    expect(m.deviationEventCount, 1);
    expect(m.baselinePointCount, 2); // still the old baseline
  });

  test('route change while already deviated is deferred', () {
    final m = _monitorOnRoute();
    m.addRawSample(_off);
    m.addRawSample(_off);
    m.addRawSample(_off); // confirmed deviated
    expect(m.isDeviated, isTrue);
    m.onRouteChanged(_routeB);
    expect(m.candidateStatus, CandidateStatus.deferred);
    expect(m.candidateDeferReason, CandidateDeferReason.deviated);
    expect(m.isDeviated, isTrue);
    expect(m.baselinePointCount, 2);
  });

  test('route-changed alone emits no deviation', () {
    final m = _monitorOnRoute();
    m.addRawSample(_off);
    m.addRawSample(_off); // 2 pending, not confirmed
    expect(m.deviationEventCount, 0);
    m.onRouteChanged(_routeB); // deferred
    expect(m.deviationEventCount, 0);
    expect(m.detectorState, DeviationState.onRoute);
  });

  test('rerouting alone emits no deviation', () {
    final m = _monitorOnRoute();
    m.onRerouting();
    m.onRerouting();
    expect(m.reroutingSignalCount, 2);
    expect(m.deviationEventCount, 0);
    expect(m.detectorState, DeviationState.onRoute);
    expect(m.consecutiveOffRoute, 0);
  });

  test('a confirmed deviation is NOT resolved by a candidate route', () {
    final m = _monitorOnRoute();
    m.addRawSample(_off);
    m.addRawSample(_off);
    m.addRawSample(_off); // deviated
    m.onRouteChanged(_routeB); // deferred
    expect(m.isDeviated, isTrue);
    expect(m.returnedToRouteEventCount, 0);
    expect(m.baselinePointCount, 2); // retained baseline
  });

  test(
    'three recovery samples against the retained baseline confirm return',
    () {
      final m = _monitorOnRoute();
      m.addRawSample(_off);
      m.addRawSample(_off);
      m.addRawSample(_off); // deviated
      m.onRouteChanged(_routeB); // deferred, baseline retained (_routeA)
      expect(m.addRawSample(_recovery), isNull);
      expect(m.addRawSample(_recovery), isNull);
      final event = m.addRawSample(_recovery); // vs retained baseline
      expect(event, DeviationEvent.returnedToRoute);
      expect(m.detectorState, DeviationState.onRoute);
      expect(m.returnedToRouteEventCount, 1);
    },
  );

  test('a later safe candidate can be accepted after return', () {
    final m = _monitorOnRoute();
    m.addRawSample(_off);
    m.addRawSample(_off);
    m.addRawSample(_off); // deviated
    m.onRouteChanged(_routeB); // deferred (deviated)
    expect(m.baselinePointCount, 2);
    m.addRawSample(_recovery);
    m.addRawSample(_recovery);
    m.addRawSample(_recovery); // returned to route
    expect(m.detectorState, DeviationState.onRoute);
    // Now a later candidate is safe (rider ~50 m from baseline, on-route).
    m.onRouteChanged(_routeB);
    expect(m.candidateStatus, CandidateStatus.accepted);
    expect(m.baselinePointCount, 3);
    expect(m.complianceBaselineRevision, 2);
  });

  test('candidate far from the baseline is deferred', () {
    final m = RouteComplianceMonitor();
    m.setInitialRoute(_routeA);
    // Rider drifts to 200 m but only ONE sample (streak 1) — the far-distance
    // rule (as well as the pending-streak rule) should defer.
    m.addRawSample(_off);
    // Reset the pending-streak path by using a fresh monitor where the streak
    // is cleared but the rider is still far: emulate by an on-route sample then
    // a far sample is not possible without a streak, so assert the streak path.
    expect(m.candidateStatus, CandidateStatus.none);
    m.onRouteChanged(_routeB);
    expect(m.candidateStatus, CandidateStatus.deferred);
    // Either pendingOffRoute or farFromBaseline is a valid defer here; both are
    // protective. With streak 1 present, pendingOffRoute is reported first.
    expect(m.candidateDeferReason, CandidateDeferReason.pendingOffRoute);
    expect(m.baselinePointCount, 2);
  });

  test('invalid / short candidate route is rejected safely', () {
    final m = _monitorOnRoute();
    m.onRouteChanged(<LatLng>[LatLng(14.60, 120.98)]); // one point
    expect(m.candidateStatus, CandidateStatus.deferred);
    expect(m.candidateDeferReason, CandidateDeferReason.invalidRoute);
    expect(m.baselinePointCount, 2); // unchanged
    expect(m.complianceBaselineRevision, 1); // unchanged

    // An empty initial route sets no baseline.
    final m2 = RouteComplianceMonitor();
    m2.setInitialRoute(<LatLng>[]);
    expect(m2.hasBaseline, isFalse);
    expect(m2.candidateDeferReason, CandidateDeferReason.invalidRoute);
  });

  test('exactly-once deviation and return emissions remain intact', () {
    final m = _monitorOnRoute();
    m.addRawSample(_off);
    m.addRawSample(_off);
    expect(m.addRawSample(_off), DeviationEvent.deviated);
    expect(m.deviationEventCount, 1);
    // extra off-route -> no re-emit
    expect(m.addRawSample(_off), isNull);
    expect(m.deviationEventCount, 1);

    m.addRawSample(_recovery);
    m.addRawSample(_recovery);
    expect(m.addRawSample(_recovery), DeviationEvent.returnedToRoute);
    expect(m.returnedToRouteEventCount, 1);
    // extra recovery -> no re-emit
    expect(m.addRawSample(_recovery), isNull);
    expect(m.returnedToRouteEventCount, 1);
  });
}
