import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/services/route_deviation_alert_service.dart';

// A confirmed, valid incident context.
const _ctx = RouteDeviationContext(
  orderId: 'ORDER_DOC_123',
  riderUid: 'RIDER_UID_abc',
  orderNumber: 'VT-ORD-999',
  clinicName: 'Meridian Clinic',
  riderName: 'Jane Rider',
);

// Apply a plan to a document map the way the transaction adapter would, using a
// sentinel string for server timestamps so ordering/preservation is assertable.
Map<String, dynamic> _apply(Map<String, dynamic>? existing, IncidentPlan plan) {
  if (plan.action == IncidentAction.noop) {
    return existing ?? <String, dynamic>{};
  }
  final base = Map<String, dynamic>.from(existing ?? <String, dynamic>{});
  base.addAll(plan.data);
  // The adapter always stamps these with a server timestamp; fields NOT listed
  // here (e.g. createdAt on reopen/update) are left untouched — that is exactly
  // how the original creation time is preserved.
  for (final f in plan.serverTimestampFields) {
    base[f] = 'TS';
  }
  return base;
}

void main() {
  group('deterministic id', () {
    test('is stable for the same order + rider', () {
      final a = routeDeviationAlertId(_ctx.orderId, _ctx.riderUid);
      final b = routeDeviationAlertId(_ctx.orderId, _ctx.riderUid);
      expect(a, b);
    });

    test('differs for different orders or riders', () {
      final base = routeDeviationAlertId('o1', 'r1');
      expect(base, isNot(routeDeviationAlertId('o2', 'r1')));
      expect(base, isNot(routeDeviationAlertId('o1', 'r2')));
    });

    test('return uses the same incident id as deviation', () {
      // Both write paths address the same document id built from the context.
      final idFromContext = routeDeviationAlertId(_ctx.orderId, _ctx.riderUid);
      expect(idFromContext, 'route_deviation_ORDER_DOC_123_RIDER_UID_abc');
    });

    test(
      'is a valid Firestore id (prefixed, no slash, not reserved pattern)',
      () {
        final id = routeDeviationAlertId(_ctx.orderId, _ctx.riderUid);
        expect(id.startsWith('route_deviation_'), isTrue);
        expect(id.contains('/'), isFalse);
        expect(RegExp(r'^__.*__$').hasMatch(id), isFalse);
      },
    );

    test('rejects empty or slash-bearing identity locally', () {
      expect(() => routeDeviationAlertId('', 'r'), throwsArgumentError);
      expect(() => routeDeviationAlertId('o', ''), throwsArgumentError);
      expect(() => routeDeviationAlertId('a/b', 'r'), throwsArgumentError);
    });
  });

  group('planDeviationWrite', () {
    test('creates a new active incident when none exists', () {
      final plan = planDeviationWrite(
        existing: null,
        context: _ctx,
        latitude: 14.6,
        longitude: 121.0,
        distanceMeters: 1124,
        accuracyMeters: 5,
      );
      expect(plan.action, IncidentAction.create);
      final d = plan.data;
      expect(d['type'], 'route_deviation');
      expect(d['severity'], 'critical');
      expect(d['status'], 'active');
      expect(d['read'], false);
      // Identity is the order DOC id, never the order number.
      expect(d['orderId'], 'ORDER_DOC_123');
      expect(d['deliveryId'], 'ORDER_DOC_123');
      expect(d['orderNumber'], 'VT-ORD-999'); // display metadata only
      expect(d['riderId'], 'RIDER_UID_abc');
      expect(d['episodeCount'], 1);
      expect(d['distanceMeters'], 1124);
      expect(d['accuracyMeters'], 5);
      // Message carries rider + order number + clinic + distance for the Admin
      // generic renderer.
      final msg = d['message'] as String;
      expect(msg, contains('Jane Rider'));
      expect(msg, contains('VT-ORD-999'));
      expect(msg, contains('Meridian Clinic'));
      expect(msg, contains('1124'));
      // Server timestamps set on create.
      expect(
        plan.serverTimestampFields,
        containsAll(<String>['createdAt', 'updatedAt', 'lastDetectedAt']),
      );
    });

    test('retry while unresolved refreshes detection but does NOT recreate '
        'or increment the episode', () {
      final existing = <String, dynamic>{
        'type': 'route_deviation',
        'status': 'active',
        'episodeCount': 1,
        'createdAt': 'ORIGINAL_TS',
      };
      final plan = planDeviationWrite(
        existing: existing,
        context: _ctx,
        latitude: 14.6,
        longitude: 121.0,
        distanceMeters: 1300,
      );
      expect(plan.action, IncidentAction.updateActive);
      expect(plan.data.containsKey('episodeCount'), isFalse); // not touched
      expect(plan.data.containsKey('status'), isFalse); // stays active
      expect(plan.serverTimestampFields, isNot(contains('createdAt')));

      final after = _apply(existing, plan);
      expect(after['episodeCount'], 1); // unchanged
      expect(after['status'], 'active');
      expect(after['createdAt'], 'ORIGINAL_TS'); // original preserved
      expect(after['distanceMeters'], 1300); // refreshed
    });

    test('reopens a resolved incident and increments the episode count', () {
      final existing = <String, dynamic>{
        'type': 'route_deviation',
        'status': 'resolved',
        'episodeCount': 1,
        'createdAt': 'ORIGINAL_TS',
        'resolutionReason': 'returned_to_route',
      };
      final plan = planDeviationWrite(
        existing: existing,
        context: _ctx,
        latitude: 14.6,
        longitude: 121.0,
        distanceMeters: 900,
      );
      expect(plan.action, IncidentAction.reopen);
      expect(plan.data['status'], 'active');
      expect(plan.data['episodeCount'], 2);
      expect(plan.data['resolutionReason'], isNull); // cleared
      // createdAt must NOT be re-stamped (preserve original creation time).
      expect(plan.serverTimestampFields, isNot(contains('createdAt')));

      final after = _apply(existing, plan);
      expect(after['createdAt'], 'ORIGINAL_TS');
      expect(after['episodeCount'], 2);
      expect(after['status'], 'active');
    });

    test('rejects a malformed/missing identity locally', () {
      const bad = RouteDeviationContext(orderId: '', riderUid: '');
      expect(
        () => planDeviationWrite(
          existing: null,
          context: bad,
          latitude: 1,
          longitude: 1,
          distanceMeters: 1,
        ),
        throwsArgumentError,
      );
    });
  });

  group('planReturnWrite', () {
    test('resolves the same incident with returned_to_route', () {
      final existing = <String, dynamic>{
        'type': 'route_deviation',
        'status': 'active',
        'episodeCount': 1,
      };
      final plan = planReturnWrite(
        existing: existing,
        context: _ctx,
        latitude: 14.6,
        longitude: 121.0,
        distanceMeters: 11,
        accuracyMeters: 5,
      );
      expect(plan.action, IncidentAction.resolve);
      expect(plan.data['status'], 'resolved');
      expect(plan.data['resolutionReason'], 'returned_to_route');
      expect(plan.data['distanceMeters'], 11);
      expect(
        plan.serverTimestampFields,
        containsAll(<String>['resolvedAt', 'updatedAt']),
      );
    });

    test('is a safe no-op when no incident exists (no return-only alert)', () {
      final plan = planReturnWrite(existing: null, context: _ctx);
      expect(plan.action, IncidentAction.noop);
      expect(plan.data, isEmpty);
      expect(plan.serverTimestampFields, isEmpty);
    });

    test('rejects a malformed/missing identity locally', () {
      const bad = RouteDeviationContext(orderId: 'o', riderUid: '   ');
      expect(bad.isValid, isFalse);
      expect(
        () => planReturnWrite(existing: <String, dynamic>{}, context: bad),
        throwsArgumentError,
      );
    });
  });

  test('ordered deviation -> return -> deviation yields episode 2 '
      '(serialization contract)', () {
    // The screen serializes writes; the data layer relies on each plan being
    // computed from the latest applied state. Walk that ordered progression.
    var doc = _apply(
      null,
      planDeviationWrite(
        existing: null,
        context: _ctx,
        latitude: 14.6,
        longitude: 121.0,
        distanceMeters: 1124,
      ),
    );
    expect(doc['status'], 'active');
    expect(doc['episodeCount'], 1);
    final firstCreatedAt = doc['createdAt'];

    doc = _apply(
      doc,
      planReturnWrite(existing: doc, context: _ctx, distanceMeters: 11),
    );
    expect(doc['status'], 'resolved');
    expect(doc['resolutionReason'], 'returned_to_route');
    expect(doc['episodeCount'], 1); // still one episode so far

    doc = _apply(
      doc,
      planDeviationWrite(
        existing: doc,
        context: _ctx,
        latitude: 14.7,
        longitude: 121.1,
        distanceMeters: 800,
      ),
    );
    expect(doc['status'], 'active');
    expect(doc['episodeCount'], 2); // genuine new deviation reopened it
    expect(doc['createdAt'], firstCreatedAt); // original creation preserved
  });
}
