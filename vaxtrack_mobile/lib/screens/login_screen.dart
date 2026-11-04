import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import '../services/auth_service.dart';
import '../theme/app_branding.dart';
import '../theme/app_theme.dart';
import '../utils/password_reset.dart';
import '../utils/rider_application_validation.dart';
import 'forgot_password_screen.dart';

/// Signs the rider in with Firebase Authentication. Role and status are
/// decided afterwards by AuthGate, never here.
typedef RiderSignIn = Future<void> Function(String email, String password);

Future<void> _firebaseSignIn(String email, String password) async {
  await FirebaseAuth.instance.signInWithEmailAndPassword(email: email, password: password).timeout(const Duration(seconds: 30));
}

class LoginScreen extends StatefulWidget {
  /// [signIn] and [sendPasswordReset] default to Firebase; tests pass fakes.
  const LoginScreen({super.key, this.signIn, this.sendPasswordReset});

  final RiderSignIn? signIn;
  final PasswordResetSender? sendPasswordReset;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _loading = false;
  bool _obscurePassword = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    final msg = AuthService.pendingLoginMessage;
    if (msg != null) {
      _error = msg;
      AuthService.pendingLoginMessage = null;
    }
  }

  Future<void> _login() async {
    final email = _emailController.text.trim();
    final password = _passwordController.text;

    if (email.isEmpty || password.isEmpty) {
      setState(() => _error = 'Please enter email and password.');
      return;
    }
    if (validateEmail(email) != null) {
      setState(() => _error = 'Please enter a valid email address.');
      return;
    }

    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      // AuthGate handles role/status validation. LoginScreen only needs
      // to complete the Firebase Auth sign-in; if the user is invalid,
      // AuthGate signs them out and sets AuthService.pendingLoginMessage
      // for the next LoginScreen mount to display.
      await (widget.signIn ?? _firebaseSignIn)(email, password);
      // If this LoginScreen was pushed as a route (e.g. after registration
      // or logout), AuthGate at the root decides where to go next — pop back
      // to it so its HomeScreen/blocked result is actually visible. No-op
      // when LoginScreen is AuthGate's own inline widget.
      if (mounted) {
        Navigator.of(context).popUntil((route) => route.isFirst);
      }
    } on FirebaseAuthException catch (e) {
      String msg;
      switch (e.code) {
        case 'invalid-email':
          msg = 'Please enter a valid email address.';
          break;
        case 'user-disabled':
          msg = 'Your rider account is not active. Contact your administrator.';
          break;
        case 'user-not-found':
        case 'wrong-password':
        case 'invalid-credential':
          msg = 'Invalid email or password.';
          break;
        case 'too-many-requests':
          msg = 'Too many attempts. Please try again later.';
          break;
        case 'network-request-failed':
          msg = 'Network error. Please try again.';
          break;
        default:
          msg = 'Sign in failed. Please try again.';
      }
      if (mounted) setState(() => _error = msg);
    } catch (e, stack) {
      debugPrint('Rider sign-in failed: $e\n$stack');
      if (mounted) setState(() => _error = 'Sign in failed. Please try again.');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// Opens "Reset password", prefilled with whatever is in the email field.
  /// The rider returns here afterwards; nothing signs them in.
  void _openForgotPassword() {
    FocusScope.of(context).unfocus();
    final send = widget.sendPasswordReset ?? (email) => AuthService().sendPasswordReset(email);
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ForgotPasswordScreen(initialEmail: _emailController.text, sendReset: send),
      ),
    );
  }

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  void _clearError() {
    if (_error != null) setState(() => _error = null);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(24, 24, 24, 16),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: AutofillGroup(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Center(child: VaxTrackLogo(size: 76)),
                    const SizedBox(height: 16),
                    const Text(
                      'VaxTrack Rider',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800, color: AppColors.textDark, letterSpacing: -0.3),
                    ),
                    const SizedBox(height: 4),
                    const Text(
                      'Sign in to see and deliver your assigned orders.',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 14, color: AppColors.textLight, height: 1.4),
                    ),
                    if (AppBranding.isStaging) ...[
                      const SizedBox(height: 10),
                      Center(
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
                          decoration: BoxDecoration(color: AppColors.warningBg, borderRadius: BorderRadius.circular(999)),
                          child: const Text(
                            'Staging — test data only',
                            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: AppColors.warning),
                          ),
                        ),
                      ),
                    ],
                    const SizedBox(height: 28),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        TextField(
                          key: const Key('loginEmailField'),
                          controller: _emailController,
                          keyboardType: TextInputType.emailAddress,
                          textInputAction: TextInputAction.next,
                          autofillHints: const [AutofillHints.email, AutofillHints.username],
                          autocorrect: false,
                          enableSuggestions: false,
                          enabled: !_loading,
                          onChanged: (_) => _clearError(),
                          decoration: const InputDecoration(
                            labelText: 'Email',
                            hintText: 'you@example.com',
                            prefixIcon: Icon(Icons.email_outlined, color: AppColors.textLight),
                          ),
                        ),
                        const SizedBox(height: 14),
                        TextField(
                          key: const Key('loginPasswordField'),
                          controller: _passwordController,
                          obscureText: _obscurePassword,
                          textInputAction: TextInputAction.done,
                          autofillHints: const [AutofillHints.password],
                          autocorrect: false,
                          enableSuggestions: false,
                          enabled: !_loading,
                          onChanged: (_) => _clearError(),
                          onSubmitted: (_) => _login(),
                          decoration: InputDecoration(
                            labelText: 'Password',
                            prefixIcon: const Icon(Icons.lock_outlined, color: AppColors.textLight),
                            suffixIcon: IconButton(
                              tooltip: _obscurePassword ? 'Show password' : 'Hide password',
                              icon: Icon(
                                _obscurePassword ? Icons.visibility_off_outlined : Icons.visibility_outlined,
                                color: AppColors.textLight,
                              ),
                              onPressed: () => setState(() => _obscurePassword = !_obscurePassword),
                            ),
                          ),
                        ),
                        const SizedBox(height: 4),
                        Align(
                          alignment: AlignmentDirectional.centerEnd,
                          child: TextButton(
                            key: const Key('forgotPasswordButton'),
                            onPressed: _loading ? null : _openForgotPassword,
                            style: TextButton.styleFrom(
                              foregroundColor: AppColors.brand,
                              minimumSize: const Size(48, 48),
                              tapTargetSize: MaterialTapTargetSize.padded,
                              textStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                            ),
                            child: Semantics(
                              // Read as "Forgot password? Reset your password, button".
                              label: 'Forgot password? Reset your password',
                              excludeSemantics: true,
                              child: const Text('Forgot password?', textAlign: TextAlign.end),
                            ),
                          ),
                        ),
                      ],
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
                              Expanded(
                                child: Text(_error!, style: const TextStyle(color: AppColors.urgent, fontSize: 13)),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],
                    const SizedBox(height: 12),
                    SizedBox(
                      height: 52,
                      child: ElevatedButton(
                        style: ElevatedButton.styleFrom(backgroundColor: AppColors.brand),
                        onPressed: _loading ? null : _login,
                        child: _loading
                            ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                            : const Text('Sign In'),
                      ),
                    ),
                    const SizedBox(height: 32),
                    const Text(
                      'New rider?',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: AppColors.textMedium),
                    ),
                    const SizedBox(height: 8),
                    ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: 48),
                      child: OutlinedButton.icon(
                        key: const Key('applyAsRiderButton'),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: AppColors.brand,
                          side: const BorderSide(color: AppColors.brand),
                        ),
                        onPressed: _loading ? null : () => Navigator.of(context).pushNamed('/register'),
                        icon: const Icon(Icons.two_wheeler),
                        label: const Text('Apply as a rider'),
                      ),
                    ),
                    const SizedBox(height: 12),
                    const Text(
                      'An admin reviews each application before you can sign in. '
                      'Staff use the web portal.',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 12, color: AppColors.textLight, height: 1.4),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
