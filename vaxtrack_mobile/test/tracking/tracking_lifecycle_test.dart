import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/tracking/location_write_policy.dart';
import 'package:vaxtrack_mobile/tracking/tracking_lifecycle.dart';

const rider = 'riderA';
TrackedOrder order(String id, String status, {String? to = rider}) =>
    TrackedOrder(id: id, status: status, assignedRiderId: to);

void main() {
  group('planTracking', () {
    test('no orders → off', () {
      final p = planTracking(riderUid: rider, orders: const []);
      expect(p.mode, TrackingMode.off);
      expect(p.activeOrderIds, isEmpty);
    });

    test('each active status starts tracking', () {
      for (final s in ['assigned', 'loading', 'in_transit', 'delayed']) {
        expect(planTracking(riderUid: rider, orders: [order('o1', s)]).mode, TrackingMode.tracking, reason: s);
      }
    });

    test('terminal and parked statuses never track', () {
      for (final s in ['delivered', 'cancelled', 'delivery_failed', 'pending_dispatch']) {
        expect(planTracking(riderUid: rider, orders: [order('o1', s)]).mode, TrackingMode.off, reason: s);
      }
    });

    test('orders assigned to another rider are ignored (reassignment)', () {
      final p = planTracking(riderUid: rider, orders: [order('o1', 'in_transit', to: 'riderB')]);
      expect(p.mode, TrackingMode.off);
    });

    test('multiple active orders keep tracking until the last one ends', () {
      final both = planTracking(riderUid: rider, orders: [order('b', 'in_transit'), order('a', 'assigned')]);
      expect(both.activeOrderIds, ['a', 'b']);
      final one = planTracking(riderUid: rider, orders: [order('b', 'delivered'), order('a', 'assigned')]);
      expect(one.mode, TrackingMode.tracking);
      expect(one.activeOrderIds, ['a']);
    });

    test('navigating a navigable order → navigating', () {
      final p = planTracking(riderUid: rider, orders: [order('o1', 'in_transit')], navigatingOrderId: 'o1');
      expect(p.mode, TrackingMode.navigating);
      expect(p.endNavigation, isFalse);
      final delayed = planTracking(riderUid: rider, orders: [order('o1', 'delayed')], navigatingOrderId: 'o1');
      expect(delayed.mode, TrackingMode.navigating);
    });

    test('the navigated order completing ends navigation; other orders keep tracking', () {
      final p = planTracking(
        riderUid: rider,
        orders: [order('o1', 'delivered'), order('o2', 'assigned')],
        navigatingOrderId: 'o1',
      );
      expect(p.endNavigation, isTrue);
      expect(p.mode, TrackingMode.tracking);
    });

    test('the navigated order being reassigned ends navigation', () {
      final p = planTracking(
        riderUid: rider,
        orders: [order('o1', 'in_transit', to: 'riderB')],
        navigatingOrderId: 'o1',
      );
      expect(p.endNavigation, isTrue);
      expect(p.mode, TrackingMode.off);
    });
  });

  group('navigationEligibility', () {
    test('allowed for an assigned in-transit order, with or without a route', () {
      expect(navigationEligibility(order: order('o1', 'in_transit'), riderUid: rider, routeAvailable: true).canStart,
          isTrue);
      final noRoute = navigationEligibility(order: order('o1', 'in_transit'), riderUid: rider, routeAvailable: false);
      expect(noRoute.canStart, isTrue);
      expect(noRoute.routeAvailable, isFalse);
    });

    test('refused when signed out, not assigned, or not yet in transit', () {
      expect(navigationEligibility(order: order('o1', 'in_transit'), riderUid: null, routeAvailable: true).canStart,
          isFalse);
      expect(
          navigationEligibility(order: order('o1', 'in_transit', to: 'riderB'), riderUid: rider, routeAvailable: true)
              .blockers,
          contains('This delivery is not assigned to you.'));
      expect(navigationEligibility(order: order('o1', 'assigned'), riderUid: rider, routeAvailable: true).blockers,
          contains('Navigation starts once the delivery is in transit.'));
      expect(navigationEligibility(order: null, riderUid: rider, routeAvailable: true).canStart, isFalse);
    });
  });

  group('statusForAccess', () {
    test('maps every access state to a recoverable status', () {
      expect(statusForAccess(LocationAccess.granted, asked: false), TrackingStatus.tracking);
      expect(statusForAccess(LocationAccess.denied, asked: false), TrackingStatus.needsPermission);
      expect(statusForAccess(LocationAccess.denied, asked: true), TrackingStatus.permissionDenied);
      expect(statusForAccess(LocationAccess.deniedForever, asked: true), TrackingStatus.permissionBlocked);
      expect(statusForAccess(LocationAccess.serviceDisabled, asked: false), TrackingStatus.locationOff);
    });
  });

  test('session ids match the rules pattern and differ', () {
    final pattern = RegExp(r'^[A-Za-z0-9_-]{8,64}$');
    final a = newNavigationSessionId(math.Random(1));
    final b = newNavigationSessionId(math.Random(2));
    expect(pattern.hasMatch(a), isTrue);
    expect(a, isNot(b));
  });

  group('deviationDisplayFor', () {
    Map<String, dynamic> state({
      String sessionId = 's1',
      String sessionState = 'navigating',
      String routeStatus = 'available',
      String phase = 'on_route',
      int? pendingOffSinceMs,
    }) =>
        {
          'sessionId': sessionId,
          'sessionState': sessionState,
          'routeStatus': routeStatus,
          'phase': phase,
          'pendingOffSinceMs': pendingOffSinceMs,
        };

    test('no state, no session, an ended session or an OLDER session → not navigating', () {
      expect(deviationDisplayFor(null, sessionId: 's1'), DeviationDisplay.notNavigating);
      expect(deviationDisplayFor(state(), sessionId: null), DeviationDisplay.notNavigating);
      expect(deviationDisplayFor(state(sessionState: 'ended'), sessionId: 's1'), DeviationDisplay.notNavigating);
      expect(deviationDisplayFor(state(sessionId: 'old'), sessionId: 's1'), DeviationDisplay.notNavigating);
    });

    test('no route → Route not available (never a deviation)', () {
      final d = deviationDisplayFor(state(routeStatus: 'unavailable', phase: 'deviating'), sessionId: 's1');
      expect(d, DeviationDisplay.routeUnavailable);
      expect(kDeviationDisplayLabels[d], 'Route not available');
    });

    test('on route, pending and deviating', () {
      expect(deviationDisplayFor(state(), sessionId: 's1'), DeviationDisplay.onRoute);
      expect(deviationDisplayFor(state(pendingOffSinceMs: 1), sessionId: 's1'), DeviationDisplay.pendingDeviation);
      expect(deviationDisplayFor(state(phase: 'deviating'), sessionId: 's1'), DeviationDisplay.deviating);
    });

    test('every display state has a label', () {
      for (final d in DeviationDisplay.values) {
        expect(kDeviationDisplayLabels[d], isNotEmpty);
      }
    });
  });
}
