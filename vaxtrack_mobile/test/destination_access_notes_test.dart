import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/models/delivery.dart';

/// The clinic's confirmed-entrance access notes travel with the order
/// (functions/src/policy.js destinationAccessNotes) and are shown to the rider.
void main() {
  test('access notes are read from the order; blank or wrong types are none', () {
    expect(
      Delivery.fromFirestore('o1', {'destinationAccessNotes': 'Side gate on Rizal St.'}).destinationAccessNotes,
      'Side gate on Rizal St.',
    );
    expect(Delivery.fromFirestore('o2', {}).destinationAccessNotes, isNull);
    expect(Delivery.fromFirestore('o3', {'destinationAccessNotes': '   '}).destinationAccessNotes, isNull);
    expect(Delivery.fromFirestore('o4', {'destinationAccessNotes': 42}).destinationAccessNotes, isNull);
  });

  test('the delivery screen shows them under the destination, only when present', () {
    final screen = File('lib/screens/delivery_detail_screen.dart').readAsStringSync().replaceAll('\r\n', '\n');
    final row = screen.substring(screen.indexOf('Widget _destinationRow() {'));
    expect(row, contains('final notes = d.destinationAccessNotes;'));
    expect(row, contains('if (notes != null)'));
    expect(row, contains(r"'Access: $notes'"));
  });
}
