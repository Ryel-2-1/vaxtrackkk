import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/utils/order_mapping.dart';

/// Per-document isolation contract.
///
/// The production failure this pins: every order was normalized inside one
/// `.map()`, so a single unreadable document threw out of the whole snapshot
/// and the rider saw NO deliveries — the valid orders assigned to them were
/// hidden by the broken one.
///
/// These tests use the pure [mapOrderEntries] rather than a faked
/// `QuerySnapshot`, so no Firestore mocking dependency is needed.

/// A well-formed order document.
Map<String, dynamic> _valid({
  required String clinic,
  required int quantity,
  required DateTime createdAt,
}) =>
    <String, dynamic>{
      'orderNumber': 'VT-ORD-$quantity',
      'clinicName': clinic,
      'clinicAddress': '1 Example Street',
      'vaccineName': 'Example Vaccine',
      'quantity': quantity,
      'status': 'in_transit',
      'createdAt': Timestamp.fromDate(createdAt),
    };

/// A document whose normalization THROWS: `lastLocation` is read as
/// `data['lastLocation'] as GeoPoint?`, so a string there is a hard type-cast
/// failure — the shape of real legacy corruption.
Map<String, dynamic> _malformed(DateTime createdAt) => <String, dynamic>{
      'orderNumber': 'VT-ORD-BAD',
      'clinicName': 'Broken Clinic',
      'quantity': 7,
      'status': 'in_transit',
      'lastLocation': 'not-a-geopoint',
      'createdAt': Timestamp.fromDate(createdAt),
    };

void main() {
  // Newest first: order-c (newest), order-a, order-b (oldest).
  final newest = DateTime.utc(2026, 9, 3, 12);
  final middle = DateTime.utc(2026, 9, 2, 12);
  final oldest = DateTime.utc(2026, 9, 1, 12);

  group('mapOrderEntries — a malformed order beside valid ones', () {
    late OrderMappingResult result;

    setUp(() {
      // Valid / malformed / valid — the malformed one in the MIDDLE, so a
      // failure cannot be mistaken for "stopped at the first bad entry".
      result = mapOrderEntries(<OrderEntry>[
        (id: 'order-a', data: _valid(clinic: 'Alpha Clinic', quantity: 10, createdAt: middle)),
        (id: 'order-bad', data: _malformed(newest)),
        (id: 'order-b', data: _valid(clinic: 'Beta Clinic', quantity: 25, createdAt: oldest)),
      ]);
    });

    test('does not throw — the subscription is never terminated', () {
      expect(
        () => mapOrderEntries(<OrderEntry>[
          (id: 'order-bad', data: _malformed(newest)),
        ]),
        returnsNormally,
      );
    });

    test('both valid orders survive', () {
      expect(result.deliveries, hasLength(2));
      expect(
        result.deliveries.map((d) => d.clinicName),
        containsAll(<String>['Alpha Clinic', 'Beta Clinic']),
      );
    });

    test('only the malformed order is excluded', () {
      expect(result.malformed, hasLength(1));
      expect(result.malformed.single.id, 'order-bad');
      expect(
        result.deliveries.map((d) => d.id),
        isNot(contains('order-bad')),
      );
    });

    test('document ids are preserved on the survivors', () {
      expect(result.deliveries.map((d) => d.id), <String>['order-a', 'order-b']);
    });

    test('ordering is preserved (newest createdAt first)', () {
      final ids = result.deliveries.map((d) => d.id).toList();
      expect(ids, <String>['order-a', 'order-b']); // middle before oldest
    });

    test('no replacement order is invented for the malformed document', () {
      // Exactly the two real orders — no placeholder, no "Unknown Clinic"
      // stand-in occupying the missing slot.
      expect(result.deliveries, hasLength(2));
      expect(
        result.deliveries.map((d) => d.clinicName),
        isNot(contains('Broken Clinic')),
      );
      expect(
        result.deliveries.map((d) => d.orderNumber),
        isNot(contains('VT-ORD-BAD')),
      );
    });

    test('the failure is reported by id, with the error retained', () {
      expect(result.malformed.single.id, 'order-bad');
      expect(result.malformed.single.error, isNotNull);
    });
  });

  group('mapOrderEntries — surrounding behaviour', () {
    test('an all-valid batch is unaffected and sorted newest-first', () {
      final result = mapOrderEntries(<OrderEntry>[
        (id: 'order-a', data: _valid(clinic: 'Alpha', quantity: 1, createdAt: oldest)),
        (id: 'order-c', data: _valid(clinic: 'Gamma', quantity: 2, createdAt: newest)),
        (id: 'order-b', data: _valid(clinic: 'Beta', quantity: 3, createdAt: middle)),
      ]);
      expect(result.malformed, isEmpty);
      expect(result.deliveries.map((d) => d.id),
          <String>['order-c', 'order-b', 'order-a']);
    });

    test('an all-malformed batch yields no deliveries but still returns', () {
      final result = mapOrderEntries(<OrderEntry>[
        (id: 'bad-1', data: _malformed(newest)),
        (id: 'bad-2', data: _malformed(oldest)),
      ]);
      expect(result.deliveries, isEmpty);
      expect(result.malformed.map((m) => m.id), <String>['bad-1', 'bad-2']);
    });

    test('an empty batch is empty, not an error', () {
      final result = mapOrderEntries(const <OrderEntry>[]);
      expect(result.deliveries, isEmpty);
      expect(result.malformed, isEmpty);
    });

    test('a string quantity is normalized, not treated as malformed', () {
      // Guards the two repairs against each other: the quantity fix means this
      // document is now READABLE, so isolation must not quarantine it.
      final result = mapOrderEntries(<OrderEntry>[
        (
          id: 'order-str',
          data: <String, dynamic>{
            'clinicName': 'Staging Health Clinic',
            'quantity': '10',
            'status': 'in_transit',
          }
        ),
      ]);
      expect(result.malformed, isEmpty);
      expect(result.deliveries.single.quantity, 10);
    });
  });
}
