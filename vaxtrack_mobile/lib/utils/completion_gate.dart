/// Pure readiness check for the Rider "Complete Delivery" confirmation.
///
/// Completing a delivery runs the trusted, irreversible inventory-settling
/// callable, so the screen must not open its confirmation — let alone reach the
/// server — until this says the delivery is ready. Every input is a plain value
/// the screen already has, so the whole decision is unit-testable without a
/// widget, a device or Firebase. It imports NOTHING from Flutter, Firebase or
/// dart:io.
///
/// This is early, FAIL-CLOSED feedback only: the Firestore rules and the
/// completion callable remain the independent authority (the assigned-rider
/// check and the status lifecycle are re-enforced server-side). Nothing here
/// uploads or mutates anything.
library;

/// Why a completion cannot proceed. `none` means it may.
enum CompletionBlock {
  none,
  inProgress,
  invalidOrderId,
  unauthenticated,
  missingAssignment,
  assignmentMismatch,
  unconfirmed,
  notEligible,
  missingProof,
  missingInvoice,
}

/// Stable, machine-readable codes — never parsed from the message.
const Map<CompletionBlock, String> kCompletionBlockCodes = {
  CompletionBlock.none: 'ready',
  CompletionBlock.inProgress: 'in-progress',
  CompletionBlock.invalidOrderId: 'invalid-order-id',
  CompletionBlock.unauthenticated: 'unauthenticated',
  CompletionBlock.missingAssignment: 'missing-assignment',
  CompletionBlock.assignmentMismatch: 'assignment-mismatch',
  CompletionBlock.unconfirmed: 'refresh-required',
  CompletionBlock.notEligible: 'status-not-eligible',
  CompletionBlock.missingProof: 'missing-proof',
  CompletionBlock.missingInvoice: 'missing-invoice',
};

/// The outcome of [evaluateCompletionReadiness].
class CompletionReadiness {
  const CompletionReadiness(this.block, this.message);

  final CompletionBlock block;

  /// A rider-facing sentence for a block, or null when [ready].
  final String? message;

  bool get ready => block == CompletionBlock.none;

  /// The stable reason code for [block].
  String get code => kCompletionBlockCodes[block]!;

  /// The block is an identity problem (order id, session or assignment). These
  /// are checked before anything about the delivery itself.
  bool get isIdentityFailure =>
      block == CompletionBlock.invalidOrderId ||
      block == CompletionBlock.unauthenticated ||
      block == CompletionBlock.missingAssignment ||
      block == CompletionBlock.assignmentMismatch;

  /// True when the block is a missing photo, so the screen can offer to open the
  /// Proof of Delivery screen rather than only showing a message.
  bool get isMissingEvidence =>
      block == CompletionBlock.missingProof ||
      block == CompletionBlock.missingInvoice;
}

bool _blank(String? value) => value == null || value.trim().isEmpty;

/// Decide whether the rider may open the completion confirmation.
///
/// Checked in priority order so the rider is told the single most relevant
/// reason, and so identity is settled BEFORE any status or evidence check:
///
///   in progress → order id → session → assignment present → assignment match
///   → data confirmed → status → proof photo → invoice photo.
///
/// [orderId]          the order's Firestore document id.
/// [currentRiderId]   the signed-in rider's uid.
/// [assignedRiderId]  the order's assigned rider uid.
/// [dataConfirmed]    false when the latest authoritative reload FAILED, so the
///                    evidence and status on screen cannot be trusted yet.
/// [statusEligible]   the rider lifecycle allows this order → `delivered`.
/// [hasProof] / [hasInvoice]  the order already carries each photo URL.
/// [completionInProgress]     a completion request is already running.
///
/// The assignment comparison is EXACT, mirroring the server and the rules:
/// a padded or partial id is a different id, and a mismatch fails closed.
CompletionReadiness evaluateCompletionReadiness({
  required String? orderId,
  required String? currentRiderId,
  required String? assignedRiderId,
  required bool statusEligible,
  required bool hasProof,
  required bool hasInvoice,
  required bool completionInProgress,
  bool dataConfirmed = true,
}) {
  if (completionInProgress) {
    return const CompletionReadiness(
      CompletionBlock.inProgress,
      'This delivery is already being completed.',
    );
  }
  if (_blank(orderId)) {
    return const CompletionReadiness(
      CompletionBlock.invalidOrderId,
      'This delivery has an invalid order ID.',
    );
  }
  if (_blank(currentRiderId)) {
    return const CompletionReadiness(
      CompletionBlock.unauthenticated,
      'Your session has expired. Sign in again.',
    );
  }
  if (_blank(assignedRiderId)) {
    return const CompletionReadiness(
      CompletionBlock.missingAssignment,
      'This delivery is not assigned to a Rider.',
    );
  }
  if (assignedRiderId != currentRiderId) {
    return const CompletionReadiness(
      CompletionBlock.assignmentMismatch,
      'This delivery is assigned to another Rider.',
    );
  }
  if (!dataConfirmed) {
    return const CompletionReadiness(
      CompletionBlock.unconfirmed,
      'Could not confirm the latest delivery details. Check your connection '
          'and try again.',
    );
  }
  if (!statusEligible) {
    return const CompletionReadiness(
      CompletionBlock.notEligible,
      'This delivery is not at a stage where it can be completed.',
    );
  }
  if (!hasProof) {
    return const CompletionReadiness(
      CompletionBlock.missingProof,
      'Add the proof-of-delivery photo before completing this delivery.',
    );
  }
  if (!hasInvoice) {
    return const CompletionReadiness(
      CompletionBlock.missingInvoice,
      'Add the invoice photo before completing this delivery.',
    );
  }
  return const CompletionReadiness(CompletionBlock.none, null);
}
