import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/models/delivery.dart';
import 'package:vaxtrack_mobile/tracking/location_write_policy.dart';
import 'package:vaxtrack_mobile/tracking/tracking_lifecycle.dart';
import 'package:vaxtrack_mobile/utils/route_screen_state.dart';
import 'package:vaxtrack_mobile/utils/saved_route_plan.dart';

final _now = DateTime.utc(2026, 11, 1, 3);

LocationFix _fix({double accuracy = 12, Duration age = const Duration(seconds: 20)}) => LocationFix(
      latitude: 14.31,
      longitude: 121.08,
      accuracyMeters: accuracy,
      capturedAt: _now.subtract(age),
    );

Delivery _stop(String id, int seq, {String status = 'in_transit', double lat = 14.3, String trip = 't1', int count = 3}) =>
    Delivery.fromFirestore(id, {
      'status': status,
      'clinicName': 'Clinic $id',
      'clinicLat': lat,
      'clinicLng': 121.1,
      'tripId': trip,
      'stopSequence': seq,
      'tripStopCount': count,
    });

void main() {
  group('GPS status uses the server route check thresholds', () {
    test('nothing shared yet, then waiting for a first fix', () {
      expect(gpsStatusFor(fix: _fix(), now: _now, sharing: false).state, GpsState.notSharing);
      expect(gpsStatusFor(fix: null, now: _now, sharing: true).state, GpsState.waiting);
    });

    test('a fresh accurate fix is good; worse than 100 m is weak and says it is skipped', () {
      final good = gpsStatusFor(fix: _fix(accuracy: 12), now: _now, sharing: true);
      expect(good.state, GpsState.good);
      expect(good.usableForRouteCheck, isTrue);
      expect(good.message, 'GPS good (±12 m)');
      final weak = gpsStatusFor(fix: _fix(accuracy: 140), now: _now, sharing: true);
      expect(weak.state, GpsState.weak);
      expect(weak.usableForRouteCheck, isFalse);
      expect(weak.message, contains('skips positions less accurate than 100 m'));
      expect(gpsStatusFor(fix: _fix(accuracy: 100), now: _now, sharing: true).state, GpsState.good,
          reason: 'exactly 100 m is still accepted by the server');
    });

    test('an old fix is reported as lost, with how long and what to do', () {
      final lost = gpsStatusFor(fix: _fix(age: const Duration(minutes: 5)), now: _now, sharing: true);
      expect(lost.state, GpsState.lost);
      expect(lost.message, contains('No GPS fix for 5 min'));
      expect(lost.message, contains('open sky'));
      expect(gpsStatusFor(fix: _fix(age: const Duration(minutes: 2)), now: _now, sharing: true).state, GpsState.good,
          reason: 'two minutes is the freshness boundary, not past it');
    });
  });

  group('next stop follows the planned order and skips finished stops', () {
    test('this stop, its place in the trip, and the unfinished stop after it', () {
      final a = _stop('a', 1), b = _stop('b', 2, status: 'delivered'), c = _stop('c', 3);
      final next = nextStopFor(a, [a, b, c]);
      expect(next.position, 'Stop 1 of 3');
      expect(next.after?.id, 'c');
    });

    test('the last stop has nothing after it; a single delivery has no position', () {
      final a = _stop('a', 1, status: 'delivered'), c = _stop('c', 3);
      expect(nextStopFor(c, [a, c]).after, isNull);
      final single = Delivery.fromFirestore('s', {'status': 'in_transit', 'clinicLat': 14.3, 'clinicLng': 121.1});
      final next = nextStopFor(single, [single]);
      expect(next.position, isNull);
      expect(next.after, isNull);
    });
  });

  group('a plan dispatch re-plans is announced, never silently swapped', () {
    test('first value is the baseline; then planned, replanned, withdrawn', () {
      final t = PlanChangeTracker();
      expect(t.observe(null), PlanChange.none);
      expect(t.observe(null), PlanChange.none);
      expect(t.observe('order:10:1'), PlanChange.planned);
      expect(t.observe('order:10:1'), PlanChange.none);
      expect(t.observe('trip:20:2'), PlanChange.replanned);
      expect(t.observe(null), PlanChange.withdrawn);
      expect(kPlanChangeMessages.keys.toSet(), {PlanChange.planned, PlanChange.replanned, PlanChange.withdrawn});
    });

    test('a live order update with a new saved route changes the fingerprint the screen tracks', () {
      Delivery withRoute(String polyline, int generatedMs) => Delivery.fromFirestore('o', {
            'routePolyline': polyline,
            'routeGeneratedAt': Timestamp.fromMillisecondsSinceEpoch(generatedMs),
            'assignedAt': Timestamp.fromMillisecondsSinceEpoch(1000),
          });
      final t = PlanChangeTracker()..observe(SavedRoutePlan.of(withRoute('_p~iF~ps|U_ulLnnqC', 2000)).fingerprint);
      expect(t.observe(SavedRoutePlan.of(withRoute('_p~iF~ps|U_ulLnnqC', 2000)).fingerprint), PlanChange.none);
      expect(t.observe(SavedRoutePlan.of(withRoute('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 3000)).fingerprint), PlanChange.replanned);
    });
  });

  group('off-route advice points back to the plan and to dispatch', () {
    test('only the two off-route states advise, and none claims a safe route', () {
      expect(kOffRouteAdvice.keys.toSet(), {DeviationDisplay.pendingDeviation, DeviationDisplay.deviating});
      for (final advice in kOffRouteAdvice.values) {
        expect(advice, contains('dispatch'));
        expect(advice.toLowerCase(), isNot(contains('safe')));
        expect(advice, isNot(contains('Google')));
      }
      expect(kOffRouteAdvice[DeviationDisplay.pendingDeviation], contains('500 m'));
    });
  });

  group('Google Maps hand-off carries stops, never the saved route', () {
    test('a trip opens this stop then the remaining stops in the planned order', () {
      final a = _stop('a', 1, lat: 14.1), b = _stop('b', 2, lat: 14.2), c = _stop('c', 3, lat: 14.3);
      final handoff = googleHandoffFor(b, [a, b, c]);
      final q = handoff.uri!.queryParameters;
      expect(q['destination'], '14.1,121.1', reason: 'the earlier unfinished stop still has to be visited');
      expect(q['waypoints'], '14.2,121.1|14.3,121.1');
      expect(q['travelmode'], 'two-wheeler');
      expect(q.keys, isNot(contains('polyline')));
      expect(handoff.message, contains('in the planned order'));
    });

    test('without the deliveries list a trip stop is opened alone, not refused', () {
      final b = _stop('b', 2, lat: 14.2);
      final handoff = googleHandoffFor(b, null);
      expect(handoff.uri!.queryParameters['destination'], '14.2,121.1');
      expect(handoff.uri!.queryParameters.containsKey('waypoints'), isFalse);
    });

    test('no pin falls back to an address search; nothing at all says so', () {
      final address = Delivery.fromFirestore('x', {'status': 'in_transit', 'clinicAddress': 'Rizal St, Biñan'});
      final search = googleHandoffFor(address, null);
      expect(search.uri!.path, '/maps/search/');
      expect(search.uri!.queryParameters['query'], 'Rizal St, Biñan');
      expect(search.message, contains('search by the clinic address'));
      final none = googleHandoffFor(Delivery.fromFirestore('y', {'status': 'in_transit'}), null);
      expect(none.uri, isNull);
      expect(none.message, contains('No destination'));
    });

    test('over Google\'s stop limit it says how many it opened', () {
      final stops = [for (var i = 1; i <= 12; i++) _stop('s$i', i, lat: 14 + i / 100, count: 12)];
      final handoff = googleHandoffFor(stops.first, stops);
      expect(handoff.message, contains('next 10 stops'));
    });
  });
}
