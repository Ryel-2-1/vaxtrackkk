import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../utils/terms_agreement.dart';
import '../widgets/skeleton.dart';
import '../widgets/terms_text.dart';

/// Lets [child] through once this rider has agreed to the current Terms of
/// Use and Data Privacy Agreement; otherwise shows the one-time agreement
/// screen. Riders who applied in the app already agreed on the sign-up form;
/// this catches accounts from before the agreement existed, and everyone again
/// when the wording changes (kTermsVersion).
///
/// It watches the rider's own users/{uid}: agreeing writes the acceptance
/// there, and the same listener then shows [child]. If the record cannot be
/// read (no signal), [child] is shown — the sign-in gate above has already
/// established who this is, and a rider must not be locked out of deliveries.
class TermsGate extends StatelessWidget {
  const TermsGate({super.key, required this.uid, required this.child});

  final String uid;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<DocumentSnapshot<Map<String, dynamic>>>(
      stream: FirebaseFirestore.instance.collection('users').doc(uid).snapshots(),
      builder: (context, snap) {
        if (snap.hasError) return child;
        if (!snap.hasData) return const SkeletonHome();
        if (hasAcceptedCurrentTerms(snap.data!.data())) return child;
        return TermsAgreementScreen(uid: uid);
      },
    );
  }
}

class TermsAgreementScreen extends StatefulWidget {
  const TermsAgreementScreen({super.key, required this.uid});

  final String uid;

  @override
  State<TermsAgreementScreen> createState() => _TermsAgreementScreenState();
}

class _TermsAgreementScreenState extends State<TermsAgreementScreen> {
  bool _ticked = false;
  bool _saving = false;
  String? _error;

  Future<void> _agree() async {
    if (_saving) return;
    if (!_ticked) {
      setState(() => _error = kTermsRequiredMessage);
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await FirebaseFirestore.instance.collection('users').doc(widget.uid).update({
        'termsAcceptedVersion': kTermsVersion,
        'termsAcceptedAt': FieldValue.serverTimestamp(),
      }).timeout(const Duration(seconds: 20));
      // The gate's listener now shows the app; nothing to do here.
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Your agreement could not be saved. Check your connection and try again.');
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Semantics(
                header: true,
                child: Text(
                  kTermsTitle,
                  style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700, color: AppColors.textDark),
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                'Please read and agree before you continue. You only need to do this once.',
                style: TextStyle(color: AppColors.textLight, fontSize: 14),
              ),
              const SizedBox(height: 12),
              Expanded(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: AppColors.surface,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: const Color(0xFFE2E8F0)),
                  ),
                  child: const Scrollbar(
                    child: SingleChildScrollView(
                      padding: EdgeInsets.all(14),
                      child: TermsText(),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 6),
              TermsConsentTile(
                value: _ticked,
                enabled: !_saving,
                onChanged: (v) => setState(() {
                  _ticked = v;
                  _error = null;
                }),
              ),
              if (_error != null)
                Semantics(
                  liveRegion: true,
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Text(_error!, style: const TextStyle(color: AppColors.urgent, fontSize: 13)),
                  ),
                ),
              SizedBox(
                height: 52,
                child: ElevatedButton(
                  key: const Key('termsAgree'),
                  onPressed: _saving ? null : _agree,
                  child: Text(_saving ? 'Saving…' : 'Agree and continue'),
                ),
              ),
              TextButton(
                onPressed: _saving ? null : () => FirebaseAuth.instance.signOut(),
                child: const Text('Sign out'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
