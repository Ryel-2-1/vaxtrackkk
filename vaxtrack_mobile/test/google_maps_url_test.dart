import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/models/delivery.dart';
import 'package:vaxtrack_mobile/utils/google_maps_url.dart';
import 'package:vaxtrack_mobile/utils/nav_availability.dart';
import 'package:vaxtrack_mobile/utils/trip_route.dart';

/// The Rider's external Google Maps hand-off: motorcycle (two-wheeler) mode,
/// opened to navigate, with the destination and ordered waypoints intact.

Delivery _stop(
  String id, {
  int? seq,
  double? lat,
  double? lng,
  String address = '',
  String status = 'in_transit',
}) {
  return Delivery(
    id: id,
    orderNumber: id,
    clinicName: 'Clinic $id',
    clinicAddress: address,
    vaccineName: 'V',
    quantity: 1,
    unit: 'vials',
    priority: 'Standard',
    status: status,
    statusLabel: status,
    clinicLat: lat,
    clinicLng: lng,
    tripId: seq == null ? null : 'trip1',
    stopSequence: seq,
    tripStopCount: 3,
  );
}

/// Every hand-off link the app can produce, single- and multi-stop.
List<Uri> _allLinks() => [
      googleMapsDestinationUrl(14.5995, 120.9842),
      googleMapsMultiStopUrl([_stop('a', seq: 1, lat: 14.55, lng: 121.01)])!,
      googleMapsMultiStopUrl([
        _stop('a', seq: 1, lat: 14.55, lng: 121.01),
        _stop('b', seq: 2, lat: 14.58, lng: 121.02),
        _stop('c', seq: 3, lat: 14.60, lng: 121.03),
      ])!,
    ];

void main() {
  group('travel mode', () {
    test('1. every link asks for travelmode=two-wheeler', () {
      for (final uri in _allLinks()) {
        expect(uri.queryParameters['travelmode'], 'two-wheeler');
        // Literally, too — `-` is unreserved, so it must not be re-encoded.
        expect(uri.toString(), contains('travelmode=two-wheeler'));
      }
    });

    test('2. no link asks for driving', () {
      for (final uri in _allLinks()) {
        expect(uri.queryParameters['travelmode'], isNot('driving'));
        expect(uri.toString(), isNot(contains('driving')));
      }
    });

    test('3. no link uses bicycling', () {
      for (final uri in _allLinks()) {
        expect(uri.toString(), isNot(contains('bicycl')));
      }
      expect(googleMapsTravelMode, 'two-wheeler');
    });

    test('4. dir_action=navigate is present', () {
      for (final uri in _allLinks()) {
        expect(uri.queryParameters['dir_action'], 'navigate');
        expect(uri.toString(), contains('dir_action=navigate'));
      }
    });
  });

  group('destination, waypoints and encoding', () {
    test('5. destination coordinates are exact, and no origin is sent', () {
      final uri = googleMapsDestinationUrl(14.5995, 120.9842);
      expect(uri.queryParameters['destination'], '14.5995,120.9842');
      // Origin omitted → Maps starts from the device (and can navigate).
      expect(uri.queryParameters.containsKey('origin'), isFalse);
      // Negative coordinates survive too.
      expect(
        googleMapsDestinationUrl(-33.8688, 151.2093)
            .queryParameters['destination'],
        '-33.8688,151.2093',
      );
    });

    test('6. ordered multi-stop waypoints are kept in visiting order', () {
      final ordered = orderedTripStops([
        _stop('c', seq: 3, lat: 14.60, lng: 121.03),
        _stop('a', seq: 1, lat: 14.55, lng: 121.01),
        _stop('b', seq: 2, lat: 14.58, lng: 121.02),
      ]);
      final uri = googleMapsMultiStopUrl(ordered)!;
      expect(uri.queryParameters['waypoints'], '14.55,121.01|14.58,121.02');
      expect(uri.queryParameters['destination'], '14.6,121.03');
    });

    test('7. the URL is the universal HTTPS link and is validly encoded', () {
      for (final uri in _allLinks()) {
        expect(uri.scheme, 'https');
        expect(uri.host, 'www.google.com');
        expect(uri.path, '/maps/dir/');
        expect(uri.queryParameters['api'], '1');
        // Google requires `,` and `|` to be percent-encoded.
        final text = uri.toString();
        expect(text, isNot(contains(',')));
        expect(text, isNot(contains('|')));
        expect(text, contains('%2C'));
        // Round-trips to exactly the same parameters.
        expect(Uri.parse(text).queryParameters, uri.queryParameters);
      }
      final multi = _allLinks().last.toString();
      expect(multi, contains('%7C'));
    });

    test('8. a single-stop route has a destination and no waypoints', () {
      final uri =
          googleMapsMultiStopUrl([_stop('a', seq: 1, lat: 14.55, lng: 121.01)])!;
      expect(uri.queryParameters['destination'], '14.55,121.01');
      expect(uri.queryParameters.containsKey('waypoints'), isFalse);
      expect(uri.queryParameters['travelmode'], 'two-wheeler');
      expect(uri.queryParameters['dir_action'], 'navigate');

      // The delivery-detail single-stop link is identical in shape.
      expect(
        googleMapsDestinationUrl(14.55, 121.01).queryParameters,
        uri.queryParameters,
      );
    });

    test('9. a multi-stop route keeps every stop and the motorcycle mode', () {
      final uri = _allLinks().last;
      expect(uri.queryParameters['waypoints']!.split('|'), hasLength(2));
      expect(uri.queryParameters['destination'], '14.6,121.03');
      expect(uri.queryParameters['travelmode'], 'two-wheeler');
      expect(uri.queryParameters['dir_action'], 'navigate');
      expect(googleMapsMultiStopUrl(const []), isNull);
    });
  });

  group('availability and wiring', () {
    test('10. external-navigation availability rules are unchanged', () {
      final pin = NavigationAvailability.of(_stop('p', lat: 14.5, lng: 121.0));
      expect(pin.canOpenExternalMaps, isTrue);
      expect(pin.usesAddressSearch, isFalse);

      final addr = NavigationAvailability.of(_stop('q', address: 'Quezon City'));
      expect(addr.canOpenExternalMaps, isTrue);
      expect(addr.usesAddressSearch, isTrue);

      final none = NavigationAvailability.of(_stop('r'));
      expect(none.canOpenExternalMaps, isFalse);

      final assigned = NavigationAvailability.of(
        _stop('s', lat: 14.5, lng: 121.0, status: 'assigned'),
      );
      expect(assigned.canOpenExternalMaps, isFalse);
    });

    test('no screen builds its own driving link any more', () {
      for (final path in [
        'lib/screens/delivery_detail_screen.dart',
        'lib/screens/dashboard_screen.dart',
        'lib/screens/google_navigation_screen.dart',
        'lib/utils/trip_route.dart',
      ]) {
        final src = File(path).readAsStringSync();
        expect(src, isNot(contains('travelmode=driving')), reason: path);
        expect(src, isNot(contains("'driving'")), reason: path);
        expect(src, isNot(contains('/maps/dir/?api=1')), reason: path);
      }
      expect(
        File('lib/screens/delivery_detail_screen.dart').readAsStringSync(),
        contains('googleMapsDestinationUrl(d.clinicLat!, d.clinicLng!)'),
      );
      expect(
        File('lib/screens/google_navigation_screen.dart').readAsStringSync(),
        contains('googleMapsDestinationUrl(widget.clinicLat, widget.clinicLng)'),
      );
    });

    test('the manual motorcycle hint sits beside both hand-off buttons', () {
      expect(motorcycleModeNote, contains('motorcycle'));
      expect(motorcycleModeNote.length, lessThan(100), reason: 'keep it short');
      for (final path in [
        'lib/screens/delivery_detail_screen.dart',
        'lib/screens/dashboard_screen.dart',
      ]) {
        expect(
          File(path).readAsStringSync(),
          contains('motorcycleModeNote'),
          reason: path,
        );
      }
    });
  });
}
