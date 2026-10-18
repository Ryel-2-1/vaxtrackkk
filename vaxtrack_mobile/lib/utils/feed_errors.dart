import 'evidence_errors.dart';

/// Rider-facing wording for a live Firestore feed that failed (the deliveries
/// list, the rider profile).
///
/// Never the raw error: a Firebase message can carry internal detail (rule
/// paths, document names, status text) that means nothing to a Rider and must
/// not be shown. The category comes from the error's stable code
/// ([classifyEvidenceError]); the raw error goes only to [logSuppressedError].
///
/// [what] names the feed, e.g. 'your deliveries'.
String feedErrorMessage(Object error, {required String what}) {
  switch (classifyEvidenceError(error)) {
    case EvidenceErrorKind.network:
      return 'Could not load $what — no connection. Check your signal, then tap Retry.';
    case EvidenceErrorKind.permissionDenied:
      return 'Could not load $what — your account was refused access. '
          'Sign out and sign in again, or contact your dispatcher.';
    case EvidenceErrorKind.notSignedIn:
      return 'Could not load $what — your session has expired. Sign out and sign in again.';
    case EvidenceErrorKind.other:
      return 'Could not load $what. Tap Retry. If it keeps failing, contact your dispatcher.';
  }
}
