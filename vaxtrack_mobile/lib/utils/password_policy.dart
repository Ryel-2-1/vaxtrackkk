/// The rider account password rules, applied when a rider applies for an
/// account (RegisterScreen). Sign-in never applies them: an existing account
/// keeps working with the password it has.
///
/// The rules are checked here so the rider sees each one met or not as they
/// type. Firebase Authentication itself only requires 6 characters; enforcing
/// the same rules server-side is a Firebase console setting (Authentication →
/// Settings → Password policy), not something the app can do.
library;

/// Minimum and maximum length. 8 is the floor for a memorised secret
/// (NIST SP 800-63B); 128 keeps a pasted value from being absurd.
const int kPasswordMinLength = 8;
const int kPasswordMaxLength = 128;

/// Passwords seen in breach lists and guessing dictionaries that would still
/// pass the character rules. Compared case-insensitively.
const Set<String> kCommonPasswords = {
  'password1', 'password123', 'passw0rd', 'p@ssw0rd', 'qwerty123', 'qwerty1234',
  'abc12345', 'abcd1234', 'abcd12345', 'admin123', 'welcome1', 'welcome123',
  'iloveyou1', 'letmein1', '12345678a', '1q2w3e4r', '1qaz2wsx', 'aa123456',
  'asdf1234', 'zxcv1234', 'vaxtrack1', 'vaxtrack123', 'rider123', 'rider1234',
  'philippines1', 'manila123', 'changeme1', 'test1234', 'password1!', 'Password1',
};

enum PasswordRule {
  length,
  lowercase,
  uppercase,
  number,
  noEdgeSpaces,
  notPersonal,
  notCommon,
}

/// Rider-facing wording for each rule (shown as a checklist).
const Map<PasswordRule, String> kPasswordRuleLabels = {
  PasswordRule.length: 'At least $kPasswordMinLength characters',
  PasswordRule.lowercase: 'A lowercase letter (a–z)',
  PasswordRule.uppercase: 'An uppercase letter (A–Z)',
  PasswordRule.number: 'A number (0–9)',
  PasswordRule.noEdgeSpaces: 'No spaces at the start or end',
  PasswordRule.notPersonal: "Doesn't contain your name or email",
  PasswordRule.notCommon: 'Not a commonly used password',
};

/// How strong a password that meets every rule is, for the meter.
enum PasswordStrength { weak, fair, good, strong }

class PasswordAssessment {
  /// Every rule with whether it is met.
  final Map<PasswordRule, bool> rules;
  final PasswordStrength strength;

  const PasswordAssessment(this.rules, this.strength);

  bool get isValid => rules.values.every((ok) => ok);

  /// The first unmet rule's wording, for a single error line.
  String? get firstProblem {
    for (final e in rules.entries) {
      if (!e.value) return 'Password needs: ${kPasswordRuleLabels[e.key]!.toLowerCase()}.';
    }
    return null;
  }
}

/// Check [password] against every rule. [email] and [fullName] feed the
/// "not personal" rule: the email's local part and each name word of 3+
/// letters must not appear in the password (case-insensitive).
PasswordAssessment assessPassword(String password, {String email = '', String fullName = ''}) {
  final lower = password.toLowerCase();
  final personal = <String>{
    ...email.split('@').first.toLowerCase().split(RegExp(r'[^a-z0-9]+')),
    ...fullName.toLowerCase().split(RegExp(r'[^a-z]+')),
  }.where((part) => part.length >= 3);

  final rules = <PasswordRule, bool>{
    PasswordRule.length:
        password.length >= kPasswordMinLength && password.length <= kPasswordMaxLength,
    PasswordRule.lowercase: RegExp(r'[a-z]').hasMatch(password),
    PasswordRule.uppercase: RegExp(r'[A-Z]').hasMatch(password),
    PasswordRule.number: RegExp(r'[0-9]').hasMatch(password),
    PasswordRule.noEdgeSpaces: password.isNotEmpty && password.trim() == password,
    PasswordRule.notPersonal: password.isNotEmpty && !personal.any(lower.contains),
    PasswordRule.notCommon: password.isNotEmpty &&
        !kCommonPasswords.any((common) => common.toLowerCase() == lower),
  };

  final allMet = rules.values.every((ok) => ok);
  final hasSymbol = RegExp(r'[^A-Za-z0-9]').hasMatch(password);
  final PasswordStrength strength;
  if (!allMet) {
    strength = PasswordStrength.weak;
  } else if (password.length >= 14 && hasSymbol) {
    strength = PasswordStrength.strong;
  } else if (password.length >= 12 || hasSymbol) {
    strength = PasswordStrength.good;
  } else {
    strength = PasswordStrength.fair;
  }
  return PasswordAssessment(rules, strength);
}

const Map<PasswordStrength, String> kPasswordStrengthLabels = {
  PasswordStrength.weak: 'Too weak',
  PasswordStrength.fair: 'Fair',
  PasswordStrength.good: 'Good',
  PasswordStrength.strong: 'Strong',
};
