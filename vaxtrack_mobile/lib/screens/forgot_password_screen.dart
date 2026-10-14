import 'dart:async';

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import '../utils/password_reset.dart';

/// "Reset password" — asks Firebase to email the rider a reset link.
///
/// The screen never says whether an account exists: every accepted request
/// ends on the same confirmation ([kPasswordResetSentMessage]). It does not
/// sign the rider in; "Back to sign in" returns to the login screen.
class ForgotPasswordScreen extends StatefulWidget {
  const ForgotPasswordScreen({
    super.key,
    required this.sendReset,
    this.initialEmail = '',
    this.clock,
  });

  /// Sends one request for a normalized, validated email.
  final PasswordResetSender sendReset;

  /// The email already typed on the login screen, if any.
  final String initialEmail;

  /// Test hook for the resend cooldown.
  final DateTime Function()? clock;

  @override
  State<ForgotPasswordScreen> createState() => _ForgotPasswordScreenState();
}

class _ForgotPasswordScreenState extends State<ForgotPasswordScreen> {
  late final TextEditingController _emailController;
  late final PasswordResetController _reset;
  Timer? _cooldownTicker;

  @override
  void initState() {
    super.initState();
    _emailController = TextEditingController(text: widget.initialEmail.trim());
    _reset = PasswordResetController(
      send: widget.sendReset,
      initialEmail: widget.initialEmail,
      clock: widget.clock,
    )..addListener(_onResetChanged);
  }

  void _onResetChanged() {
    if (!mounted) return;
    if (_reset.isSent && _reset.resendWait > Duration.zero) _startCooldownTicker();
    setState(() {});
  }

  // Repaints the "Resend in Ns" label once a second until resending is allowed.
  void _startCooldownTicker() {
    _cooldownTicker?.cancel();
    _cooldownTicker = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted || _reset.resendWait == Duration.zero) timer.cancel();
      if (mounted) setState(() {});
    });
  }

  Future<void> _submit() async {
    FocusScope.of(context).unfocus();
    await _reset.submit(_emailController.text);
  }

  Future<void> _resend() async {
    await _reset.resend();
  }

  void _backToSignIn() => Navigator.of(context).maybePop();

  @override
  void dispose() {
    _cooldownTicker?.cancel();
    _reset.removeListener(_onResetChanged);
    // A request still in flight completes into a disposed controller, which
    // ignores it: no setState and no message after this screen is gone.
    _reset.dispose();
    _emailController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Reset password')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 24, 24, 32),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 480),
              child: _reset.isSent ? _buildSent(context) : _buildForm(context),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildForm(BuildContext context) {
    final sending = _reset.isSending;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          header: true,
          child: const Text(
            'Reset password',
            style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: AppColors.textDark),
          ),
        ),
        const SizedBox(height: 8),
        const Text(
          'Enter the email address connected to your VaxTrack account. '
          "We'll send instructions for creating a new password.",
          style: TextStyle(fontSize: 14, height: 1.4, color: AppColors.textMedium),
        ),
        const SizedBox(height: 24),
        TextField(
          key: const Key('resetEmailField'),
          controller: _emailController,
          enabled: !sending,
          keyboardType: TextInputType.emailAddress,
          textInputAction: TextInputAction.send,
          autocorrect: false,
          enableSuggestions: false,
          autofillHints: const [AutofillHints.email],
          onChanged: (_) => _reset.emailChanged(),
          onSubmitted: (_) => _submit(),
          decoration: InputDecoration(
            labelText: 'Email',
            prefixIcon: const Icon(Icons.email_outlined),
            errorText: _reset.fieldError,
            errorMaxLines: 3,
          ),
        ),
        if (_reset.requestError != null) ...[
          const SizedBox(height: 16),
          _MessageBox(text: _reset.requestError!, error: true),
        ],
        const SizedBox(height: 24),
        ElevatedButton(
          key: const Key('sendResetButton'),
          onPressed: sending ? null : _submit,
          style: ElevatedButton.styleFrom(minimumSize: const Size(48, 48)),
          child: sending
              ? Semantics(
                  label: 'Sending reset link',
                  child: const SizedBox(
                    height: 20,
                    width: 20,
                    child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2),
                  ),
                )
              : const Text('Send reset link', textAlign: TextAlign.center),
        ),
        const SizedBox(height: 8),
        TextButton(
          key: const Key('cancelResetButton'),
          onPressed: sending ? null : _backToSignIn,
          style: TextButton.styleFrom(
            foregroundColor: AppColors.primaryDark,
            minimumSize: const Size(48, 48),
          ),
          child: const Text('Cancel', textAlign: TextAlign.center),
        ),
      ],
    );
  }

  Widget _buildSent(BuildContext context) {
    final wait = _reset.resendWait;
    final sending = _reset.isSending;
    final resendLabel = sending
        ? 'Sending…'
        : wait > Duration.zero
            ? 'Resend in ${(wait.inMilliseconds / 1000).ceil()}s'
            : 'Resend';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Icon(Icons.mark_email_read_outlined, size: 48, color: AppColors.primary),
        const SizedBox(height: 16),
        Semantics(
          liveRegion: true,
          child: const Text(
            kPasswordResetSentMessage,
            key: Key('resetSentMessage'),
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 16, height: 1.4, color: AppColors.textDark),
          ),
        ),
        const SizedBox(height: 8),
        const Text(
          "Check your inbox and spam folder. The link opens a page where you can choose a new password, then sign in here.",
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 13, height: 1.4, color: AppColors.textLight),
        ),
        if (_reset.requestError != null) ...[
          const SizedBox(height: 16),
          _MessageBox(text: _reset.requestError!, error: true),
        ],
        const SizedBox(height: 24),
        ElevatedButton(
          key: const Key('backToSignInButton'),
          onPressed: sending ? null : _backToSignIn,
          style: ElevatedButton.styleFrom(minimumSize: const Size(48, 48)),
          child: const Text('Back to sign in', textAlign: TextAlign.center),
        ),
        const SizedBox(height: 8),
        TextButton(
          key: const Key('resendResetButton'),
          onPressed: _reset.canResend && !sending ? _resend : null,
          style: TextButton.styleFrom(
            foregroundColor: AppColors.primaryDark,
            minimumSize: const Size(48, 48),
          ),
          child: Text(resendLabel, textAlign: TextAlign.center),
        ),
      ],
    );
  }
}

class _MessageBox extends StatelessWidget {
  const _MessageBox({required this.text, required this.error});

  final String text;
  final bool error;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      child: Container(
        key: const Key('resetRequestError'),
        width: double.infinity,
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: error ? AppColors.urgentBg : AppColors.primaryBg,
          borderRadius: BorderRadius.circular(10),
        ),
        child: Text(
          text,
          style: TextStyle(color: error ? AppColors.urgent : AppColors.primaryDark, fontSize: 13),
        ),
      ),
    );
  }
}
