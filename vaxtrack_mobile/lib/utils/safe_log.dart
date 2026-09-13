import 'package:flutter/foundation.dart';

/// Diagnostics for suppressed (non-fatal) failures that must never leak
/// delivery content into logs.
///
/// Why this exists: the errors these call sites catch can EMBED the offending
/// value in their message. The crash that motivated this work is the clearest
/// example —
/// `NoSuchMethodError: Class 'String' has no instance method 'toInt'.
/// Receiver: "10"` — where `"10"` is a field copied straight out of a customer
/// order document. Interpolating `$error` into a release log therefore leaks
/// document data by accident, even though no call site ever names a field.
///
/// So the always-on line carries only:
///   * the component and the operation that was skipped,
///   * an opaque Firestore document id where one applies,
///   * the error's TYPE (the safe error category) — never its message.
///
/// The full error and stack trace are printed in DEBUG BUILDS ONLY, where a
/// developer needs the offending value to diagnose the document. Release and
/// profile builds never reach that branch.
void logSuppressedError(
  String component,
  String skipped,
  Object error, [
  StackTrace? stack,
]) {
  debugPrint('$component: $skipped (${error.runtimeType})');
  if (kDebugMode) {
    debugPrint('$component: [debug-only detail] $error');
    if (stack != null) {
      debugPrintStack(stackTrace: stack, label: component);
    }
  }
}
