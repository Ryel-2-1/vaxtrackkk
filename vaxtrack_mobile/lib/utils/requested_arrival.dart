/// Read-only requested arrival, in Philippine wall-clock time. This is never
/// an ETA, a dispatch instruction, or a reason to block proof/completion.
enum RequestedArrivalMode { anyTime, window, before, exact, unavailable }

class RequestedArrival {
  const RequestedArrival._(
    this.mode, {
    this.startMinute,
    this.endMinute,
    this.timeMinute,
  });

  const RequestedArrival.anyTime() : this._(RequestedArrivalMode.anyTime);
  const RequestedArrival.unavailable()
    : this._(RequestedArrivalMode.unavailable);

  final RequestedArrivalMode mode;
  final int? startMinute;
  final int? endMinute;
  final int? timeMinute;

  /// Missing on legacy orders means no particular time within the requested
  /// day. Malformed data remains visibly unavailable, never a made-up window.
  factory RequestedArrival.fromFirestore(Object? raw) {
    if (raw == null) return const RequestedArrival.anyTime();
    if (raw is! Map) return const RequestedArrival.unavailable();
    if (raw.containsKey('version') && raw['version'] != 1) {
      return const RequestedArrival.unavailable();
    }
    final allowed = switch (raw['mode']) {
      'any_time' => {'version', 'mode'},
      'window' => {'version', 'mode', 'start', 'end'},
      'before' || 'exact' => {'version', 'mode', 'time'},
      _ => <String>{},
    };
    if (allowed.isEmpty || raw.keys.any((key) => !allowed.contains(key))) {
      return const RequestedArrival.unavailable();
    }
    switch (raw['mode']) {
      case 'any_time':
        return const RequestedArrival.anyTime();
      case 'window':
        final start = _minuteOf(raw['start']);
        final end = _minuteOf(raw['end']);
        if (start == null || end == null || end <= start) {
          return const RequestedArrival.unavailable();
        }
        return RequestedArrival._(
          RequestedArrivalMode.window,
          startMinute: start,
          endMinute: end,
        );
      case 'before':
      case 'exact':
        final minute = _minuteOf(raw['time']);
        if (minute == null || (raw['mode'] == 'before' && minute == 0)) {
          return const RequestedArrival.unavailable();
        }
        return RequestedArrival._(
          raw['mode'] == 'before'
              ? RequestedArrivalMode.before
              : RequestedArrivalMode.exact,
          timeMinute: minute,
        );
      default:
        return const RequestedArrival.unavailable();
    }
  }

  String get label => switch (mode) {
    RequestedArrivalMode.anyTime => 'Within the requested day',
    RequestedArrivalMode.window =>
      'Within ${_clock(startMinute!)}–${_clock(endMinute!)}',
    RequestedArrivalMode.before => 'Before ${_clock(timeMinute!)}',
    RequestedArrivalMode.exact => 'Exactly ${_clock(timeMinute!)}',
    RequestedArrivalMode.unavailable => 'unavailable — check order',
  };
}

int? _minuteOf(Object? value) {
  if (value is! String) return null;
  final text = value.trim();
  if (!RegExp(r'^([01][0-9]|2[0-3]):[0-5][0-9]$').hasMatch(text)) {
    return null;
  }
  final parts = text.split(':');
  return int.parse(parts[0]) * 60 + int.parse(parts[1]);
}

String _clock(int minute) {
  if (minute == 0) return '12:00 midnight';
  if (minute == 720) return '12:00 noon';
  final hour = minute ~/ 60;
  final shownHour = hour % 12 == 0 ? 12 : hour % 12;
  final shownMinute = (minute % 60).toString().padLeft(2, '0');
  return '$shownHour:$shownMinute ${hour < 12 ? 'AM' : 'PM'}';
}

/// Calendar date only: never converted to the phone's timezone.
String? _dateLabel(String? iso) {
  if (iso == null || !RegExp(r'^[0-9]{4}-[0-9]{2}-[0-9]{2}$').hasMatch(iso)) {
    return null;
  }
  final parts = iso.split('-').map(int.parse).toList();
  final date = DateTime.utc(parts[0], parts[1], parts[2]);
  if (date.year != parts[0] || date.month != parts[1] || date.day != parts[2]) {
    return null;
  }
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return '${months[date.month - 1]} ${date.day}, ${date.year}';
}

/// Mirrors the web's orderArrivalNote without its "Requested arrival:" prefix.
/// Past requests still display. An Admin's reschedule does not rewrite the
/// Med Rep's original date; actual ETA/lifecycle fields are not inputs here.
String requestedArrivalScheduleLabel({
  required RequestedArrival arrival,
  String? requestedDeliveryDate,
  String? originalRequestedDeliveryDate,
}) {
  if (arrival.mode == RequestedArrivalMode.unavailable) {
    return arrival.label;
  }
  final date =
      _dateLabel(originalRequestedDeliveryDate) ??
      _dateLabel(requestedDeliveryDate);
  if (date == null && arrival.mode == RequestedArrivalMode.anyTime) {
    return 'not specified';
  }
  final prefix = date == null ? '' : '$date · ';
  return '$prefix${arrival.label} (PHT)';
}
