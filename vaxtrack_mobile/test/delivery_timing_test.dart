import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/intl.dart';
import 'package:vaxtrack_mobile/models/delivery.dart';
import 'package:vaxtrack_mobile/utils/delivery_timing.dart';

/// The Rider's view of the server's automatic delivery timing: secondary to
/// the lifecycle, never merged with the Rider-reported hold, honest about
/// unknowns, and never a reason an in-transit order cannot be completed.
void main() {
  final expected = DateTime(2026, 10, 17, 18, 30);
  final deadline = DateTime(2026, 10, 17, 18, 40);
  String t(DateTime d) => DateFormat('h:mm a').format(d);

  DeliveryTimingDisplay? show({
    String status = 'in_transit',
    String? timing = 'on_time',
    bool clearTimes = false,
    required DateTime now,
  }) =>
      deliveryTimingDisplay(
        status: status,
        timingStatus: timing,
        expectedArrivalAt: clearTimes ? null : expected,
        automaticDelayedAt: clearTimes ? null : deadline,
        now: now,
      );

  test('in transit: on time / at risk / automatically delayed wording', () {
    final onTime = show(now: DateTime(2026, 10, 17, 18, 0))!;
    expect(onTime.combinedLabel, 'In Transit');
    expect(onTime.detail, 'Expected by ${t(expected)}');
    expect(onTime.onHold, isFalse);
    final risk = show(timing: 'at_risk', now: DateTime(2026, 10, 17, 18, 33))!;
    expect(risk.combinedLabel, 'In Transit — At Risk');
    expect(risk.detail, 'At risk — grace period ends at ${t(deadline)}');
    final late = show(timing: 'delayed', now: DateTime(2026, 10, 17, 18, 42))!;
    expect(late.combinedLabel, 'In Transit — Automatically delayed');
    expect(late.label, 'Automatically delayed');
    expect(late.tone, TimingTone.late);
    expect(late.detail, 'Delayed by 12 minutes (expected by ${t(expected)})');
    expect(show(timing: 'delayed', now: DateTime(2026, 10, 17, 18, 31))!.detail,
        'Delayed by 1 minute (expected by ${t(expected)})');
  });

  test('the Rider-reported hold is never confused with automatic lateness', () {
    final hold = show(status: 'delayed', now: DateTime(2026, 10, 17, 18, 0))!;
    expect(hold.onHold, isTrue);
    expect(hold.combinedLabel, 'Delayed — $kHoldLabel');
    expect(kHoldLabel, 'Rider-reported hold');
    final both = show(status: 'delayed', timing: 'delayed', now: DateTime(2026, 10, 17, 18, 50))!;
    expect(both.combinedLabel, 'Delayed — Rider-reported hold · also behind schedule');
    expect(both.label, 'Automatically delayed');
    final autoOnly = show(timing: 'delayed', now: DateTime(2026, 10, 17, 18, 50))!;
    expect(autoOnly.combinedLabel.toLowerCase().contains('hold'), isFalse);
  });

  test("the server's condition is shown; the phone clock never changes it", () {
    expect(show(now: DateTime(2026, 10, 17, 23, 0))!.label, 'On time');
    expect(show(timing: 'delayed', now: DateTime(2026, 10, 17, 17, 0))!.label, 'Automatically delayed');
  });

  test('nothing to show for closed or not-yet-dispatched orders, or legacy orders', () {
    for (final s in ['delivered', 'delivery_failed', 'cancelled', 'assigned', 'loading']) {
      expect(show(status: s, timing: 'delayed', now: DateTime(2026, 10, 17, 19)), isNull, reason: s);
    }
    expect(show(timing: null, now: DateTime(2026, 10, 17, 19)), isNull);
    expect(show(status: 'delayed', timing: null, now: DateTime(2026, 10, 17, 19)), isNull);
    expect(show(timing: 'bogus', now: DateTime(2026, 10, 17, 19)), isNull);
  });

  test('no route ETA at dispatch: neutral Timing unavailable, invents no time', () {
    for (final d in [
      show(timing: 'unknown', clearTimes: true, now: DateTime(2026, 10, 17, 19))!,
      show(timing: 'at_risk', clearTimes: true, now: DateTime(2026, 10, 17, 19))!,
    ]) {
      expect(d.status, 'unknown');
      expect(d.label, 'Timing unavailable');
      expect(d.detail, 'No route ETA at dispatch');
      expect(d.combinedLabel, 'In Transit');
      expect(RegExp(r'\d:\d\d').hasMatch(d.detail), isFalse);
    }
  });

  test('Delivery parses the timing fields; a legacy order has none and stays completable', () {
    final base = <String, dynamic>{
      'orderNumber': 'VT-1',
      'status': 'in_transit',
      'clinicName': 'Clinic',
      'vaccineName': 'V',
      'quantity': 5,
    };
    final timed = Delivery.fromFirestore('o1', {
      ...base,
      'timingStatus': 'delayed',
      'expectedArrivalAt': Timestamp.fromDate(expected),
      'automaticDelayedAt': Timestamp.fromDate(deadline),
    });
    expect(timed.timingStatus, 'delayed');
    expect(timed.expectedArrivalAt, expected);
    expect(timed.automaticDelayedAt, deadline);
    expect(timed.status, 'in_transit', reason: 'automatic lateness is not the lifecycle');
    final legacy = Delivery.fromFirestore('o2', base);
    expect([legacy.timingStatus, legacy.expectedArrivalAt, legacy.automaticDelayedAt], [null, null, null]);
    expect(legacy.status, 'in_transit');
  });
}
