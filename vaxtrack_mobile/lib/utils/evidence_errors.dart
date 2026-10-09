import 'dart:async';
import 'dart:io';

import 'package:firebase_core/firebase_core.dart';

import 'order_workflow.dart';
import 'proof_validation.dart';

/// What kind of failure a proof/invoice Storage or Firestore call hit.
///
/// The proof screen used to show any unexpected error as a connection problem.
/// A Storage `403` (`storage/unauthorized`) is not one: retrying, or moving to
/// better signal, changes nothing, because the server's rules refused the
/// request. Telling a rider to "check your connection" sent them chasing the
/// wrong fault, so the categories are kept apart and each gets its own words.
enum EvidenceErrorKind {
  /// The security rules refused the request — Storage `unauthorized`,
  /// Firestore `permission-denied`.
  permissionDenied,

  /// The request carried no usable credentials (expired session, or a token
  /// the backend would not accept).
  notSignedIn,

  /// The device could not reach the service.
  network,

  /// Anything else.
  other,
}

/// Classify [error] by its stable code, never by its human text where a code
/// exists. Firebase Storage and Cloud Firestore use different codes for the
/// same idea (`unauthorized` vs `permission-denied`), which is precisely how
/// a Storage refusal used to slip past a check written for Firestore.
EvidenceErrorKind classifyEvidenceError(Object error) {
  if (error is FirebaseException) {
    switch (error.code) {
      case 'unauthorized': // Storage: HTTP 403, rules denied the request
      case 'permission-denied': // Firestore
        return EvidenceErrorKind.permissionDenied;
      case 'unauthenticated':
        return EvidenceErrorKind.notSignedIn;
      case 'retry-limit-exceeded': // Storage gave up retrying a dropped link
      case 'unavailable':
      case 'deadline-exceeded':
      case 'network-request-failed':
        return EvidenceErrorKind.network;
    }
    return EvidenceErrorKind.other;
  }
  if (error is WorkflowException) {
    // The completion callable's errors: its domain codes, or Firebase's own
    // transport code when the server was never reached.
    switch (error.code) {
      case 'permission-denied':
      case 'not-assigned-rider':
      case 'wrong-role':
      case 'not-approved':
      case 'profile-missing':
        return EvidenceErrorKind.permissionDenied;
      case 'unauthenticated':
        return EvidenceErrorKind.notSignedIn;
      case 'unavailable':
      case 'deadline-exceeded':
      case 'network-request-failed':
        return EvidenceErrorKind.network;
    }
    return EvidenceErrorKind.other;
  }
  if (error is SocketException || error is TimeoutException) {
    return EvidenceErrorKind.network;
  }
  if (error is ProofException) {
    if (error.code == 'unavailable') return EvidenceErrorKind.network;
    if (error.code == 'permission-denied') {
      return EvidenceErrorKind.permissionDenied;
    }
    return EvidenceErrorKind.other;
  }
  // Last resort for errors that arrive as text only.
  final text = error.toString();
  if (text.contains('permission-denied') || text.contains('unauthorized')) {
    return EvidenceErrorKind.permissionDenied;
  }
  if (text.contains('unauthenticated')) return EvidenceErrorKind.notSignedIn;
  if (text.contains('unavailable') || text.contains('network')) {
    return EvidenceErrorKind.network;
  }
  return EvidenceErrorKind.other;
}

/// The rider-facing message when checking for an earlier proof upload fails.
String recoveryCheckMessage(Object error) {
  switch (classifyEvidenceError(error)) {
    case EvidenceErrorKind.permissionDenied:
      return 'Access to this delivery\'s proof photos was refused (permission '
          'denied). This is not a connection problem, so retrying will not '
          'help. If the delivery was reassigned, go back and refresh; '
          'otherwise report it to your dispatcher with the order number.';
    case EvidenceErrorKind.notSignedIn:
      return 'Your sign-in could not be verified for proof photos. Sign out '
          'and sign in again; if it keeps happening, tell your dispatcher.';
    case EvidenceErrorKind.network:
      return 'Could not check for an earlier upload. Check your connection '
          'and try again.';
    case EvidenceErrorKind.other:
      return 'Could not check for an earlier upload. Please try again.';
  }
}
