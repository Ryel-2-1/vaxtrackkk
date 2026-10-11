import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import '../services/auth_service.dart';
import '../theme/app_theme.dart';
import '../utils/password_reset.dart';
import 'forgot_password_screen.dart';

/// Signs the rider in with Firebase Authentication. Role and status are
/// decided afterwards by AuthGate, never here.
typedef RiderSignIn = Future<void> Function(String email, String password);

Future<void> _firebaseSignIn(String email, String password) async {
  await FirebaseAuth.instance
      .signInWithEmailAndPassword(email: email, password: password)
      .timeout(const Duration(seconds: 30));
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
          msg = e.message ?? 'Sign in failed. Please try again.';
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
        builder: (_) => ForgotPasswordScreen(
          initialEmail: _emailController.text,
          sendReset: send,
        ),
      ),
    );
  }

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Container(
                  width: 80,
                  height: 80,
                  decoration: BoxDecoration(
                    color: AppColors.primaryLight,
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: const Icon(Icons.local_shipping, size: 40, color: AppColors.primary),
                ),
                const SizedBox(height: 20),
                const Text(
                  'VaxTrack',
                  style: TextStyle(
                    fontSize: 28,
                    fontWeight: FontWeight.w900,
                    color: AppColors.primary,
                  ),
                ),
                const SizedBox(height: 4),
                const Text(
                  'Rider Portal',
                  style: TextStyle(fontSize: 14, color: AppColors.textLight),
                ),
                const SizedBox(height: 40),
                TextField(
                  key: const Key('loginEmailField'),
                  controller: _emailController,
                  keyboardType: TextInputType.emailAddress,
                  textInputAction: TextInputAction.next,
                  decoration: const InputDecoration(
                    labelText: 'Email',
                    prefixIcon: Icon(Icons.email_outlined),
                  ),
                ),
                const SizedBox(height: 16),
                TextField(
                  key: const Key('loginPasswordField'),
                  controller: _passwordController,
                  obscureText: _obscurePassword,
                  textInputAction: TextInputAction.done,
                  onSubmitted: (_) => _login(),
                  decoration: InputDecoration(
                    labelText: 'Password',
                    prefixIcon: const Icon(Icons.lock_outlined),
                    suffixIcon: IconButton(
                      icon: Icon(_obscurePassword ? Icons.visibility_off : Icons.visibility),
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
                      foregroundColor: AppColors.primaryDark,
                      minimumSize: const Size(48, 48),
                      tapTargetSize: MaterialTapTargetSize.padded,
                      textStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
                    ),
                    child: Semantics(
                      // Read as "Forgot password? Reset your password, button".
                      label: 'Forgot password? Reset your password',
                      excludeSemantics: true,
                      child: const Text('Forgot password?', textAlign: TextAlign.end),
                    ),
                  ),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 16),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppColors.urgentBg,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      _error!,
                      style: const TextStyle(color: AppColors.urgent, fontSize: 13),
                    ),
                  ),
                ],
                const SizedBox(height: 24),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    onPressed: _loading ? null : _login,
                    child: _loading
                        ? const SizedBox(
                            height: 20,
                            width: 20,
                            child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2),
                          )
                        : const Text('Sign In'),
                  ),
                ),
                const SizedBox(height: 12),
                TextButton(
                  onPressed: _loading
                      ? null
                      : () => Navigator.of(context).pushNamed('/register'),
                  child: const Text("Don't have an account? Apply as a rider"),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
