import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/models/delivery.dart';
import 'package:vaxtrack_mobile/utils/requested_arrival.dart';

void main() {
  final fixtures =
      jsonDecode(
            File(
              'test/fixtures/requested_arrival_cases.json',
            ).readAsStringSync(),
          )
          as List<dynamic>;
  final base = <String, dynamic>{
    'orderNumber': 'VT-QA-ARRIVAL',
    'status': 'in_transit',
    'clinicName': 'QA Clinic',
    'vaccineName': 'QA Vaccine',
    'quantity': 2,
    'routeEtaText': '4:00 PM',
    'tripId': 'route-trip',
    'stopSequence': 1,
    'stopEtaText': '3:00 PM',
  };

  for (final raw in fixtures) {
    final fixture = Map<String, dynamic>.from(raw as Map);
    test('web/Rider parity: ${fixture['name']}', () {
      final data = <String, dynamic>{
        ...base,
        ...Map<String, dynamic>.from(fixture['order'] as Map),
      };
      final before = jsonEncode(data);
      final delivery = Delivery.fromFirestore('qa', data);
      expect(delivery.requestedArrivalNote, fixture['expected']);
      expect(jsonEncode(data), before, reason: 'display never edits the order');
      expect(delivery.status, 'in_transit');
      expect(delivery.routeEtaText, data['routeEtaText']);
      expect(delivery.stopEtaText, '3:00 PM');
      expect(delivery.tripId, 'route-trip');
    });
  }

  test('nullable/malformed date fields cannot crash or hide an order', () {
    for (final date in [null, 123, true, <String, dynamic>{}]) {
      final delivery = Delivery.fromFirestore('qa', {
        ...base,
        'requestedDeliveryDate': date,
        'originalRequestedDeliveryDate': date,
      });
      expect(delivery.requestedArrivalNote, 'Requested arrival: not specified');
    }
  });

  test('no global preference leaks between deliveries', () {
    final morning = Delivery.fromFirestore('morning', {
      ...base,
      'requestedArrival': {'mode': 'exact', 'time': '10:00'},
    });
    final afternoon = Delivery.fromFirestore('afternoon', {
      ...base,
      'requestedArrival': {'mode': 'exact', 'time': '15:00'},
    });
    expect(morning.requestedArrivalLabel, 'Exactly 10:00 AM (PHT)');
    expect(afternoon.requestedArrivalLabel, 'Exactly 3:00 PM (PHT)');
    expect(morning.requestedArrivalLabel, 'Exactly 10:00 AM (PHT)');
  });

  test('a malformed preference never changes lifecycle/action eligibility', () {
    for (final status in [
      'assigned',
      'loading',
      'in_transit',
      'delayed',
      'delivery_failed',
      'delivered',
      'cancelled',
    ]) {
      final plain = Delivery.fromFirestore('qa', {...base, 'status': status});
      final malformed = Delivery.fromFirestore('qa', {
        ...base,
        'status': status,
        'requestedArrival': {'mode': 'broken'},
      });
      expect(malformed.status, plain.status);
      expect(malformed.statusLabel, plain.statusLabel);
      expect(malformed.canComplete, plain.canComplete);
      expect(malformed.canSubmitProof, plain.canSubmitProof);
      expect(malformed.canResumeTransit, plain.canResumeTransit);
      expect(malformed.canReportDelay, plain.canReportDelay);
      expect(malformed.canReportFailure, plain.canReportFailure);
    }
  });

  test('backward-compatible constructor has no mandatory new arguments', () {
    final delivery = Delivery(
      id: 'legacy',
      orderNumber: 'VT-LEGACY',
      clinicName: 'Clinic',
      clinicAddress: 'Address',
      vaccineName: 'Vaccine',
      quantity: 1,
      unit: 'vials',
      priority: 'Standard',
      status: 'assigned',
      statusLabel: 'Assigned',
    );
    expect(delivery.requestedArrival.mode, RequestedArrivalMode.anyTime);
    expect(delivery.requestedArrivalNote, 'Requested arrival: not specified');
  });

  test(
    'detail screen presents a read-only request separately from route ETA',
    () {
      final source = File(
        'lib/screens/delivery_detail_screen.dart',
      ).readAsStringSync();
      expect(source, contains('d.requestedArrivalLabel'));
      expect(source, contains('A request for planning, not a guaranteed ETA.'));
    },
  );
}
