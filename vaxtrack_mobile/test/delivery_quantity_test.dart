import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/models/delivery.dart';

/// Regression cover for the crash that blanked the Rider dashboard.
///
/// Staging order **VT-STG-001** stores `quantity` as the STRING `"10"`, and the
/// old `(data['quantity'] ?? 0).toInt()` threw
/// `NoSuchMethodError: Class 'String' has no instance method 'toInt'.
/// Receiver: "10"` — which escaped the snapshot mapping and hid every other
/// order assigned to that rider.
Delivery _fromQuantity(Object? quantity) => Delivery.fromFirestore(
      'order-1',
      <String, dynamic>{
        'orderNumber': 'VT-STG-001',
        'clinicName': 'Staging Health Clinic',
        'status': 'in_transit',
        'quantity': ?quantity,
      },
    );

void main() {
  group('Delivery.quantity — the reported defect', () {
    test('a string quantity parses instead of throwing', () {
      expect(_fromQuantity('10').quantity, 10);
    });

    test('mapping a string-quantity order does not throw at all', () {
      expect(() => _fromQuantity('10'), returnsNormally);
    });

    test('a padded string quantity parses', () {
      expect(_fromQuantity('  12  ').quantity, 12);
    });

    test('a decimal string truncates rather than crashing', () {
      expect(_fromQuantity('10.9').quantity, 10);
    });
  });

  group('Delivery.quantity — existing valid behaviour preserved', () {
    test('an int passes through unchanged', () {
      expect(_fromQuantity(10).quantity, 10);
    });

    test('a double truncates as before', () {
      expect(_fromQuantity(10.9).quantity, 10);
    });

    test('zero stays zero', () {
      expect(_fromQuantity(0).quantity, 0);
    });

    test('a missing quantity keeps the pre-existing 0 default', () {
      expect(_fromQuantity(null).quantity, 0);
    });
  });

  group('Delivery.quantity — invalid values degrade without inventing', () {
    test('non-numeric text falls back to 0 and does not throw', () {
      expect(_fromQuantity('abc').quantity, 0);
    });

    test('an empty string falls back to 0', () {
      expect(_fromQuantity('').quantity, 0);
    });

    test('a boolean falls back to 0 and does not throw', () {
      expect(_fromQuantity(true).quantity, 0);
    });

    test('infinity does not throw "Infinity or NaN toInt"', () {
      expect(() => _fromQuantity(double.infinity), returnsNormally);
      expect(_fromQuantity(double.infinity).quantity, 0);
    });

    test('NaN does not throw', () {
      expect(_fromQuantity(double.nan).quantity, 0);
    });
  });

  group('Delivery route ints — same non-finite guard', () {
    Delivery withRoute(Object? distance) => Delivery.fromFirestore(
          'order-2',
          <String, dynamic>{
            'status': 'in_transit',
            'quantity': 5,
            'routeDistanceMeters': distance,
          },
        );

    test('a finite value is kept', () {
      expect(withRoute(1234).routeDistanceMeters, 1234);
    });

    test('infinity yields null instead of throwing', () {
      expect(() => withRoute(double.infinity), returnsNormally);
      expect(withRoute(double.infinity).routeDistanceMeters, isNull);
    });

    test('NaN yields null instead of throwing', () {
      expect(withRoute(double.nan).routeDistanceMeters, isNull);
    });
  });
}
