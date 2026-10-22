/// Display of the server's automatic delivery timing
/// (vaxtrack-web/functions/src/deliveryTiming.js; web mirror
/// src/services/deliveryTiming.js).
///
/// Two things are never merged into one ambiguous "Delayed":
///  * the lifecycle status `delayed` — the Rider-reported hold (proof and
///    completion wait until the rider resumes); and
///  * the schedule condition — on time, at risk or automatically delayed
///    (never blocks proof or completion).
/// An order can be both. The clock keeps running during a hold. The condition
/// shown is the one the SERVER recorded; the phone clock only fills in
/// "delayed by N minutes".
library;

import 'package:intl/intl.dart';

enum TimingTone { onTime, atRisk, late, unknown }

const String kHoldLabel = 'Rider-reported hold';

class DeliveryTimingDisplay {
  final String status;
  final TimingTone tone;
  final String label;
  final String detail;

  /// True for the Rider-reported hold (lifecycle `delayed`).
  final bool onHold;

  /// "In Transit — At Risk", "In Transit — Automatically delayed",
  /// "Delayed — Rider-reported hold", "… · also behind schedule".
  final String combinedLabel;

  const DeliveryTimingDisplay({
    required this.status,
    required this.tone,
    required this.label,
    required this.detail,
    required this.onHold,
    required this.combinedLabel,
  });
}

const Map<String, String> kTimingLabels = {
  'on_time': 'On time',
  'at_risk': 'At risk',
  'delayed': 'Automatically delayed',
  'unknown': 'Timing unavailable',
};

String _time(DateTime t) => DateFormat('h:mm a').format(t.toLocal());
String _minutes(int m) => '$m minute${m == 1 ? '' : 's'}';

String _combined(String lifecycle, String status) {
  if (lifecycle == 'delayed') {
    return status == 'delayed' ? 'Delayed — $kHoldLabel · also behind schedule' : 'Delayed — $kHoldLabel';
  }
  if (status == 'at_risk') return 'In Transit — At Risk';
  if (status == 'delayed') return 'In Transit — Automatically delayed';
  return 'In Transit';
}

/// The timing indicator, or null when there is nothing to show: the order is
/// not in transit or on hold, or it was dispatched before timing existed.
DeliveryTimingDisplay? deliveryTimingDisplay({
  required String status,
  required String? timingStatus,
  required DateTime? expectedArrivalAt,
  required DateTime? automaticDelayedAt,
  required DateTime now,
}) {
  if (status != 'in_transit' && status != 'delayed') return null;
  if (timingStatus == null || !kTimingLabels.containsKey(timingStatus)) return null;
  final expected = expectedArrivalAt;
  final deadline = automaticDelayedAt;
  final onHold = status == 'delayed';
  if (timingStatus == 'unknown' || expected == null || deadline == null) {
    return DeliveryTimingDisplay(
      status: 'unknown',
      tone: TimingTone.unknown,
      label: 'Timing unavailable',
      detail: 'No route ETA at dispatch',
      onHold: onHold,
      combinedLabel: _combined(status, 'unknown'),
    );
  }
  switch (timingStatus) {
    case 'on_time':
      return DeliveryTimingDisplay(
        status: timingStatus,
        tone: TimingTone.onTime,
        label: 'On time',
        detail: 'Expected by ${_time(expected)}',
        onHold: onHold,
        combinedLabel: _combined(status, timingStatus),
      );
    case 'at_risk':
      return DeliveryTimingDisplay(
        status: timingStatus,
        tone: TimingTone.atRisk,
        label: 'At risk',
        detail: 'At risk — grace period ends at ${_time(deadline)}',
        onHold: onHold,
        combinedLabel: _combined(status, timingStatus),
      );
    default:
      final late = now.difference(expected).inMinutes;
      return DeliveryTimingDisplay(
        status: 'delayed',
        tone: TimingTone.late,
        label: 'Automatically delayed',
        detail: late > 0
            ? 'Delayed by ${_minutes(late)} (expected by ${_time(expected)})'
            : 'Delayed (expected by ${_time(expected)})',
        onHold: onHold,
        combinedLabel: _combined(status, 'delayed'),
      );
  }
}
