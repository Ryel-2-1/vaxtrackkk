/// Field checks for "Apply as a rider" (RegisterScreen). Pure, so each rule is
/// tested without a widget. Each returns null when the value is fine, or the
/// rider-facing message.
library;

final RegExp _email = RegExp(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$");

String? validateFullName(String value) {
  final v = value.trim().replaceAll(RegExp(r'\s+'), ' ');
  if (v.isEmpty) return 'Enter your full name.';
  if (v.length < 4 || !v.contains(' ')) return 'Enter your first and last name.';
  if (v.length > 80) return 'Keep your name under 80 characters.';
  if (!RegExp(r"^[A-Za-zÀ-ÖØ-öø-ÿÑñ .'-]+$").hasMatch(v)) {
    return 'Use letters only (spaces, hyphens and apostrophes are fine).';
  }
  return null;
}

String? validateEmail(String value) {
  final v = value.trim();
  if (v.isEmpty) return 'Enter your email address.';
  if (v.length > 254 || !_email.hasMatch(v)) return 'Enter a valid email address, like juan@example.com.';
  return null;
}

/// A Philippine mobile number as the rider typed it (09XXXXXXXXX, +639XXXXXXXXX
/// or 639XXXXXXXXX, spaces and dashes allowed), or null when it is not one.
/// Stored in the 09XXXXXXXXX form staff dial.
String? normalizePhMobile(String value) {
  final digits = value.replaceAll(RegExp(r'[\s()-]'), '');
  final m = RegExp(r'^(?:\+?63|0)(9\d{9})$').firstMatch(digits);
  return m == null ? null : '0${m.group(1)}';
}

String? validatePhone(String value) {
  if (value.trim().isEmpty) return 'Enter your mobile number.';
  if (normalizePhMobile(value) == null) return 'Enter a PH mobile number, like 0917 123 4567.';
  return null;
}

/// The plate in upper case with single spaces, e.g. "123 ABC" / "AB 1234".
String normalizePlate(String value) =>
    value.trim().toUpperCase().replaceAll(RegExp(r'[\s-]+'), ' ');

/// Philippine motorcycle plates are 2–3 letters and 3–5 digits, in either
/// order (older "1234 AB", newer "123 ABC", "AB 12345"). Conduction stickers
/// and temporary plates vary, so the rule only bounds the shape.
String? validatePlate(String value) {
  final v = normalizePlate(value);
  if (v.isEmpty) return 'Enter your motorcycle plate number.';
  final compact = v.replaceAll(' ', '');
  if (compact.length < 4 || compact.length > 8 || !RegExp(r'^[A-Z0-9]+$').hasMatch(compact) ||
      !RegExp(r'[A-Z]').hasMatch(compact) || !RegExp(r'[0-9]').hasMatch(compact)) {
    return 'Enter the plate as shown, like 123 ABC.';
  }
  return null;
}

String? validatePasswordConfirmation(String password, String confirmation) {
  if (confirmation.isEmpty) return 'Re-enter your password.';
  if (confirmation != password) return "Passwords don't match.";
  return null;
}
