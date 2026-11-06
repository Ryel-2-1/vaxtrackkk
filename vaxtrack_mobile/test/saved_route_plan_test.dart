import 'dart:convert';
import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/models/delivery.dart';
import 'package:vaxtrack_mobile/utils/saved_route_plan.dart';

/// The fixture is shared with the server
/// (vaxtrack-web/functions/test/savedRoutePlanContract.test.js).
final Map<String, dynamic> _fixture =
    jsonDecode(File('test/fixtures/saved_route_plan_cases.json').readAsStringSync())
        as Map<String, dynamic>;

const _timeFields = {'routeGeneratedAt', 'tripGeneratedAt', 'assignedAt', 'destinationCorrectedAt'};

Map<String, dynamic> _orderData(Map<String, dynamic> spec) {
  final polylines = _fixture['polylines'] as Map<String, dynamic>;
  final data = <String, dynamic>{};
  for (final entry in spec.entries) {
    final key = entry.key;
    final value = entry.value;
    if (key == '@verified' || key == '@verifiedTrip') {
      data.addAll((_fixture[key.substring(1)] as Map<String, dynamic>));
    } else if (value is String && value.startsWith('@')) {
      data[key] = polylines[value.substring(1)];
    } else if (_timeFields.contains(key)) {
      data[key] = Timestamp.fromMillisecondsSinceEpoch(value as int);
    } else {
      data[key] = value;
    }
  }
  return data;
}

void main() {
  group('the VaxTrack plan is the route deviation is measured against', () {
    for (final raw in _fixture['cases'] as List<dynamic>) {
      final c = raw as Map<String, dynamic>;
      test(c['name'] as String, () {
        final plan = SavedRoutePlan.of(
          Delivery.fromFirestore('o1', _orderData(c['order'] as Map<String, dynamic>)),
        );
        final expected = c['expect'] as Map<String, dynamic>;
        expect(plan.usable, expected['available']);
        expect(plan.source.name, expected['source']);
        if (expected['available'] == true) {
          expect(plan.points.length, greaterThanOrEqualTo(2));
          expect(plan.motorcycleChecked, expected['checked']);
          expect(plan.fingerprint, isNotNull);
        } else {
          expect(kRoutePlanProblemCodes[plan.problem], expected['reason']);
          expect(plan.points, isEmpty, reason: 'an unusable route is never drawn');
          expect(plan.motorcycleChecked, isFalse, reason: 'nothing is claimed about it');
          expect(plan.fingerprint, isNull);
        }
      });
    }
  });

  test('labels claim only what was checked, and say which route it is', () {
    Delivery order(Map<String, dynamic> extra) => Delivery.fromFirestore('o1', {
          'routePolyline': '_p~iF~ps|U_ulLnnqC',
          'routeGeneratedAt': Timestamp.fromMillisecondsSinceEpoch(2000),
          'assignedAt': Timestamp.fromMillisecondsSinceEpoch(1000),
          ...extra,
        });
    final checked = SavedRoutePlan.of(order(_fixture['verified'] as Map<String, dynamic>));
    expect(checked.label, startsWith('VaxTrack plan (this delivery)'));
    expect(checked.label, contains('checked for highway, toll road and ferry flags'));
    final older = SavedRoutePlan.of(order({'routeProvider': 'openrouteservice'}));
    expect(older.label, contains('not checked for motorcycles'));
    for (final plan in [checked, older]) {
      expect(plan.label.toLowerCase(), isNot(contains('safe')));
      expect(plan.label.toLowerCase(), isNot(contains('compliant')));
      expect(plan.label, isNot(contains('Google')));
    }
    final missing = SavedRoutePlan.of(Delivery.fromFirestore('o1', const {}));
    expect(missing.label, contains('Ask dispatch'));
    expect(kRoutePlanProblemMessages.keys.toSet(), RoutePlanProblem.values.toSet());
  });

  test('a re-planned route has a new fingerprint; the same route keeps it', () {
    Delivery withRoute(String polyline) => Delivery.fromFirestore('o1', {
          'routePolyline': polyline,
          'routeGeneratedAt': Timestamp.fromMillisecondsSinceEpoch(2000),
          'assignedAt': Timestamp.fromMillisecondsSinceEpoch(1000),
        });
    final polylines = _fixture['polylines'] as Map<String, dynamic>;
    final a = SavedRoutePlan.of(withRoute(polylines['leg'] as String));
    final again = SavedRoutePlan.of(withRoute(polylines['leg'] as String));
    final replanned = SavedRoutePlan.of(withRoute(polylines['trip'] as String));
    expect(again.fingerprint, a.fingerprint);
    expect(replanned.fingerprint, isNot(a.fingerprint));
  });
}
