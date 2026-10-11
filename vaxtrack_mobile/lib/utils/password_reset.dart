
import 'package:flutter/foundation.dart';

/// Rider "Forgot password" — everything except the Firebase call itself.
///
/// Firebase-free so it can be tested without a Firebase app: email
/// normalization and validation, the mapping from Firebase error codes to the
/// messages a rider sees, and the controller behind the reset screen.
///
/// Privacy: the screen must never reveal whether an account exists. Firebase
/// reports `user-not-found` for an unregistered address (when email
/// enumeration protection is off), so that code — and `user-disabled`, which
/// equally proves the account exists — is treated exactly like a successful
/// send: the rider always sees [kPasswordResetSentMessage].

/// Shown after every accepted request, whether or not the account exists.
const String kPasswordResetSentMessage =
    'If an account exists for that email, password-reset instructions have been sent.';

const String kResetEmailRequiredMessage = 'Enter your email address.';
const String kResetEmailInvalidMessage = 'Enter a valid email address.';
const String kResetTooManyRequestsMessage =
    'Too many reset attempts. Wait a few minutes and try again.';
const String kResetOfflineMessage =
    'You appear to be offline. Check your connection and try again.';
const String kResetUnavailableMessage =
    'Password reset is temporarily unavailable. Contact your administrator.';
const String kResetUnknownMessage =
    "We couldn't send the reset instructions. Please try again.";

/// How long "Resend" stays disabled after a request was accepted.
const Duration kPasswordResetResendCooldown = Duration(seconds: 30);

/// Leading/trailing whitespace only. The characters of the address itself are
/// never changed — no lower-casing, no removal of dots or `+tags`.
String normalizeResetEmail(String raw) => raw.trim();

final RegExp _basicEmail = RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$');

/// A message when [normalizedEmail] cannot be submitted, otherwise null.
String? validateResetEmail(String normalizedEmail) {
  if (normalizedEmail.isEmpty) return kResetEmailRequiredMessage;
  if (!_basicEmail.hasMatch(normalizedEmail)) return kResetEmailInvalidMessage;
  return null;
}

/// The result of one reset request, as the rider may see it.
class PasswordResetOutcome {
  /// True when the request was accepted — including the privacy-masked
  /// "no such account" case.
  final bool accepted;

  /// The rider-facing message for a failure; null when [accepted].
  final String? errorMessage;

  const PasswordResetOutcome._(this.accepted, this.errorMessage);

  static const PasswordResetOutcome sent = PasswordResetOutcome._(true, null);

  const PasswordResetOutcome.failed(String message) : this._(false, message);

  @override
  String toString() => accepted ? 'PasswordResetOutcome.sent' : 'PasswordResetOutcome.failed';
}

/// Maps a Firebase Auth error code to the outcome the rider sees. Never uses
/// Firebase's own message text.
PasswordResetOutcome passwordResetOutcomeForCode(String code) {
  switch (code) {
    // Account existence is never disclosed.
    case 'user-not-found':
    case 'user-disabled':
      return PasswordResetOutcome.sent;
    case 'invalid-email':
    case 'missing-email':
      return const PasswordResetOutcome.failed(kResetEmailInvalidMessage);
    case 'too-many-requests':
      return const PasswordResetOutcome.failed(kResetTooManyRequestsMessage);
    case 'network-request-failed':
      return const PasswordResetOutcome.failed(kResetOfflineMessage);
    case 'operation-not-allowed':
      return const PasswordResetOutcome.failed(kResetUnavailableMessage);
    default:
      return const PasswordResetOutcome.failed(kResetUnknownMessage);
  }
}

/// Sends one reset request for an already normalized, validated email.
typedef PasswordResetSender = Future<PasswordResetOutcome> Function(String email);

enum PasswordResetStatus { editing, sending, sent }

/// State behind the reset screen.
///
///  * validates before anything is sent;
///  * sends at most ONE request at a time — repeated taps while one is in
///    flight are ignored;
///  * keeps the email the rider typed when sending fails;
///  * after an accepted request, allows a resend only once the cooldown ends;
///  * never notifies after [dispose], so a request that completes after the
///    screen closed changes nothing.
class PasswordResetController extends ChangeNotifier {
  PasswordResetController({
    required PasswordResetSender send,
    String initialEmail = '',
    DateTime Function()? clock,
    this.cooldown = kPasswordResetResendCooldown,
  })  : _send = send,
        _clock = clock ?? DateTime.now,
        email = initialEmail.trim();

  final PasswordResetSender _send;
  final DateTime Function() _clock;
  final Duration cooldown;

  /// The email as last submitted (normalized) or as prefilled.
  String email;
  PasswordResetStatus status = PasswordResetStatus.editing;

  /// A validation problem with the typed email.
  String? fieldError;

  /// A failure reported by the reset request.
  String? requestError;

  DateTime? _resendAllowedAt;
  bool _disposed = false;

  bool get isSending => status == PasswordResetStatus.sending;
  bool get isSent => status == PasswordResetStatus.sent;

  /// Time left before "Resend" is allowed; zero when it is.
  Duration get resendWait {
    final at = _resendAllowedAt;
    if (at == null) return Duration.zero;
    final left = at.difference(_clock());
    return left.isNegative ? Duration.zero : left;
  }

  bool get canResend => isSent && resendWait == Duration.zero;

  /// Validates [rawEmail] and, if valid, sends one request. Returns false when
  /// nothing was sent (invalid input, or a request already in flight).
  Future<bool> submit(String rawEmail) async {
    if (_disposed || isSending) return false;
    final normalized = normalizeResetEmail(rawEmail);
    email = normalized;
    final invalid = validateResetEmail(normalized);
    if (invalid != null) {
      fieldError = invalid;
      requestError = null;
      _notify();
      return false;
    }
    return _run(normalized);
  }

  /// Sends again to the same address, once the cooldown has passed.
  Future<bool> resend() async {
    if (_disposed || !canResend) return false;
    return _run(email);
  }

  /// Back to the form (e.g. to correct the address after a send).
  void editAgain() {
    if (_disposed || isSending) return;
    status = PasswordResetStatus.editing;
    _notify();
  }

  /// The rider changed the email; clears messages about the previous value.
  void emailChanged() {
    if (_disposed || (fieldError == null && requestError == null)) return;
    fieldError = null;
    requestError = null;
    _notify();
  }

  Future<bool> _run(String normalized) async {
    final previous = status;
    status = PasswordResetStatus.sending;
    fieldError = null;
    requestError = null;
    _notify();

    PasswordResetOutcome outcome;
    try {
      outcome = await _send(normalized);
    } catch (_) {
      // The sender maps every Firebase failure itself; anything left over is
      // reported generically — never as raw exception text.
      outcome = const PasswordResetOutcome.failed(kResetUnknownMessage);
    }
    if (_disposed) return outcome.accepted;

    if (outcome.accepted) {
      status = PasswordResetStatus.sent;
      _resendAllowedAt = _clock().add(cooldown);
    } else {
      // A failed RESEND stays on the confirmation; a failed first send
      // returns to the form with the email still filled in.
      status = previous == PasswordResetStatus.sent
          ? PasswordResetStatus.sent
          : PasswordResetStatus.editing;
      requestError = outcome.errorMessage ?? kResetUnknownMessage;
    }
    _notify();
    return outcome.accepted;
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
