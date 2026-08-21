import 'dart:async';
import 'dart:math' as math;
import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:vaxtrack_mobile/models/delivery.dart';
import 'package:vaxtrack_mobile/utils/deviation_detector.dart';
import 'package:vaxtrack_mobile/utils/route_compliance_monitor.dart';
import 'package:vaxtrack_mobile/utils/route_monitor.dart';

// Dependency-free tests for the FREE in-app route-monitoring glue. They import
// ONLY pure Dart (no Flutter widgets, no Geolocator, no Firebase, no network
// tiles): eligibility, the confirmed-context builder, and the DI controller.
// The controller reuses the real RouteComplianceMonitor and forwards to injected
// capturing dispatch callbacks (standing in for RouteDeviationAlertService).

// --- Geometry: a horizontal baseline; a north offset is a clean perpendicular
// distance, matching route_compliance_monitor_test.dart. ---
const double _r = 6371008.8;
const double _d2r = math.pi / 180.0;

final List<LatLng> _routeA = <LatLng>[
  LatLng(14.6000, 120.9800),
  LatLng(14.6000, 120.9900),
];

LatLng _north(double meters) =>
    LatLng(14.6000 + meters / (_r * _d2r), 120.9850);

LatLng get _off => _north(200); // > 150 m from the baseline
LatLng get _recovery => _north(50); // < 100 m
LatLng get _on => _north(30); // < 100 m

GpsSample _s(LatLng p, {double? acc}) =>
    GpsSample(p.latitude, p.longitude, accuracyMeters: acc);

// Google's canonical precision-5 polyline example → 3 points. Used only to
// satisfy the "genuine saved route present" branch (its geometry is irrelevant
// to eligibility).
const String kSamplePolyline = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

Delivery _delivery({
  String id = 'orderDoc123',
  String orderNumber = 'VT-ORD-1',
  String status = 'in_transit',
  String? assignedRiderId = 'rider-uid-1',
  double? clinicLat = 14.6001,
  double? clinicLng = 120.9850,
  String? routePolyline = kSamplePolyline,
}) {
  return Delivery(
    id: id,
    orderNumber: orderNumber,
    clinicName: 'Test Clinic',
    clinicAddress: '123 Test St',
    vaccineName: 'VaccineX',
    quantity: 1,
    unit: 'vials',
    priority: 'Standard',
    status: status,
    statusLabel: status,
    assignedRiderId: assignedRiderId,
    assignedRiderName: 'Rider One',
    clinicLat: clinicLat,
    clinicLng: clinicLng,
    routePolyline: routePolyline,
  );
}

class _Capture {
  final events = <DeviationEvent>[];
  final samples = <GpsSample>[];
  Future<void> deviation(GpsSample s, double d) async {
    events.add(DeviationEvent.deviated);
    samples.add(s);
  }

  Future<void> returned(GpsSample s, double d) async {
    events.add(DeviationEvent.returnedToRoute);
    samples.add(s);
  }
}

RouteMonitorController _controller({
  required RouteComplianceMonitor monitor,
  required Stream<GpsSample> Function() factory,
  required _Capture cap,
}) {
  return RouteMonitorController(
    monitor: monitor,
    sampleStreamFactory: factory,
    onDeviation: cap.deviation,
    onReturn: cap.returned,
  );
}

Stream<GpsSample> _emptyFactory() => const Stream<GpsSample>.empty();

void main() {
  group('start eligibility', () {
    test('an eligible active, assigned, coord+route delivery can start', () {
      final e = RouteMonitorEligibility.evaluate(
        delivery: _delivery(),
        currentUserUid: 'rider-uid-1',
      );
      expect(e.canStart, isTrue);
      expect(e.blockers, isEmpty);
    });

    test('an unauthenticated rider is blocked', () {
      final e = RouteMonitorEligibility.evaluate(
        delivery: _delivery(),
        currentUserUid: null,
      );
      expect(e.canStart, isFalse);
      expect(e.blockers, isNotEmpty);
    });

    test('an unassigned / other-rider delivery is blocked', () {
      final e = RouteMonitorEligibility.evaluate(
        delivery: _delivery(assignedRiderId: 'someone-else'),
        currentUserUid: 'rider-uid-1',
      );
      expect(e.canStart, isFalse);

      final e2 = RouteMonitorEligibility.evaluate(
        delivery: _delivery(assignedRiderId: null),
        currentUserUid: 'rider-uid-1',
      );
      expect(e2.canStart, isFalse);
    });

    test('a delivered / cancelled (inactive) delivery is blocked', () {
      for (final s in ['delivered', 'cancelled', 'completed']) {
        final e = RouteMonitorEligibility.evaluate(
          delivery: _delivery(status: s),
          currentUserUid: 'rider-uid-1',
        );
        expect(e.canStart, isFalse, reason: 'status=$s should block');
      }
    });

    test('a missing destination coordinate is blocked', () {
      final e = RouteMonitorEligibility.evaluate(
        delivery: _delivery(clinicLat: null, clinicLng: null),
        currentUserUid: 'rider-uid-1',
      );
      expect(e.canStart, isFalse);
    });

    test('a missing / empty route polyline is blocked', () {
      for (final p in [null, '']) {
        final e = RouteMonitorEligibility.evaluate(
          delivery: _delivery(routePolyline: p),
          currentUserUid: 'rider-uid-1',
        );
        expect(e.canStart, isFalse, reason: 'polyline=$p should block');
      }
    });
  });

  group('confirmed context (real identity only)', () {
    test(
      'carries the order DOC id + rider uid; orderNumber stays display-only',
      () {
        final d = _delivery(id: 'DOC_abc', orderNumber: 'VT-ORD-999');
        final ctx = buildRouteDeviationContext(
          delivery: d,
          currentUserUid: 'rider-uid-1',
        );
        expect(ctx, isNotNull);
        expect(ctx!.orderId, 'DOC_abc'); // Firestore doc id
        expect(ctx.orderId, isNot('VT-ORD-999')); // never the order number
        expect(ctx.orderNumber, 'VT-ORD-999'); // display-only
        expect(ctx.riderUid, 'rider-uid-1');
      },
    );

    test('is null (never invents an id) when uid or doc id is missing', () {
      expect(
        buildRouteDeviationContext(
          delivery: _delivery(id: 'DOC_abc'),
          currentUserUid: null,
        ),
        isNull,
      );
      expect(
        buildRouteDeviationContext(
          delivery: _delivery(id: 'DOC_abc'),
          currentUserUid: '',
        ),
        isNull,
      );
      expect(
        buildRouteDeviationContext(
          delivery: _delivery(id: ''),
          currentUserUid: 'rider-uid-1',
        ),
        isNull,
      );
    });
  });

  group('controller lifecycle', () {
    test('repeated Start does not create duplicate subscriptions', () async {
      final monitor = RouteComplianceMonitor()..setInitialRoute(_routeA);
      final cap = _Capture();
      final sc = StreamController<GpsSample>.broadcast();
      var factoryCalls = 0;
      final c = _controller(
        monitor: monitor,
        factory: () {
          factoryCalls++;
          return sc.stream;
        },
        cap: cap,
      );

      c.start();
      c.start();
      c.start();

      expect(factoryCalls, 1);
      expect(c.isMonitoring, isTrue);

      await c.dispose();
      await sc.close();
    });

    test(
      'Stop cancels the stream without emitting a false transition',
      () async {
        final monitor = RouteComplianceMonitor()..setInitialRoute(_routeA);
        final cap = _Capture();
        final sc = StreamController<GpsSample>.broadcast();
        final c = _controller(
          monitor: monitor,
          factory: () => sc.stream,
          cap: cap,
        );

        c.start();
        expect(c.isMonitoring, isTrue);

        sc.add(_s(_on));
        await Future<void>.delayed(Duration.zero);
        expect(monitor.validSampleRevision, 1);

        await c.stop();
        expect(c.isMonitoring, isFalse);
        expect(c.phase, RouteMonitorPhase.stopped);
        expect(cap.events, isEmpty); // stopping emits nothing

        // Post-stop samples are not processed.
        sc.add(_s(_off));
        await Future<void>.delayed(Duration.zero);
        expect(monitor.validSampleRevision, 1);

        await c.dispose();
        await sc.close();
      },
    );

    test('samples after dispose are ignored', () async {
      final monitor = RouteComplianceMonitor()..setInitialRoute(_routeA);
      final cap = _Capture();
      final c = _controller(monitor: monitor, factory: _emptyFactory, cap: cap);

      c.handleSample(_s(_on));
      final revBefore = monitor.validSampleRevision;

      await c.dispose();
      expect(c.isDisposed, isTrue);

      for (var i = 0; i < 3; i++) {
        c.handleSample(_s(_off));
      }
      await c.pendingWrites;

      expect(monitor.validSampleRevision, revBefore); // nothing processed
      expect(cap.events, isEmpty);
    });
  });

  group('controller detection wiring (reuses the existing detector)', () {
    test('deviated → returned → later deviated dispatches the sequence that '
        'drives the existing episode lifecycle', () async {
      final monitor = RouteComplianceMonitor()..setInitialRoute(_routeA);
      final cap = _Capture();
      final c = _controller(monitor: monitor, factory: _emptyFactory, cap: cap);

      c.handleSample(_s(_on)); // on-route baseline
      for (var i = 0; i < 3; i++) {
        c.handleSample(_s(_off)); // → deviated
      }
      for (var i = 0; i < 3; i++) {
        c.handleSample(_s(_recovery)); // → returned
      }
      for (var i = 0; i < 3; i++) {
        c.handleSample(_s(_off)); // → deviated again
      }
      await c.pendingWrites;

      expect(cap.events, <DeviationEvent>[
        DeviationEvent.deviated,
        DeviationEvent.returnedToRoute,
        DeviationEvent.deviated,
      ]);
      expect(c.dispatchCount, 3);
      // Episode-count increment itself is covered by
      // route_deviation_alert_service_test.dart (reused, not duplicated).
    });

    test('poor-accuracy samples are ignored (never deviate)', () async {
      final monitor = RouteComplianceMonitor()..setInitialRoute(_routeA);
      final cap = _Capture();
      final c = _controller(monitor: monitor, factory: _emptyFactory, cap: cap);

      c.handleSample(_s(_on)); // one usable sample
      final revBefore = monitor.validSampleRevision;

      for (var i = 0; i < 5; i++) {
        c.handleSample(_s(_off, acc: 60)); // > 50 m accuracy → ignored
      }
      await c.pendingWrites;

      expect(monitor.isDeviated, isFalse);
      expect(cap.events, isEmpty);
      expect(monitor.validSampleRevision, revBefore); // never advanced
    });

    test('duplicate/repeated samples do not re-emit a transition', () async {
      final monitor = RouteComplianceMonitor()..setInitialRoute(_routeA);
      final cap = _Capture();
      final c = _controller(monitor: monitor, factory: _emptyFactory, cap: cap);

      c.handleSample(_s(_on));
      for (var i = 0; i < 3; i++) {
        c.handleSample(_s(_off)); // one deviation
      }
      // Stay off-route for many more samples — no repeat deviation.
      for (var i = 0; i < 5; i++) {
        c.handleSample(_s(_off));
      }
      await c.pendingWrites;

      expect(cap.events, <DeviationEvent>[DeviationEvent.deviated]);
      expect(c.dispatchCount, 1);
    });
  });
}
