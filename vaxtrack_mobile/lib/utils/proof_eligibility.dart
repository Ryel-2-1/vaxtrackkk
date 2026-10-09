/// Which deliveries may be offered for "Submit Proof & Complete Delivery", and
/// what the Proof screen should do with a selected document id.
///
/// The Proof screen used to list every in-transit order AND every delivered
/// one, so a rider could pick a completed delivery and try to add evidence to
/// it. Submission is now offered only for orders that can still legally be
/// completed. A delivered order's evidence stays visible read-only elsewhere,
/// never as a submission choice.
///
/// Eligibility uses the canonical lifecycle (Delivery.status is already
/// normalized, and [Delivery.canComplete] comes from order_workflow.dart's
/// rider transition table) — never the label shown on screen. The assignment
/// check is an EXACT uid comparison, like the rules and the callable.
///
/// This is screen-side filtering. It is NOT the protection: the completion
/// callable re-checks the assignment and status, the rules refuse evidence on a
/// closed order, and the submission controller re-reads the order before it
/// uploads anything.
library;

import '../models/delivery.dart';

/// Why a delivery is not offered for proof submission.
enum ProofIneligibility {
  /// No such order among this rider's deliveries (missing, or never theirs).
  notFound,

  /// Assigned to a different rider (e.g. reassigned while open).
  notAssignedToYou,

  /// Delivered — the proof-and-completion workflow is finished.
  completed,

  /// Cancelled by the dispatcher.
  cancelled,

  /// Reported as failed; the dispatcher decides what happens next.
  failed,

  /// Not yet out for delivery (assigned / loading) or otherwise not at a
  /// stage that can be completed.
  notReady,
}

/// Null when [order] may take proof and be completed by [riderUid] now.
ProofIneligibility? proofIneligibility(Delivery? order, {required String? riderUid}) {
  if (order == null) return ProofIneligibility.notFound;
  final uid = riderUid ?? '';
  if (uid.isEmpty || order.assignedRiderId != uid) {
    return ProofIneligibility.notAssignedToYou;
  }
  if (order.isDelivered) return ProofIneligibility.completed;
  if (order.isCancelled) return ProofIneligibility.cancelled;
  if (order.isDeliveryFailed) return ProofIneligibility.failed;
  if (!order.canComplete) return ProofIneligibility.notReady;
  return null;
}

/// The submission selector's choices: this rider's completable deliveries.
List<Delivery> proofEligibleOrders(
  Iterable<Delivery> deliveries, {
  required String? riderUid,
}) =>
    deliveries
        .where((d) => proofIneligibility(d, riderUid: riderUid) == null)
        .toList(growable: false);

/// A rider-facing sentence for [reason].
String proofIneligibilityMessage(ProofIneligibility reason) {
  switch (reason) {
    case ProofIneligibility.completed:
      return 'This delivery has already been completed. Its proof can be '
          'viewed under Completed deliveries.';
    case ProofIneligibility.cancelled:
      return 'This delivery was cancelled, so proof can no longer be submitted.';
    case ProofIneligibility.failed:
      return 'This delivery was reported as failed. Your dispatcher will decide '
          'what happens next.';
    case ProofIneligibility.notAssignedToYou:
      return 'This delivery is no longer assigned to you.';
    case ProofIneligibility.notReady:
      return 'This delivery is not out for delivery yet, so it cannot be '
          'completed.';
    case ProofIneligibility.notFound:
      return 'This delivery could not be found in your assigned deliveries.';
  }
}

/// What the Proof screen shows for the current selection.
class ProofSelection {
  const ProofSelection({
    required this.eligible,
    required this.selectedId,
    this.selected,
    this.blockedReason,
  });

  /// The selector's choices.
  final List<Delivery> eligible;

  /// The Firestore document id the screen was asked to show (null = none yet).
  final String? selectedId;

  /// The selected delivery, only when it is eligible right now.
  final Delivery? selected;

  /// Set when [selectedId] names a delivery that is NOT eligible. The screen
  /// says why and offers no submission — it never falls back to another order.
  final ProofIneligibility? blockedReason;

  bool get hasSelection => selectedId != null;
}

/// Resolve [selectedId] — a Firestore DOCUMENT id, never an order number or a
/// list position — against the rider's live deliveries.
ProofSelection resolveProofSelection({
  required Iterable<Delivery> deliveries,
  required String? riderUid,
  required String? selectedId,
}) {
  final all = deliveries.toList(growable: false);
  final eligible = proofEligibleOrders(all, riderUid: riderUid);
  if (selectedId == null) {
    return ProofSelection(eligible: eligible, selectedId: null);
  }
  Delivery? match;
  for (final d in all) {
    if (d.id == selectedId) {
      match = d;
      break;
    }
  }
  final reason = proofIneligibility(match, riderUid: riderUid);
  return ProofSelection(
    eligible: eligible,
    selectedId: selectedId,
    selected: reason == null ? match : null,
    blockedReason: reason,
  );
}

/// Order numbers that appear on more than one eligible delivery. Their items
/// also show a short document reference so they stay distinguishable.
Set<String> duplicateOrderNumbers(Iterable<Delivery> deliveries) {
  final seen = <String>{};
  final dupes = <String>{};
  for (final d in deliveries) {
    if (!seen.add(d.orderNumber)) dupes.add(d.orderNumber);
  }
  return dupes;
}

/// A short, stable reference for a document id ("Ref …a1b2c3").
String shortDocumentRef(String docId) =>
    docId.length <= 6 ? docId : docId.substring(docId.length - 6);
