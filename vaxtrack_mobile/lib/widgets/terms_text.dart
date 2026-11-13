import 'package:flutter/material.dart';

import '../utils/terms_agreement.dart';

/// The agreement's wording, shared by the sign-up form and the one-time
/// agreement screen. Lays out as a plain column; its owner scrolls it.
class TermsText extends StatelessWidget {
  const TermsText({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).textTheme;
    final body = theme.bodyMedium?.copyWith(height: 1.5);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(kTermsIntro, style: body),
        for (final section in kTermsSections) ...[
          const SizedBox(height: 14),
          Text(section.heading, style: theme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
          for (final line in section.body) ...[
            const SizedBox(height: 6),
            Text(line, style: body),
          ],
        ],
      ],
    );
  }
}

/// The tick box and its sentence. The whole row toggles it, so it is an easy
/// target on a phone.
class TermsConsentTile extends StatelessWidget {
  const TermsConsentTile({super.key, required this.value, required this.onChanged, this.enabled = true});

  final bool value;
  final ValueChanged<bool> onChanged;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    return CheckboxListTile(
      key: const Key('termsConsent'),
      value: value,
      onChanged: enabled ? (v) => onChanged(v ?? false) : null,
      controlAffinity: ListTileControlAffinity.leading,
      contentPadding: EdgeInsets.zero,
      dense: true,
      title: const Text(kTermsConsentLabel, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
    );
  }
}
