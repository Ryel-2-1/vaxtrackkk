/// Proof-of-delivery evidence rules, as pure functions.
///
/// This file imports NOTHING from Flutter, Firebase or dart:io, so every rule
/// below is unit-testable without a device, an emulator or a network. The
/// screen, the uploader and the Firestore service all defer to it, which is
/// what keeps the client limits and the deployed rules from drifting apart.
///
/// Firestore and Storage rules remain the independent authority. These are the
/// client-side guards that stop a bad submission leaving the device.
library;

/// Longest recipient name that may be stored.
///
/// Measured in UTF-16 code units (`String.length`) rather than runes, because
/// that is the unit `firestore.rules` counts with `string.size()`. Using runes
/// here would let a name of 120 emoji through the client and then be refused by
/// the rules — an emulator test pins the two together at the boundary.
const int kMaxRecipientNameLength = 120;

/// Evidence size ceiling. Deliberately expressed as a STRICT upper bound to
/// mirror `request.resource.size < 10 * 1024 * 1024` in storage.rules: a file of
/// exactly this many bytes is rejected by both. Keep the two in lockstep.
const int kMaxEvidenceBytes = 10 * 1024 * 1024;

/// The one object name per order, for each kind of evidence.
///
/// Timestamped names were the previous convention and produced a fresh object on
/// every retry, none of which could be deleted (delete is denied to everyone).
/// A deterministic name means a retry overwrites its own failed attempt instead
/// of accumulating orphans, and it lets the rules verify the path.
const String kProofFileName = 'proof.jpg';
const String kInvoiceFileName = 'invoice.jpg';

/// The canonical Storage path for an order's proof photo.
/// [orderId] is the Firestore `orders/` DOCUMENT ID — never an order number.
String proofObjectPath(String orderId) =>
    'proof_of_delivery/$orderId/$kProofFileName';

/// The canonical Storage path for an order's invoice photo.
String invoiceObjectPath(String orderId) =>
    'invoices/$orderId/$kInvoiceFileName';

/// Order statuses from which the assigned rider may submit proof.
///
/// `delivered` is absent on purpose: proof is evidence gathered while the
/// delivery is being made, not something added afterwards. Delivered orders
/// display whatever proof they already have, read-only.
const List<String> kProofSubmittableStatuses = ['in_transit', 'delayed'];

/// A rejected proof operation. [code] is stable and machine-readable; [message]
/// is written to be shown to the rider as-is.
class ProofException implements Exception {
  const ProofException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => 'ProofException($code): $message';
}

/// The outcome of validating one field.
class ProofFieldResult {
  const ProofFieldResult.ok(this.value)
      : valid = true,
        code = null,
        message = null;
  const ProofFieldResult.invalid(this.code, this.message)
      : valid = false,
        value = '';

  final bool valid;

  /// The normalized value to persist. Only meaningful when [valid].
  final String value;
  final String? code;
  final String? message;
}

/// Characters that have no place in a single-line name field: C0/C1 controls
/// plus the Unicode line/paragraph separators. Everything else — letters in any
/// script, marks, spaces, apostrophes, hyphens — is preserved untouched, so
/// "Ma. Luisa Reyes-Cruz", "O'Brien", "Ñoño Dela Peña" and "Ана Петровић" are
/// all ordinary valid names here.
final RegExp _controlChars = RegExp(r'[\x00-\x1F\x7F-\x9F\u2028\u2029]');

/// The person who received the delivery.
///
/// Trimmed before both validation and persistence, so a name of only spaces is
/// refused rather than stored as blank. The length bound is applied to the
/// TRIMMED value, which is what actually gets written.
ProofFieldResult validateRecipientName(Object? value) {
  final trimmed = value is String ? value.trim() : '';
  if (trimmed.isEmpty) {
    return const ProofFieldResult.invalid(
      'recipient-required',
      "Enter the name of the person who received this delivery.",
    );
  }
  if (_controlChars.hasMatch(trimmed)) {
    return const ProofFieldResult.invalid(
      'recipient-invalid-characters',
      'Enter the name on one line, without line breaks.',
    );
  }
  if (trimmed.length > kMaxRecipientNameLength) {
    return const ProofFieldResult.invalid(
      'recipient-too-long',
      'Please keep the name under $kMaxRecipientNameLength characters.',
    );
  }
  return ProofFieldResult.ok(trimmed);
}

/// Whether a selected photo may be uploaded at all.
///
/// Checked BEFORE the network call so an oversized photo fails in a moment with
/// a readable message, instead of after a long upload that the rules then
/// refuse. The boundary is strict-less-than, exactly as storage.rules has it.
ProofFieldResult validateEvidenceSize(int bytes) {
  if (bytes <= 0) {
    return const ProofFieldResult.invalid(
      'evidence-empty',
      'That photo appears to be empty. Please take it again.',
    );
  }
  if (bytes >= kMaxEvidenceBytes) {
    return const ProofFieldResult.invalid(
      'evidence-too-large',
      'That photo is too large (limit 10 MB). Please take it again.',
    );
  }
  return ProofFieldResult.ok('$bytes');
}

/// Content type for an image, derived from its file name.
///
/// The stored object always uses the canonical name, so the extension of the
/// SOURCE file is what tells us the real format. Storage rules require
/// `image/*`; guessing wrong would either be refused or mislabel the object, so
/// unknown extensions fall back to JPEG — what the camera actually produces.
String imageContentTypeFor(String fileName) {
  final lower = fileName.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.heic')) return 'image/heic';
  if (lower.endsWith('.heif')) return 'image/heif';
  return 'image/jpeg';
}
