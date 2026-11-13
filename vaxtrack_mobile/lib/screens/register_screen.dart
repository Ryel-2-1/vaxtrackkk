import '../utils/terms_agreement.dart';
import '../widgets/terms_text.dart';
import 'package:flutter/material.dart';
import '../services/auth_service.dart';
import '../theme/app_branding.dart';
import '../theme/app_theme.dart';
import '../utils/password_policy.dart';
import '../utils/rider_application_validation.dart';

/// "Apply as a rider". Every field is checked as the rider leaves it and again
/// on submit; the password must meet every rule in password_policy.dart (shown
/// as a live checklist). The account starts pending until an admin approves it.
class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key});

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final _authService = AuthService();
  final _formKey = GlobalKey<FormState>();
  final _fullNameController = TextEditingController();
  final _emailController = TextEditingController();
  final _phoneController = TextEditingController();
  final _vehiclePlateController = TextEditingController();
  final _passwordController = TextEditingController();
  final _confirmController = TextEditingController();
  bool _loading = false;
  bool _obscurePassword = true;
  bool _obscureConfirm = true;
  String? _error;
  bool _submitted = false;
  // Terms of Use and Data Privacy agreement: must be ticked to apply.
  bool _agreedToTerms = false;

  @override
  void initState() {
    super.initState();
    // The checklist follows the password, name and email as they are typed.
    for (final c in [_passwordController, _fullNameController, _emailController]) {
      c.addListener(_onTyped);
    }
  }

  void _onTyped() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    for (final c in [_passwordController, _fullNameController, _emailController]) {
      c.removeListener(_onTyped);
    }
    _fullNameController.dispose();
    _emailController.dispose();
    _phoneController.dispose();
    _vehiclePlateController.dispose();
    _passwordController.dispose();
    _confirmController.dispose();
    super.dispose();
  }

  PasswordAssessment get _assessment => assessPassword(
        _passwordController.text,
        email: _emailController.text,
        fullName: _fullNameController.text,
      );

  Future<void> _register() async {
    FocusScope.of(context).unfocus();
    setState(() => _error = null);
    if (!(_formKey.currentState?.validate() ?? false)) {
      setState(() => _error = 'Check the highlighted fields.');
      return;
    }
    if (!_agreedToTerms) {
      setState(() => _error = kTermsRequiredMessage);
      return;
    }

    setState(() => _loading = true);
    try {
      await _authService.registerRider(
        fullName: _fullNameController.text.trim().replaceAll(RegExp(r'\s+'), ' '),
        email: _emailController.text.trim(),
        password: _passwordController.text,
        phone: normalizePhMobile(_phoneController.text)!,
        vehiclePlate: normalizePlate(_vehiclePlateController.text),
      );
      if (mounted) setState(() => _submitted = true);
    } on RegistrationError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) {
        setState(() => _error = 'Registration failed. Please try again.');
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _showTerms() {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.8,
        maxChildSize: 0.95,
        builder: (context, controller) => SingleChildScrollView(
          controller: controller,
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(kTermsTitle, style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
              const SizedBox(height: 10),
              const TermsText(),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_submitted) return _submittedView();

    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(title: const Text('Apply as a rider')),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 460),
              child: Form(
                key: _formKey,
                autovalidateMode: AutovalidateMode.onUserInteraction,
                child: AutofillGroup(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const Row(
                        children: [
                          VaxTrackLogo(size: 48),
                          SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text('Become a VaxTrack rider',
                                    style: TextStyle(fontSize: 19, fontWeight: FontWeight.w800, color: AppColors.textDark)),
                                SizedBox(height: 2),
                                Text('An admin reviews your application before you can sign in.',
                                    style: TextStyle(fontSize: 12.5, color: AppColors.textLight)),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 20),
                      _section('About you', [
                        TextFormField(
                          key: const Key('registerFullName'),
                          controller: _fullNameController,
                          enabled: !_loading,
                          textInputAction: TextInputAction.next,
                          textCapitalization: TextCapitalization.words,
                          autofillHints: const [AutofillHints.name],
                          validator: (v) => validateFullName(v ?? ''),
                          decoration: const InputDecoration(
                            labelText: 'Full name',
                            hintText: 'Juan Dela Cruz',
                            prefixIcon: Icon(Icons.person_outline),
                          ),
                        ),
                        TextFormField(
                          key: const Key('registerPhone'),
                          controller: _phoneController,
                          enabled: !_loading,
                          keyboardType: TextInputType.phone,
                          textInputAction: TextInputAction.next,
                          autofillHints: const [AutofillHints.telephoneNumber],
                          validator: (v) => validatePhone(v ?? ''),
                          decoration: const InputDecoration(
                            labelText: 'Mobile number',
                            hintText: '0917 123 4567',
                            prefixIcon: Icon(Icons.phone_outlined),
                          ),
                        ),
                        TextFormField(
                          key: const Key('registerPlate'),
                          controller: _vehiclePlateController,
                          enabled: !_loading,
                          textInputAction: TextInputAction.next,
                          textCapitalization: TextCapitalization.characters,
                          validator: (v) => validatePlate(v ?? ''),
                          decoration: const InputDecoration(
                            labelText: 'Motorcycle plate number',
                            hintText: '123 ABC',
                            prefixIcon: Icon(Icons.two_wheeler),
                          ),
                        ),
                      ]),
                      const SizedBox(height: 16),
                      _section('Your sign-in', [
                        TextFormField(
                          key: const Key('registerEmail'),
                          controller: _emailController,
                          enabled: !_loading,
                          keyboardType: TextInputType.emailAddress,
                          textInputAction: TextInputAction.next,
                          autocorrect: false,
                          enableSuggestions: false,
                          autofillHints: const [AutofillHints.email],
                          validator: (v) => validateEmail(v ?? ''),
                          decoration: const InputDecoration(
                            labelText: 'Email',
                            hintText: 'you@example.com',
                            prefixIcon: Icon(Icons.email_outlined),
                          ),
                        ),
                        TextFormField(
                          key: const Key('registerPassword'),
                          controller: _passwordController,
                          enabled: !_loading,
                          obscureText: _obscurePassword,
                          textInputAction: TextInputAction.next,
                          autocorrect: false,
                          enableSuggestions: false,
                          autofillHints: const [AutofillHints.newPassword],
                          maxLength: kPasswordMaxLength,
                          validator: (_) => _assessment.firstProblem,
                          decoration: InputDecoration(
                            labelText: 'Password',
                            counterText: '',
                            prefixIcon: const Icon(Icons.lock_outlined),
                            suffixIcon: IconButton(
                              tooltip: _obscurePassword ? 'Show password' : 'Hide password',
                              icon: Icon(_obscurePassword ? Icons.visibility_off : Icons.visibility),
                              onPressed: () => setState(() => _obscurePassword = !_obscurePassword),
                            ),
                          ),
                        ),
                        _PasswordChecklist(assessment: _assessment, started: _passwordController.text.isNotEmpty),
                        TextFormField(
                          key: const Key('registerConfirmPassword'),
                          controller: _confirmController,
                          enabled: !_loading,
                          obscureText: _obscureConfirm,
                          textInputAction: TextInputAction.done,
                          autocorrect: false,
                          enableSuggestions: false,
                          validator: (v) => validatePasswordConfirmation(_passwordController.text, v ?? ''),
                          onFieldSubmitted: (_) => _register(),
                          decoration: InputDecoration(
                            labelText: 'Confirm password',
                            prefixIcon: const Icon(Icons.lock_reset),
                            suffixIcon: IconButton(
                              tooltip: _obscureConfirm ? 'Show password' : 'Hide password',
                              icon: Icon(_obscureConfirm ? Icons.visibility_off : Icons.visibility),
                              onPressed: () => setState(() => _obscureConfirm = !_obscureConfirm),
                            ),
                          ),
                        ),
                      ]),
                      const SizedBox(height: 8),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: TextButton(
                          key: const Key('termsRead'),
                          onPressed: _showTerms,
                          child: const Text('Read the Terms of Use and Data Privacy Agreement'),
                        ),
                      ),
                      TermsConsentTile(
                        value: _agreedToTerms,
                        enabled: !_loading,
                        onChanged: (v) => setState(() {
                          _agreedToTerms = v;
                          if (_error == kTermsRequiredMessage) _error = null;
                        }),
                      ),
                      if (_error != null) ...[
                        const SizedBox(height: 14),
                        Semantics(
                          liveRegion: true,
                          child: Container(
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(color: AppColors.urgentBg, borderRadius: BorderRadius.circular(10)),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Icon(Icons.error_outline, size: 18, color: AppColors.urgent),
                                const SizedBox(width: 8),
                                Expanded(child: Text(_error!, style: const TextStyle(color: AppColors.urgent, fontSize: 13))),
                              ],
                            ),
                          ),
                        ),
                      ],
                      const SizedBox(height: 20),
                      SizedBox(
                        height: 52,
                        child: ElevatedButton(
                          key: const Key('registerSubmit'),
                          onPressed: _loading ? null : _register,
                          child: _loading
                              ? const SizedBox(
                                  height: 20,
                                  width: 20,
                                  child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2),
                                )
                              : const Text('Submit application'),
                        ),
                      ),
                      const SizedBox(height: 8),
                      TextButton(
                        onPressed: _loading
                            ? null
                            : () => Navigator.of(context).pushNamedAndRemoveUntil('/', (route) => false),
                        child: const Text('Already have an account? Sign in'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _section(String title, List<Widget> fields) {
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: AppColors.textMedium)),
          for (final f in fields) ...[const SizedBox(height: 12), f],
        ],
      ),
    );
  }

  Widget _submittedView() {
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(title: const Text('Application sent')),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                children: [
                  const VaxTrackLogo(size: 72),
                  const SizedBox(height: 20),
                  const Text(
                    'Application submitted',
                    style: TextStyle(fontSize: 21, fontWeight: FontWeight.w800, color: AppColors.textDark),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 10),
                  const Text(
                    'A VaxTrack admin will review it. You can sign in with your email and password once it is approved.',
                    style: TextStyle(fontSize: 14, color: AppColors.textLight, height: 1.4),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 24),
                  SizedBox(
                    width: double.infinity,
                    height: 52,
                    child: ElevatedButton(
                      onPressed: () => Navigator.of(context).pushNamedAndRemoveUntil('/', (route) => false),
                      child: const Text('Back to Sign In'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Each password rule, ticked as it is met, plus a strength bar once all are.
class _PasswordChecklist extends StatelessWidget {
  const _PasswordChecklist({required this.assessment, required this.started});

  final PasswordAssessment assessment;
  final bool started;

  @override
  Widget build(BuildContext context) {
    final strength = assessment.strength;
    final level = PasswordStrength.values.indexOf(strength);
    final color = switch (strength) {
      PasswordStrength.weak => AppColors.urgent,
      PasswordStrength.fair => AppColors.warning,
      PasswordStrength.good || PasswordStrength.strong => AppColors.primary,
    };
    return Column(
      key: const Key('passwordChecklist'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (started)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(
              children: [
                for (var i = 0; i < 4; i++) ...[
                  Expanded(
                    child: Container(
                      height: 5,
                      decoration: BoxDecoration(
                        color: i <= level && (i > 0 || assessment.isValid || level == 0) ? color : AppColors.border,
                        borderRadius: BorderRadius.circular(3),
                      ),
                    ),
                  ),
                  if (i < 3) const SizedBox(width: 4),
                ],
                const SizedBox(width: 10),
                Text(kPasswordStrengthLabels[strength]!,
                    style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: color)),
              ],
            ),
          ),
        for (final entry in assessment.rules.entries)
          Padding(
            padding: const EdgeInsets.only(bottom: 3),
            child: Row(
              children: [
                Icon(
                  entry.value ? Icons.check_circle : Icons.radio_button_unchecked,
                  size: 16,
                  color: entry.value ? AppColors.primary : AppColors.textMuted,
                  semanticLabel: entry.value ? 'Met' : 'Not met',
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    kPasswordRuleLabels[entry.key]!,
                    style: TextStyle(fontSize: 12.5, color: entry.value ? AppColors.textMedium : AppColors.textLight),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}
