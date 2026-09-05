import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/utils/rider_registration.dart';

/// Rider self-registration payload.
///
/// This is the identity boundary: riders create their own accounts, so the
/// fields they must not be able to choose are asserted here. The builder is
/// Firebase-free, so these run without any emulator or mock.
void main() {
  Map<String, Object?> fields({
    String fullName = 'Juan Dela Cruz',
    String email = 'rider@example.test',
    String phone = '09170000000',
    String vehiclePlate = 'ABC 1234',
  }) {
    return buildRiderRegistrationFields(
      fullName: fullName,
      email: email,
      phone: phone,
      vehiclePlate: vehiclePlate,
    );
  }

  group('canonical vehicle type', () {
    test('registration always writes Motorcycle', () {
      expect(kRiderVehicleType, 'Motorcycle');
      expect(fields()['vehicleType'], 'Motorcycle');
    });

    test('vehicle type is not a parameter, so it cannot be overridden', () {
      // The builder takes no vehicleType argument at all: the only way to
      // change what is stored would be to edit this module. A modified UI or a
      // stale controller therefore cannot influence it.
      final a = fields(vehiclePlate: 'AAA 1111');
      final b = fields(vehiclePlate: 'ZZZ 9999');
      expect(a['vehicleType'], 'Motorcycle');
      expect(b['vehicleType'], 'Motorcycle');
    });

    test('a plate that names another vehicle does not change the type', () {
      final result = fields(vehiclePlate: 'VAN 0001');
      expect(result['vehicleType'], 'Motorcycle');
      expect(result['vehiclePlate'], 'VAN 0001', reason: 'plate passes through');
    });
  });

  group('no fabricated identifiers', () {
    test('only the plate the rider typed is stored', () {
      final result = fields(vehiclePlate: '  XYZ 7788  ');
      expect(result['vehiclePlate'], 'XYZ 7788');
    });

    test('an empty plate stays empty rather than being generated', () {
      expect(fields(vehiclePlate: '')['vehiclePlate'], '');
      expect(fields(vehiclePlate: '   ')['vehiclePlate'], '');
    });

    test('no rider, employee or motorcycle identifier is invented', () {
      final result = fields();
      for (final invented in const [
        'riderId',
        'employeeId',
        'motorcycleId',
        'motorcycle',
        'uid',
        'vehicle',
      ]) {
        expect(
          result.containsKey(invented),
          isFalse,
          reason: '$invented must not be fabricated',
        );
      }
    });

    test('the payload carries exactly the expected keys', () {
      expect(
        fields().keys.toList()..sort(),
        <String>[
          'email',
          'fullName',
          'phone',
          'role',
          'status',
          'vehiclePlate',
          'vehicleType',
        ],
      );
    });
  });

  group('role and initial status are restricted', () {
    test('a rider can only ever self-register as a rider', () {
      expect(kRiderRole, 'rider');
      expect(fields()['role'], 'rider');
    });

    test('a rider always starts pending, never approved', () {
      expect(kRiderInitialStatus, 'pending');
      expect(fields()['status'], 'pending');
      expect(fields()['status'], isNot('approved'));
      expect(fields()['status'], isNot('active'));
    });

    test('role and status are not parameters either', () {
      // Same protection as the vehicle type: neither is accepted as input, so
      // no caller can request admin, dispatcher or salesrep, and none can
      // self-approve.
      final result = fields();
      expect(result['role'], 'rider');
      expect(result['status'], 'pending');
    });
  });

  group('operator-supplied fields', () {
    test('are trimmed but otherwise passed through', () {
      final result = fields(
        fullName: '  Maria Santos  ',
        email: '  MARIA@example.test  ',
        phone: '  0917 111 2222  ',
      );
      expect(result['fullName'], 'Maria Santos');
      expect(result['email'], 'MARIA@example.test');
      expect(result['phone'], '0917 111 2222');
    });
  });
}
