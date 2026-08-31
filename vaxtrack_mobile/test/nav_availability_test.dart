import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/models/delivery.dart';
import 'package:vaxtrack_mobile/utils/nav_availability.dart';

Delivery _mk({
  required String status,
  double? lat,
  double? lng,
  String address = '123 Clinic St',
}) {
  return Delivery(
    id: 'order1',
    orderNumber: 'VT-ORD-1',
    clinicName: 'Clinic',
    clinicAddress: address,
    vaccineName: 'Vax',
    quantity: 1,
    unit: 'vials',
    priority: 'Standard',
    status: status,
    statusLabel: status,
    clinicLat: lat,
    clinicLng: lng,
  );
}

void main() {
  group('NavigationAvailability — status matrix (coords + address present)', () {
    // status -> (embedded, external, monitor). Only in_transit enables anything.
    const cases = <String, bool>{
      'assigned': false,
      'loading': false,
      'in_transit': true,
      'delayed': false,
      'delivered': false,
      'cancelled': false,
    };

    cases.forEach((status, enabled) {
      test('$status => embedded/external/monitor = $enabled', () {
        final n = NavigationAvailability.of(
          _mk(status: status, lat: 14.6, lng: 121.0),
        );
        expect(n.canStartEmbeddedNav, enabled, reason: 'embedded ($status)');
        expect(n.canOpenExternalMaps, enabled, reason: 'external ($status)');
        expect(n.canMonitorRoute, enabled, reason: 'monitor ($status)');
      });
    });
  });

  group('NavigationAvailability — in_transit data requirements', () {
    test('in_transit + coords: all enabled, no address search', () {
      final n = NavigationAvailability.of(
        _mk(status: 'in_transit', lat: 14.6, lng: 121.0),
      );
      expect(n.inTransit, isTrue);
      expect(n.canStartEmbeddedNav, isTrue);
      expect(n.canOpenExternalMaps, isTrue);
      expect(n.canMonitorRoute, isTrue);
      expect(n.usesAddressSearch, isFalse);
    });

    test('in_transit, no coords, has address: only external Maps (address search)', () {
      final n = NavigationAvailability.of(
        _mk(status: 'in_transit', lat: null, lng: null, address: '1 Rizal Ave'),
      );
      expect(n.canStartEmbeddedNav, isFalse);
      expect(n.canMonitorRoute, isFalse);
      expect(n.canOpenExternalMaps, isTrue);
      expect(n.usesAddressSearch, isTrue);
    });

    test('in_transit, no coords, empty address: nothing available', () {
      final n = NavigationAvailability.of(
        _mk(status: 'in_transit', lat: null, lng: null, address: ''),
      );
      expect(n.canStartEmbeddedNav, isFalse);
      expect(n.canMonitorRoute, isFalse);
      expect(n.canOpenExternalMaps, isFalse);
      expect(n.usesAddressSearch, isFalse);
    });

    test('in_transit, no coords, whitespace-only address: treated as empty', () {
      final n = NavigationAvailability.of(
        _mk(status: 'in_transit', lat: null, lng: null, address: '   '),
      );
      expect(n.canOpenExternalMaps, isFalse);
      expect(n.usesAddressSearch, isFalse);
    });
  });

  group('NavigationAvailability — status normalization (owned by Delivery)', () {
    test('non-normalized "In-Transit" is treated as in_transit', () {
      final d = Delivery.fromFirestore('id', {
        'status': 'In-Transit',
        'clinicName': 'Clinic',
        'clinicAddress': 'Addr',
        'clinicLat': 14.6,
        'clinicLng': 121.0,
      });
      final n = NavigationAvailability.of(d);
      expect(n.inTransit, isTrue);
      expect(n.canStartEmbeddedNav, isTrue);
    });

    test('" in transit " (spaces) normalizes to in_transit', () {
      final d = Delivery.fromFirestore('id', {
        'status': ' in transit ',
        'clinicName': 'Clinic',
        'clinicAddress': 'Addr',
        'clinicLat': 14.6,
        'clinicLng': 121.0,
      });
      final n = NavigationAvailability.of(d);
      expect(n.inTransit, isTrue);
      expect(n.canMonitorRoute, isTrue);
    });
  });

  group('NavigationAvailability — status prompt (helper-text selection)', () {
    test('assigned -> "Set … before starting navigation."', () {
      final n = NavigationAvailability.of(
        _mk(status: 'assigned', lat: 14.6, lng: 121.0),
      );
      expect(n.statusPrompt,
          'Set this delivery to In Transit before starting navigation.');
    });

    test('loading -> "Set … before starting navigation."', () {
      final n = NavigationAvailability.of(
        _mk(status: 'loading', lat: 14.6, lng: 121.0),
      );
      expect(n.statusPrompt,
          'Set this delivery to In Transit before starting navigation.');
    });

    test('delayed -> "Return … before resuming navigation."', () {
      final n = NavigationAvailability.of(
        _mk(status: 'delayed', lat: 14.6, lng: 121.0),
      );
      expect(n.statusPrompt,
          'Return this delivery to In Transit before resuming navigation.');
    });

    test('in_transit -> no prompt (actions are shown)', () {
      final n = NavigationAvailability.of(
        _mk(status: 'in_transit', lat: 14.6, lng: 121.0),
      );
      expect(n.statusPrompt, isNull);
    });
  });

  group('NavigationAvailability — terminal statuses expose no active action', () {
    for (final status in const ['delivered', 'cancelled']) {
      test('$status: no nav actions and no lifecycle prompt', () {
        final n = NavigationAvailability.of(
          _mk(status: status, lat: 14.6, lng: 121.0),
        );
        expect(n.canStartEmbeddedNav, isFalse);
        expect(n.canOpenExternalMaps, isFalse);
        expect(n.canMonitorRoute, isFalse);
        expect(n.statusPrompt, isNull);
      });
    }
  });
}
