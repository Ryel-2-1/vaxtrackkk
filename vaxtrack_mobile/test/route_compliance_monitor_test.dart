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
// A second distinct-but-collinear candidate route (4 points) so "which
// candidate was adopted" is observable when several arrive before a fresh
// sample. Same horizontal line, so _north(x) distances are identical for A/B/C.
final List<LatLng> _routeC = <LatLng>[
  LatLng(14.6000, 120.9800),
  LatLng(14.6000, 120.9833),
  LatLng(14.6000, 120.9866),
  LatLng(14.6000, 120.9900),
];

LatLng _north(double meters) =>
    LatLng(14.6000 + meters / (_r * _d2r), 120.9850);

LatLng get _off => _north(200); // > 150 from every route (same line)
LatLng get _recovery => _north(50); // < 100
LatLng get _on => _north(30); // < 100

// A monitor with a valid baseline (_routeA) plus one on-route sample, so
// _validSampleRevision == 1 and the rider is safely on the baseline.
RouteComplianceMonitor _monitorOnRoute() {
  final m = RouteComplianceMonitor();
  m.setInitialRoute(_routeA);
  m.addRawSample(_on);
  return m;
}

void main() {
  // ---------------------------------------------------------------------------
  // Required Phase 3B scenarios (numbered to match the task's test list).
  // ---------------------------------------------------------------------------

  test(
    '1. the initial valid route becomes the compliance baseline immediately',
    () {
      final m = RouteComplianceMonitor();
      expect(m.hasBaseline, isFalse);
      m.setInitialRoute(_routeA);
      expect(m.hasBaseline, isTrue);
      expect(m.baselinePointCount, 2);
      expect(m.complianceBaselineRevision, 1);
      expect(m.sdkRouteRevision, 0); // initial route is not a route-change
      expect(m.candidateStatus, CandidateStatus.none);
      expect(m.detectorState, DeviationState.onRoute);
    },
  );

  test('2. a route change with only a stale on-route sample awaits a fresh '
      'sample (not accepted)', () {
    final m = _monitorOnRoute();
    m.onRouteChanged(_routeB);
    expect(m.candidateStatus, CandidateStatus.awaitingFreshSample);
    expect(m.candidateDeferReason, CandidateDeferReason.none);
    expect(m.baselinePointCount, 2); // baseline NOT replaced from a stale fix
    expect(m.sdkRouteRevision, 1);
    expect(m.hasPendingCandidate, isTrue);
  });

  test('3. the compliance baseline revision does not change before a fresh '
      'sample', () {
    final m = _monitorOnRoute();
    expect(m.complianceBaselineRevision, 1);
    m.onRouteChanged(_routeB);
    expect(m.complianceBaselineRevision, 1); // unchanged while awaiting
    expect(m.candidateStatus, CandidateStatus.awaitingFreshSample);
  });

  test('4. the next valid on-route sample accepts the pending candidate', () {
    final m = _monitorOnRoute();
    m.onRouteChanged(_routeB); // awaiting
    final event = m.addRawSample(_on); // fresh + valid + on-route
    expect(event, isNull);
    expect(m.candidateStatus, CandidateStatus.accepted);
    expect(m.candidateDeferReason, CandidateDeferReason.none);
    expect(m.baselinePointCount, 3); // now _routeB
    expect(m.complianceBaselineRevision, 2);
    expect(m.detectorState, DeviationState.onRoute);
  });

  test('5. a route change BEFORE the fresh off-route sample cannot hide the '
      'deviation', () {
    final m = _monitorOnRoute();
    // The exact race from the device: route-change arrives first, then the
    // fresh off-route fix.
    m.onRouteChanged(_routeB);
    expect(m.candidateStatus, CandidateStatus.awaitingFreshSample);
    // First fresh sample is off-route -> evaluated vs the OLD baseline first.
    expect(m.addRawSample(_off), isNull); // streak 1, candidate deferred
    expect(m.candidateStatus, CandidateStatus.deferred);
    expect(m.candidateDeferReason, CandidateDeferReason.pendingOffRoute);
    expect(m.baselinePointCount, 2); // OLD baseline retained
    // Two more off-route samples confirm the deviation against the OLD baseline.
    expect(m.addRawSample(_off), isNull); // streak 2
    expect(m.addRawSample(_off), DeviationEvent.deviated); // streak 3
    expect(m.isDeviated, isTrue);
    expect(m.deviationEventCount, 1);
    expect(m.baselinePointCount, 2); // still the OLD baseline
  });

  test('6. the first far sample after a route change defers and records '
      'off-route count 1', () {
    final m = _monitorOnRoute();
    m.onRouteChanged(_routeB); // awaiting
    expect(m.addRawSample(_off), isNull);
    expect(m.consecutiveOffRoute, 1);
    expect(m.candidateStatus, CandidateStatus.deferred);
    expect(m.candidateDeferReason, CandidateDeferReason.pendingOffRoute);
    expect(m.baselinePointCount, 2);
    expect(m.complianceBaselineRevision, 1);
  });

  test('7. the second and third far samples continue against the OLD baseline '
      'and confirm deviation', () {
    final m = _monitorOnRoute();
    m.onRouteChanged(_routeB);
    m.addRawSample(_off); // 1 (candidate deferred here)
    expect(m.addRawSample(_off), isNull); // 2
    expect(m.consecutiveOffRoute, 2);
    expect(m.addRawSample(_off), DeviationEvent.deviated); // 3
    expect(m.isDeviated, isTrue);
    expect(m.baselinePointCount, 2);
  });

  test('8. a route change does NOT reset the pending off-route streak', () {
    final m = _monitorOnRoute();
    m.addRawSample(_off);
    m.addRawSample(_off); // streak 2 before the route change
    m.onRouteChanged(_routeB); // awaiting — must not touch the detector
    expect(m.consecutiveOffRoute, 2); // preserved, NOT reset
    expect(m.candidateStatus, CandidateStatus.awaitingFreshSample);
    expect(m.detectorState, DeviationState.onRoute);
  });

  test('9. a poor-accuracy sample after a route change does not unlock the '
      'candidate', () {
    final m = _monitorOnRoute();
    m.onRouteChanged(_routeB); // awaiting
    final r = m.addRawSample(_on, accuracyMeters: 60); // > 50 -> ignored
    expect(r, isNull);
    expect(m.candidateStatus, CandidateStatus.awaitingFreshSample); // still
    expect(m.validSampleRevision, 1); // not advanced by the poor sample
    expect(m.baselinePointCount, 2); // baseline unchanged
    expect(m.complianceBaselineRevision, 1);
  });

  test(
    '10. a valid sample after a poor-accuracy one performs the decision',
    () {
      final m = _monitorOnRoute();
      m.onRouteChanged(_routeB); // awaiting
      m.addRawSample(_on, accuracyMeters: 60); // ignored, still awaiting
      expect(m.candidateStatus, CandidateStatus.awaitingFreshSample);
      m.addRawSample(_on, accuracyMeters: 10); // valid -> decide
      expect(m.candidateStatus, CandidateStatus.accepted);
      expect(m.baselinePointCount, 3);
      expect(m.complianceBaselineRevision, 2);
    },
  );

  test('11. multiple route changes before a fresh sample keep the NEWEST '
      'candidate and preserve the baseline', () {
    final m = _monitorOnRoute();
    m.onRouteChanged(_routeB); // 3-point candidate
    m.onRouteChanged(_routeC); // 4-point candidate replaces it
    expect(m.candidateStatus, CandidateStatus.awaitingFreshSample);
    expect(m.sdkRouteRevision, 2); // incremented per callback
    expect(m.baselinePointCount, 2); // baseline still unchanged
    // One later fresh sample evaluates the NEWEST candidate vs the old baseline.
    m.addRawSample(_on);
    expect(m.candidateStatus, CandidateStatus.accepted);
    expect(m.baselinePointCount, 4); // _routeC adopted (not _routeB)
    expect(m.complianceBaselineRevision, 2);
  });

  test('12. a route change while deviated is deferred by the next sample', () {
    final m = _monitorOnRoute();
    m.addRawSample(_off);
    m.addRawSample(_off);
    m.addRawSample(_off); // confirmed deviated
    expect(m.isDeviated, isTrue);
    m.onRouteChanged(_routeB); // awaiting (detector untouched)
    expect(m.candidateStatus, CandidateStatus.awaitingFreshSample);
    expect(m.isDeviated, isTrue);
    m.addRawSample(_recovery); // next fresh sample decides -> still deviated
    expect(m.candidateStatus, CandidateStatus.deferred);
    expect(m.candidateDeferReason, CandidateDeferReason.deviated);
    expect(m.isDeviated, isTrue);
    expect(m.baselinePointCount, 2);
  });

  test('13. candidate adoption never resolves a confirmed deviation', () {
    final m = _monitorOnRoute();
    m.addRawSample(_off);
    m.addRawSample(_off);
    m.addRawSample(_off); // deviated
    m.onRouteChanged(_routeB); // awaiting
    m.addRawSample(_recovery); // decides -> deferred (deviated)
    expect(m.isDeviated, isTrue);
    expect(m.returnedToRouteEventCount, 0);
    expect(m.baselinePointCount, 2); // retained baseline
  });

  test('14. three recovery samples against the retained baseline are still '
      'required', () {
    final m = _monitorOnRoute();
    m.addRawSample(_off);
    m.addRawSample(_off);
    m.addRawSample(_off); // deviated
    m.onRouteChanged(_routeB); // awaiting, baseline retained (_routeA)
    expect(m.addRawSample(_recovery), isNull); // 1 (also defers candidate)
    expect(m.candidateStatus, CandidateStatus.deferred);
    expect(m.addRawSample(_recovery), isNull); // 2
    final event = m.addRawSample(_recovery); // 3 -> returned
    expect(event, DeviationEvent.returnedToRoute);
    expect(m.detectorState, DeviationState.onRoute);
    expect(m.returnedToRouteEventCount, 1);
    expect(m.baselinePointCount, 2); // still the retained baseline
  });

  test('15. a later candidate is accepted only after return AND another fresh '
      'safe sample', () {
    final m = _monitorOnRoute();
    m.addRawSample(_off);
    m.addRawSample(_off);
    m.addRawSample(_off); // deviated
    m.onRouteChanged(_routeB); // awaiting
    m.addRawSample(_recovery); // deferred (deviated), recovery 1
    m.addRawSample(_recovery); // recovery 2
    m.addRawSample(_recovery); // returned to route
    expect(m.detectorState, DeviationState.onRoute);
    expect(m.baselinePointCount, 2); // still old baseline (candidate deferred)
    expect(m.complianceBaselineRevision, 1);
    // Now a NEW candidate plus one fresh safe sample is accepted.
    m.onRouteChanged(_routeC); // awaiting
    expect(m.candidateStatus, CandidateStatus.awaitingFreshSample);
    m.addRawSample(_on); // fresh + safe -> accept
    expect(m.candidateStatus, CandidateStatus.accepted);
    expect(m.baselinePointCount, 4); // _routeC adopted
    expect(m.complianceBaselineRevision, 2);
  });

  test('16. route-change and rerouting callbacks alone emit no compliance '
      'event', () {
    final m = _monitorOnRoute();
    m.onRerouting();
    m.onRouteChanged(_routeB);
    m.onRerouting();
    expect(m.deviationEventCount, 0);
    expect(m.returnedToRouteEventCount, 0);
    expect(m.reroutingSignalCount, 2);
    expect(m.candidateStatus, CandidateStatus.awaitingFreshSample);
    expect(m.baselinePointCount, 2);
  });

  test('17. exactly-once deviation and return emissions remain intact', () {
    final m = _monitorOnRoute();
    m.addRawSample(_off);
    m.addRawSample(_off);
    expect(m.addRawSample(_off), DeviationEvent.deviated);
    expect(m.deviationEventCount, 1);
    expect(m.addRawSample(_off), isNull); // no re-emit while deviated
    expect(m.deviationEventCount, 1);

    m.addRawSample(_recovery);
    m.addRawSample(_recovery);
    expect(m.addRawSample(_recovery), DeviationEvent.returnedToRoute);
    expect(m.returnedToRouteEventCount, 1);
    expect(m.addRawSample(_recovery), isNull); // no re-emit while on-route
    expect(m.returnedToRouteEventCount, 1);
  });

  // ---------------------------------------------------------------------------
  // Retained invariants.
  // ---------------------------------------------------------------------------

  test('invalid / short candidate route is rejected safely (no awaiting)', () {
    final m = _monitorOnRoute();
    m.onRouteChanged(<LatLng>[LatLng(14.60, 120.98)]); // one point
    expect(m.candidateStatus, CandidateStatus.deferred);
    expect(m.candidateDeferReason, CandidateDeferReason.invalidRoute);
    expect(m.hasPendingCandidate, isFalse);
    expect(m.baselinePointCount, 2); // unchanged
    expect(m.complianceBaselineRevision, 1); // unchanged

    // An empty initial route sets no baseline.
    final m2 = RouteComplianceMonitor();
    m2.setInitialRoute(<LatLng>[]);
    expect(m2.hasBaseline, isFalse);
    expect(m2.candidateDeferReason, CandidateDeferReason.invalidRoute);
  });

  test('rerouting alone emits no deviation and no candidate change', () {
    final m = _monitorOnRoute();
    m.onRerouting();
    m.onRerouting();
    expect(m.reroutingSignalCount, 2);
    expect(m.deviationEventCount, 0);
    expect(m.detectorState, DeviationState.onRoute);
    expect(m.consecutiveOffRoute, 0);
    expect(m.candidateStatus, CandidateStatus.none); // no route change happened
  });

  test('the valid sample revision advances only on usable samples', () {
    final m = RouteComplianceMonitor();
    m.setInitialRoute(_routeA);
    expect(m.validSampleRevision, 0);
    m.addRawSample(_on); // usable
    expect(m.validSampleRevision, 1);
    m.addRawSample(_on, accuracyMeters: 60); // poor -> not usable
    expect(m.validSampleRevision, 1); // unchanged
    m.addRawSample(_on, accuracyMeters: 10); // usable
    expect(m.validSampleRevision, 2);
  });

  test(
    'a sample before any baseline is not usable and cannot arm a candidate',
    () {
      final m = RouteComplianceMonitor();
      m.addRawSample(_on); // no baseline yet
      expect(m.validSampleRevision, 0);
      expect(m.hasBaseline, isFalse);
    },
  );

  test(
    'candidateCreatedAtSampleRevision captures the arming sample revision',
    () {
      final m = _monitorOnRoute(); // validSampleRevision == 1
      m.onRouteChanged(_routeB);
      expect(m.candidateCreatedAtSampleRevision, 1);
      // The very next usable sample (revision 2 > 1) decides the candidate.
      m.addRawSample(_on);
      expect(m.validSampleRevision, 2);
      expect(m.candidateStatus, CandidateStatus.accepted);
    },
  );
}
