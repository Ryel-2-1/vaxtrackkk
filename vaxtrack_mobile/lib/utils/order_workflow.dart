/// The order delivery lifecycle, as the Rider app sees it.
///
/// This is a deliberate duplicate of vaxtrack-web/src/services/orderWorkflow.js
/// — Dart cannot import that module, and the alternative (letting the app send
/// whatever status a screen felt like) is what this checkpoint exists to stop.
///
/// The two copies are held together by a cross-contract test: the web suite
/// parses the tables below and asserts they match the JavaScript matrices
/// exactly, so a change on one side that is not mirrored fails the build.
///
/// Firestore rules remain the independent authority. This is the client-side
/// guard that stops an illegal write leaving the device in the first place.
library;

/// Every status the system may store.
const List<String> kOrderStatuses = [
  'pending_dispatch',
  'assigned',
  'loading',
  'in_transit',
  'delayed',
  'delivered',
  'cancelled',
];

/// Once an order reaches one of these it can never move again.
const List<String> kTerminalStatuses = ['delivered', 'cancelled'];

const String kActorDispatcher = 'dispatcher';
const String kActorRider = 'rider';

/// Dispatcher authority. Present so the cross-contract test can compare the
/// whole matrix; the Rider app never performs these itself.
const Map<String, List<String>> kDispatcherTransitions = {
  'pending_dispatch': ['assigned', 'cancelled'],
  'assigned': ['loading', 'cancelled'],
  'loading': ['in_transit', 'cancelled'],
  'in_transit': ['cancelled'],
  'delayed': ['cancelled'],
  'delivered': [],
  'cancelled': [],
};

/// Assigned-rider authority. The rider never starts loading or transit —
/// dispatch hands them an order that is already in transit.
const Map<String, List<String>> kRiderTransitions = {
  'pending_dispatch': [],
  'assigned': [],
  'loading': [],
  'in_transit': ['delayed', 'delivered'],
  'delayed': ['in_transit', 'delivered'],
  'delivered': [],
  'cancelled': [],
};

/// Display labels. Stored keys are never renamed, only presented.
const Map<String, String> kStatusLabels = {
  'pending_dispatch': 'Pending Dispatch',
  'assigned': 'Assigned',
  'loading': 'Loading',
  'in_transit': 'In Transit',
  'delayed': 'Delayed',
  'delivered': 'Delivered',
  'cancelled': 'Cancelled',
};

/// A rejected transition. [code] is stable; [message] is written for display.
class WorkflowException implements Exception {
  const WorkflowException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => 'WorkflowException($code): $message';
}

/// Formatting-only normalization: trim, lowercase, fold hyphens/spaces to
/// underscores. Deliberately does NOT map unknown values onto canonical ones —
/// an unrecognised status returns null rather than being quietly rewritten.
String? normalizeStatus(Object? value) {
  if (value is! String) return null;
  final key = value.trim().toLowerCase().replaceAll(RegExp(r'[-\s]+'), '_');
  return kOrderStatuses.contains(key) ? key : null;
}

bool isKnownStatus(Object? value) => normalizeStatus(value) != null;

bool isTerminalStatus(Object? value) {
  final key = normalizeStatus(value);
  return key != null && kTerminalStatuses.contains(key);
}

/// The statuses [actor] may move [fromStatus] to. Always a list.
List<String> allowedTransitions(String actor, Object? fromStatus) {
  final table = actor == kActorDispatcher
      ? kDispatcherTransitions
      : actor == kActorRider
          ? kRiderTransitions
          : null;
  final from = normalizeStatus(fromStatus);
  if (table == null || from == null) return const [];
  return table[from] ?? const [];
}

/// The outcome of a transition check.
class TransitionResult {
  const TransitionResult.ok()
      : allowed = true,
        code = null,
        message = null;
  const TransitionResult.denied(this.code, this.message) : allowed = false;

  final bool allowed;
  final String? code;
  final String? message;
}

/// Whether [actor] may move an order from [fromStatus] to [toStatus].
///
/// Same-status writes are rejected: a status change that changes nothing is not
/// a lifecycle event.
TransitionResult canTransition(String actor, Object? fromStatus, Object? toStatus) {
  if (actor != kActorDispatcher && actor != kActorRider) {
    return const TransitionResult.denied('unknown-actor', 'Unknown actor.');
  }
  final from = normalizeStatus(fromStatus);
  if (from == null) {
    return const TransitionResult.denied(
        'unknown-from-status', "This delivery's current status is not recognised.");
  }
  final to = normalizeStatus(toStatus);
  if (to == null) {
    return const TransitionResult.denied(
        'unknown-to-status', 'That is not a valid delivery status.');
  }
  if (kTerminalStatuses.contains(from)) {
    return TransitionResult.denied('terminal-status',
        'This delivery is already ${kStatusLabels[from]!.toLowerCase()} and cannot change.');
  }
  if (from == to) {
    return const TransitionResult.denied(
        'same-status', 'This delivery is already in this status.');
  }
  final table = actor == kActorDispatcher ? kDispatcherTransitions : kRiderTransitions;
  if (!(table[from] ?? const []).contains(to)) {
    return TransitionResult.denied('transition-not-allowed',
        'A $actor cannot move a delivery from ${kStatusLabels[from]} to ${kStatusLabels[to]}.');
  }
  return const TransitionResult.ok();
}

/// [canTransition], as an assertion.
String assertTransition(String actor, Object? fromStatus, Object? toStatus) {
  final result = canTransition(actor, fromStatus, toStatus);
  if (!result.allowed) {
    throw WorkflowException(result.code!, result.message!);
  }
  return normalizeStatus(toStatus)!;
}

/// Display label for a canonical status; falls back to the raw value.
String statusLabel(Object? value) {
  final key = normalizeStatus(value);
  return key == null ? (value?.toString() ?? '') : kStatusLabels[key]!;
}
