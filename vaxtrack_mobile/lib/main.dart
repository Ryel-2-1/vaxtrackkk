import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp();

  runApp(const VaxTrackMobileApp());
}

class VaxTrackMobileApp extends StatelessWidget {
  const VaxTrackMobileApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'VaxTrack Mobile',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        fontFamily: 'Arial',
        colorScheme: ColorScheme.fromSeed(seedColor: primaryBlue),
        useMaterial3: true,
      ),
      home: const RiderLoginScreen(),
    );
  }
}

const Color primaryBlue = Color(0xFF0B5CE6);
const Color bgColor = Color(0xFFF5F7FD);
const Color textDark = Color(0xFF0F172A);
const Color textMuted = Color(0xFF64748B);

List<BoxShadow> get softShadow {
  return [
    BoxShadow(
      color: Colors.black.withAlpha(18),
      blurRadius: 24,
      offset: const Offset(0, 12),
    ),
  ];
}

/* =========================
   LOGIN SCREEN
========================= */

class RiderLoginScreen extends StatefulWidget {
  const RiderLoginScreen({super.key});

  @override
  State<RiderLoginScreen> createState() => _RiderLoginScreenState();
}

class _RiderLoginScreenState extends State<RiderLoginScreen> {
  final emailController = TextEditingController(text: 'rider@vaxtrack.com');
  final passwordController = TextEditingController(text: 'rider123');

  bool rememberMe = false;
  bool obscurePassword = true;
  bool isLoading = false;
  String message = '';
  bool isError = true;

  @override
  void dispose() {
    emailController.dispose();
    passwordController.dispose();
    super.dispose();
  }

  void showMessage(String text, {bool error = true}) {
    setState(() {
      message = text;
      isError = error;
    });
  }

  Future<void> login() async {
    final email = emailController.text.trim();
    final password = passwordController.text.trim();

    if (email.isEmpty) {
      showMessage('Rider ID or email is required.');
      return;
    }

    if (!email.contains('@')) {
      showMessage('Please enter a valid email address.');
      return;
    }

    if (password.isEmpty) {
      showMessage('Password is required.');
      return;
    }

    if (password.length < 6) {
      showMessage('Password must be at least 6 characters.');
      return;
    }

    setState(() {
      isLoading = true;
      message = '';
    });

    try {
      final credential = await FirebaseAuth.instance.signInWithEmailAndPassword(
        email: email,
        password: password,
      );

      final uid = credential.user!.uid;

      final userDoc =
          await FirebaseFirestore.instance.collection('users').doc(uid).get();

      if (!userDoc.exists) {
        showMessage('Account exists, but no Firestore user role was found.');
        return;
      }

      final data = userDoc.data()!;
      final role = data['role'];

      if (role == 'rider') {
        if (!mounted) return;

        Navigator.pushReplacement(
          context,
          MaterialPageRoute(
            builder: (_) => RiderDashboardScreen(
              fullName: data['fullName'] ?? 'Rider',
              email: data['email'] ?? email,
            ),
          ),
        );
      } else if (role == 'admin') {
        showMessage('Admin accounts should use the web portal.');
      } else {
        showMessage('Invalid user role.');
      }
    } on FirebaseAuthException catch (e) {
      if (e.code == 'invalid-credential') {
        showMessage('Invalid email or password.');
      } else if (e.code == 'user-not-found') {
        showMessage('No account found with this email.');
      } else if (e.code == 'wrong-password') {
        showMessage('Incorrect password.');
      } else {
        showMessage('Login failed: ${e.message}');
      }
    } catch (e) {
      showMessage('Something went wrong: $e');
    } finally {
      if (mounted) {
        setState(() => isLoading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return AuthScaffold(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(22),
          child: AuthCard(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const AppIcon(icon: Icons.local_shipping_rounded),
                const SizedBox(height: 14),
                const Text(
                  'VaxTrack',
                  style: TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w800,
                    color: textDark,
                  ),
                ),
                const SizedBox(height: 5),
                const Text(
                  'Medical Logistics Portal',
                  style: TextStyle(fontSize: 13, color: textMuted),
                ),
                const SizedBox(height: 30),
                AppTextField(
                  label: 'Rider ID or Email',
                  hint: 'Enter your ID or email',
                  controller: emailController,
                  icon: Icons.person_outline,
                  keyboardType: TextInputType.emailAddress,
                ),
                const SizedBox(height: 16),
                AppTextField(
                  label: 'Password',
                  hint: 'Enter your password',
                  controller: passwordController,
                  icon: Icons.lock_outline,
                  obscureText: obscurePassword,
                  suffixIcon: IconButton(
                    onPressed: () {
                      setState(() {
                        obscurePassword = !obscurePassword;
                      });
                    },
                    icon: Icon(
                      obscurePassword
                          ? Icons.visibility_outlined
                          : Icons.visibility_off_outlined,
                      size: 20,
                    ),
                  ),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Checkbox(
                      value: rememberMe,
                      visualDensity: VisualDensity.compact,
                      onChanged: (value) {
                        setState(() {
                          rememberMe = value ?? false;
                        });
                      },
                    ),
                    const Text(
                      'Remember me',
                      style: TextStyle(fontSize: 12, color: textMuted),
                    ),
                    const Spacer(),
                    TextButton(
                      onPressed: () {
                        Navigator.push(
                          context,
                          MaterialPageRoute(
                            builder: (_) => const ForgotPasswordEmailScreen(),
                          ),
                        );
                      },
                      child: const Text(
                        'Forgot Password?',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  ],
                ),
                if (message.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  MessageBox(message: message, isError: isError),
                ],
                const SizedBox(height: 18),
                PrimaryButton(
                  text: isLoading ? 'Verifying account...' : 'Login',
                  icon: Icons.arrow_forward,
                  onPressed: isLoading ? null : login,
                ),
                const SizedBox(height: 22),
                const DividerWithText(text: 'or'),
                const SizedBox(height: 18),
                SecondaryButton(
                  text: 'Sign up with Google',
                  iconText: 'G',
                  onPressed: null,
                ),
                const SizedBox(height: 22),
                const Divider(),
                const SizedBox(height: 18),
                const Text(
                  'New to VaxTrack?',
                  style: TextStyle(fontSize: 12, color: textMuted),
                ),
                const SizedBox(height: 12),
                LightButton(
                  text: 'Create Account',
                  onPressed: () {
                    Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (_) => const RiderSignUpScreen(),
                      ),
                    );
                  },
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/* =========================
   REGISTER SCREEN
========================= */

class RiderSignUpScreen extends StatefulWidget {
  const RiderSignUpScreen({super.key});

  @override
  State<RiderSignUpScreen> createState() => _RiderSignUpScreenState();
}

class _RiderSignUpScreenState extends State<RiderSignUpScreen> {
  final fullNameController = TextEditingController();
  final riderIdController = TextEditingController();
  final emailController = TextEditingController();
  final phoneController = TextEditingController();
  final passwordController = TextEditingController();

  bool agree = false;
  bool obscurePassword = true;
  bool isLoading = false;
  String message = '';
  bool isError = true;

  @override
  void dispose() {
    fullNameController.dispose();
    riderIdController.dispose();
    emailController.dispose();
    phoneController.dispose();
    passwordController.dispose();
    super.dispose();
  }

  void showMessage(String text, {bool error = true}) {
    setState(() {
      message = text;
      isError = error;
    });
  }

  Future<void> createAccount() async {
    final fullName = fullNameController.text.trim();
    final riderId = riderIdController.text.trim();
    final email = emailController.text.trim();
    final phone = phoneController.text.trim();
    final password = passwordController.text.trim();

    final nameRegex = RegExp(r"^[a-zA-Z\s.'-]+$");
    final phoneRegex = RegExp(r'^(09|\+639)\d{9}$');
    final riderIdRegex = RegExp(r'^VT-\d{4}-\d{2}$');
    final hasUppercase = RegExp(r'[A-Z]').hasMatch(password);
    final hasNumber = RegExp(r'[0-9]').hasMatch(password);

    if (fullName.isEmpty) {
      showMessage('Full name is required.');
      return;
    }

    if (fullName.length < 3) {
      showMessage('Full name must be at least 3 characters.');
      return;
    }

    if (!nameRegex.hasMatch(fullName)) {
      showMessage('Full name must not contain numbers or invalid symbols.');
      return;
    }

    if (riderId.isNotEmpty && !riderIdRegex.hasMatch(riderId)) {
      showMessage('Rider ID format must be VT-XXXX-XX, example: VT-2026-01.');
      return;
    }

    if (email.isEmpty) {
      showMessage('Email address is required.');
      return;
    }

    if (!email.contains('@') || !email.contains('.')) {
      showMessage('Please enter a valid email address.');
      return;
    }

    if (phone.isEmpty) {
      showMessage('Phone number is required.');
      return;
    }

    if (!phoneRegex.hasMatch(phone)) {
      showMessage(
        'Phone number must be valid, example: 09123456789 or +639123456789.',
      );
      return;
    }

    if (password.isEmpty) {
      showMessage('Password is required.');
      return;
    }

    if (password.length < 6) {
      showMessage('Password must be at least 6 characters.');
      return;
    }

    if (!hasUppercase) {
      showMessage('Password must contain at least 1 uppercase letter.');
      return;
    }

    if (!hasNumber) {
      showMessage('Password must contain at least 1 number.');
      return;
    }

    if (!agree) {
      showMessage('Please agree to the Terms of Service and Privacy Policy.');
      return;
    }

    setState(() {
      isLoading = true;
      message = '';
    });

    try {
      final credential =
          await FirebaseAuth.instance.createUserWithEmailAndPassword(
        email: email,
        password: password,
      );

      final uid = credential.user!.uid;

      await FirebaseFirestore.instance.collection('users').doc(uid).set({
        'fullName': fullName,
        'riderId': riderId,
        'email': email,
        'phone': phone,
        'role': 'rider',
        'createdAt': FieldValue.serverTimestamp(),
      });

      if (!mounted) return;

      Navigator.pushReplacement(
        context,
        MaterialPageRoute(
          builder: (_) => const RiderSuccessConfirmationScreen(),
        ),
      );
    } on FirebaseAuthException catch (e) {
      if (e.code == 'email-already-in-use') {
        showMessage('This email is already registered.');
      } else if (e.code == 'invalid-email') {
        showMessage('Invalid email address.');
      } else if (e.code == 'weak-password') {
        showMessage('Password is too weak.');
      } else {
        showMessage('Registration failed: ${e.message}');
      }
    } catch (e) {
      showMessage('Something went wrong: $e');
    } finally {
      if (mounted) {
        setState(() => isLoading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return AuthScaffold(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(22),
          child: AuthCard(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const BrandMiniHeader(
                  title: 'VaxTrack Mobile',
                  subtitle: 'Rider Onboarding Portal',
                  icon: Icons.local_shipping_rounded,
                ),
                const SizedBox(height: 28),
                AppTextField(
                  label: 'Full Name',
                  hint: 'e.g. Juan Dela Cruz',
                  controller: fullNameController,
                  icon: Icons.person_outline,
                ),
                const SizedBox(height: 14),
                AppTextField(
                  label: 'Rider ID',
                  hint: 'VT-2026-01',
                  controller: riderIdController,
                  icon: Icons.badge_outlined,
                ),
                const SizedBox(height: 14),
                AppTextField(
                  label: 'Email Address',
                  hint: 'rider@vaxtrack.ph',
                  controller: emailController,
                  icon: Icons.mail_outline,
                  keyboardType: TextInputType.emailAddress,
                ),
                const SizedBox(height: 14),
                AppTextField(
                  label: 'Phone Number',
                  hint: '09123456789',
                  controller: phoneController,
                  icon: Icons.phone_android_outlined,
                  keyboardType: TextInputType.phone,
                ),
                const SizedBox(height: 14),
                AppTextField(
                  label: 'Password',
                  hint: 'Minimum 6 characters',
                  controller: passwordController,
                  icon: Icons.lock_outline,
                  obscureText: obscurePassword,
                  suffixIcon: IconButton(
                    onPressed: () {
                      setState(() {
                        obscurePassword = !obscurePassword;
                      });
                    },
                    icon: Icon(
                      obscurePassword
                          ? Icons.visibility_outlined
                          : Icons.visibility_off_outlined,
                      size: 20,
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Checkbox(
                      value: agree,
                      visualDensity: VisualDensity.compact,
                      onChanged: (value) {
                        setState(() {
                          agree = value ?? false;
                        });
                      },
                    ),
                    const Expanded(
                      child: Padding(
                        padding: EdgeInsets.only(top: 8),
                        child: Text(
                          'I agree to the Terms of Service and Privacy Policy',
                          style: TextStyle(fontSize: 12, color: textMuted),
                        ),
                      ),
                    ),
                  ],
                ),
                if (message.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  MessageBox(message: message, isError: isError),
                ],
                const SizedBox(height: 18),
                PrimaryButton(
                  text: isLoading ? 'Creating account...' : 'Create Account',
                  icon: Icons.arrow_forward,
                  onPressed: isLoading ? null : createAccount,
                ),
                const SizedBox(height: 22),
                const DividerWithText(text: 'OR'),
                const SizedBox(height: 18),
                SecondaryButton(
                  text: 'Sign up with Google',
                  iconText: 'G',
                  onPressed: null,
                ),
                const SizedBox(height: 18),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    const Text(
                      'Already have an account?',
                      style: TextStyle(fontSize: 12, color: textMuted),
                    ),
                    TextButton(
                      onPressed: () => Navigator.pop(context),
                      child: const Text(
                        'Log in',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/* =========================
   REGISTER SUCCESS SCREEN
========================= */

class RiderSuccessConfirmationScreen extends StatelessWidget {
  const RiderSuccessConfirmationScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return AuthScaffold(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24),
        child: Column(
          children: [
            const SizedBox(height: 18),
            const Text(
              'VaxTrack',
              style: TextStyle(
                color: primaryBlue,
                fontWeight: FontWeight.w900,
                fontSize: 14,
              ),
            ),
            const SizedBox(height: 44),
            Stack(
              alignment: Alignment.bottomRight,
              children: [
                Container(
                  width: 118,
                  height: 118,
                  decoration: BoxDecoration(
                    color: const Color(0xFF75F08E),
                    shape: BoxShape.circle,
                    border: Border.all(color: Colors.white, width: 4),
                    boxShadow: [
                      BoxShadow(
                        color: const Color(0xFF75F08E).withAlpha(90),
                        blurRadius: 28,
                        offset: const Offset(0, 12),
                      ),
                    ],
                  ),
                  child: const Icon(
                    Icons.check_circle_outline,
                    color: Color(0xFF047857),
                    size: 70,
                  ),
                ),
                const AppIcon(
                  icon: Icons.local_shipping_rounded,
                  size: 42,
                  iconSize: 20,
                ),
              ],
            ),
            const SizedBox(height: 34),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 30),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: const Color(0xFFCBD5E1)),
              ),
              child: const Column(
                children: [
                  Text(
                    'Handa na, Partner!',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 25,
                      fontWeight: FontWeight.w900,
                      color: textDark,
                    ),
                  ),
                  SizedBox(height: 14),
                  Text(
                    'Account Created! Welcome to VaxTrack. Your profile is being verified, but you can start exploring your dashboard now.',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 14,
                      height: 1.45,
                      color: textMuted,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 42),
            PrimaryButton(
              text: 'Go to Dashboard',
              icon: Icons.arrow_forward,
              onPressed: () {
                Navigator.pushReplacement(
                  context,
                  MaterialPageRoute(
                    builder: (_) => const RiderDashboardScreen(
                      fullName: 'Juan',
                      email: 'new.rider@vaxtrack.ph',
                    ),
                  ),
                );
              },
            ),
            const SizedBox(height: 70),
            Container(
              height: 128,
              width: double.infinity,
              decoration: BoxDecoration(
                color: const Color(0xFFE5E7EB),
                borderRadius: BorderRadius.circular(12),
              ),
              child: const Center(
                child: Icon(
                  Icons.medical_services_outlined,
                  color: Color(0xFF94A3B8),
                  size: 54,
                ),
              ),
            ),
            const Spacer(),
            const Text(
              '© 2026 VaxTrack Philippines • Secure Logistics',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 11, color: textMuted),
            ),
            const SizedBox(height: 18),
          ],
        ),
      ),
    );
  }
}

/* =========================
   FORGOT PASSWORD
========================= */

class ForgotPasswordEmailScreen extends StatefulWidget {
  const ForgotPasswordEmailScreen({super.key});

  @override
  State<ForgotPasswordEmailScreen> createState() =>
      _ForgotPasswordEmailScreenState();
}

class _ForgotPasswordEmailScreenState extends State<ForgotPasswordEmailScreen> {
  final emailController = TextEditingController();
  bool isLoading = false;
  String message = '';
  bool isError = true;

  @override
  void dispose() {
    emailController.dispose();
    super.dispose();
  }

  void showMessage(String text, {bool error = true}) {
    setState(() {
      message = text;
      isError = error;
    });
  }

  Future<void> sendResetEmail() async {
    final email = emailController.text.trim();

    if (email.isEmpty) {
      showMessage('Email or Rider ID is required.');
      return;
    }

    if (!email.contains('@')) {
      showMessage('Please enter a valid email address.');
      return;
    }

    setState(() {
      isLoading = true;
      message = '';
    });

    try {
      await FirebaseAuth.instance.sendPasswordResetEmail(email: email);

      if (!mounted) return;

      Navigator.pushReplacement(
        context,
        MaterialPageRoute(
          builder: (_) => PasswordResetSuccessScreen(email: email),
        ),
      );
    } on FirebaseAuthException catch (e) {
      if (e.code == 'user-not-found') {
        showMessage('No account found with this email.');
      } else if (e.code == 'invalid-email') {
        showMessage('Invalid email address.');
      } else {
        showMessage('Unable to send reset email: ${e.message}');
      }
    } catch (e) {
      showMessage('Something went wrong: $e');
    } finally {
      if (mounted) {
        setState(() => isLoading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return AuthScaffold(
      child: Stack(
        children: [
          Positioned.fill(
            child: Container(
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  colors: [Color(0xFFF8FAFF), Color(0xFFEEF4FF)],
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                ),
              ),
            ),
          ),
          Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(22),
              child: AuthCard(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const AppIcon(icon: Icons.history_rounded),
                    const SizedBox(height: 18),
                    const Text(
                      'Password Reset',
                      style: TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.w900,
                        color: textDark,
                      ),
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'Enter your registered email or Rider ID to receive a secure recovery link.',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 13, color: textMuted),
                    ),
                    const SizedBox(height: 26),
                    AppTextField(
                      label: 'Email or Rider ID',
                      hint: 'e.g. rider@vaxtrack.com',
                      controller: emailController,
                      icon: Icons.badge_outlined,
                      keyboardType: TextInputType.emailAddress,
                    ),
                    if (message.isNotEmpty) ...[
                      const SizedBox(height: 12),
                      MessageBox(message: message, isError: isError),
                    ],
                    const SizedBox(height: 22),
                    PrimaryButton(
                      text: isLoading ? 'Sending link...' : 'Send Code',
                      icon: Icons.send_rounded,
                      onPressed: isLoading ? null : sendResetEmail,
                    ),
                    const SizedBox(height: 22),
                    TextButton(
                      onPressed: () => Navigator.pop(context),
                      child: const Text('← Back to Login'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class PasswordResetSuccessScreen extends StatelessWidget {
  const PasswordResetSuccessScreen({
    super.key,
    required this.email,
  });

  final String email;

  @override
  Widget build(BuildContext context) {
    return AuthScaffold(
      child: Padding(
        padding: const EdgeInsets.all(26),
        child: Column(
          children: [
            const Spacer(),
            Container(
              width: 82,
              height: 82,
              decoration: const BoxDecoration(
                color: Color(0xFF6AF28B),
                shape: BoxShape.circle,
              ),
              child: const Icon(
                Icons.check_circle,
                color: Color(0xFF064E3B),
                size: 38,
              ),
            ),
            const SizedBox(height: 28),
            const Text(
              'Password Reset Email Sent',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 22,
                fontWeight: FontWeight.w900,
                color: textDark,
              ),
            ),
            const SizedBox(height: 12),
            Text(
              'A secure password reset link was sent to $email. Please check your inbox or spam folder.',
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 13, color: textMuted),
            ),
            const Spacer(),
            PrimaryButton(
              text: 'Back to Login',
              onPressed: () {
                Navigator.pushAndRemoveUntil(
                  context,
                  MaterialPageRoute(builder: (_) => const RiderLoginScreen()),
                  (route) => false,
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}

/* =========================
   RIDER DASHBOARD
========================= */

class RiderDashboardScreen extends StatelessWidget {
  const RiderDashboardScreen({
    super.key,
    required this.fullName,
    required this.email,
  });

  final String fullName;
  final String email;

  Future<void> logout(BuildContext context) async {
    await FirebaseAuth.instance.signOut();

    if (!context.mounted) return;

    Navigator.pushAndRemoveUntil(
      context,
      MaterialPageRoute(builder: (_) => const RiderLoginScreen()),
      (route) => false,
    );
  }

  @override
  Widget build(BuildContext context) {
    final firstName = fullName.split(' ').first;

    return Scaffold(
      backgroundColor: bgColor,
      appBar: AppBar(
        backgroundColor: Colors.white,
        elevation: 0,
        leading: IconButton(
          onPressed: () => logout(context),
          icon: const Icon(Icons.menu, color: textDark),
        ),
        centerTitle: true,
        title: const Text(
          'VaxTrack Mobile',
          style: TextStyle(
            color: primaryBlue,
            fontSize: 18,
            fontWeight: FontWeight.w900,
          ),
        ),
        actions: [
          IconButton(
            onPressed: () {},
            icon: const Icon(Icons.notifications_none, color: textDark),
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(18, 18, 18, 90),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: RichText(
                    text: TextSpan(
                      style: const TextStyle(color: textDark),
                      children: [
                        const TextSpan(
                          text: 'Handa na ba, ',
                          style: TextStyle(
                            fontSize: 21,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                        TextSpan(
                          text: '$firstName?',
                          style: const TextStyle(
                            fontSize: 21,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                        const TextSpan(
                          text: '\nShift started at 08:00 AM',
                          style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w400,
                            color: textMuted,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFEE2E2),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: const Row(
                    children: [
                      Icon(Icons.cloud_off, color: Color(0xFFDC2626), size: 15),
                      SizedBox(width: 5),
                      Text(
                        'OFFLINE',
                        style: TextStyle(
                          color: Color(0xFFDC2626),
                          fontSize: 11,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 22),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(18),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(14),
                boxShadow: softShadow,
                border: const Border(
                  left: BorderSide(color: primaryBlue, width: 5),
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Text(
                        'NEXT DROP-OFF',
                        style: TextStyle(
                          color: primaryBlue,
                          fontSize: 12,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                      const Spacer(),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 9,
                          vertical: 6,
                        ),
                        decoration: BoxDecoration(
                          color: const Color(0xFFE8F0FF),
                          borderRadius: BorderRadius.circular(7),
                        ),
                        child: const Text(
                          'Est. 10:30 AM',
                          style: TextStyle(
                            fontSize: 11,
                            color: Color(0xFF475569),
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  const Text(
                    'Makati Medical Center',
                    style: TextStyle(
                      fontSize: 19,
                      color: textDark,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  const SizedBox(height: 8),
                  const Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(
                        Icons.location_on_outlined,
                        color: textMuted,
                        size: 17,
                      ),
                      SizedBox(width: 5),
                      Expanded(
                        child: Text(
                          '2 Amorsolo Street, Legazpi Village, Makati City',
                          style: TextStyle(
                            fontSize: 13,
                            color: textMuted,
                            height: 1.35,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      _infoChip(
                        icon: Icons.thermostat,
                        text: '-70°C Cold Chain',
                        color: primaryBlue,
                        textColor: Colors.white,
                      ),
                      _infoChip(
                        icon: Icons.inventory_2_outlined,
                        text: '2 Pallets (150kg)',
                        color: const Color(0xFFE8F0FF),
                        textColor: textDark,
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 18),
            PrimaryButton(
              text: 'Start Delivery',
              icon: Icons.play_circle,
              onPressed: () {},
            ),
            const SizedBox(height: 24),
            Row(
              children: [
                Expanded(
                  child: _statBox(
                    icon: Icons.local_shipping_outlined,
                    value: '12',
                    label: 'Deliveries Today',
                    iconBg: const Color(0xFFE8F0FF),
                    iconColor: primaryBlue,
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: _statBox(
                    icon: Icons.check_circle_outline,
                    value: '0 / 12',
                    label: 'Completed',
                    iconBg: const Color(0xFFDCFCE7),
                    iconColor: const Color(0xFF16A34A),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 26),
            Row(
              children: [
                const Text(
                  'Route Overview',
                  style: TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w900,
                    color: textDark,
                  ),
                ),
                const Spacer(),
                TextButton(
                  onPressed: () {},
                  child: const Text(
                    'View Map',
                    style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            _routeTile(
              number: '1',
              title: 'Makati Medical Center',
              subtitle: 'Next Stop',
              active: true,
            ),
            const SizedBox(height: 10),
            _routeTile(
              number: '2',
              title: "St. Luke's Medical Center BGC",
              subtitle: 'Pending',
              active: false,
            ),
          ],
        ),
      ),
      bottomNavigationBar: Container(
        height: 74,
        decoration: const BoxDecoration(
          color: Color(0xFFD8E8FF),
          boxShadow: [
            BoxShadow(
              color: Color(0x22000000),
              blurRadius: 18,
              offset: Offset(0, -6),
            ),
          ],
        ),
        child: const Row(
          mainAxisAlignment: MainAxisAlignment.spaceAround,
          children: [
            BottomNavItem(icon: Icons.home, label: 'Home', active: true),
            BottomNavItem(
              icon: Icons.local_shipping_outlined,
              label: 'Deliveries',
            ),
            BottomNavItem(icon: Icons.navigation_outlined, label: 'Navigation'),
            BottomNavItem(icon: Icons.person_outline, label: 'Profile'),
          ],
        ),
      ),
    );
  }

  static Widget _infoChip({
    required IconData icon,
    required String text,
    required Color color,
    required Color textColor,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(7),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, color: textColor, size: 16),
          const SizedBox(width: 5),
          Text(
            text,
            style: TextStyle(
              color: textColor,
              fontSize: 12,
              fontWeight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
  }

  static Widget _statBox({
    required IconData icon,
    required String value,
    required String label,
    required Color iconBg,
    required Color iconColor,
  }) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        boxShadow: softShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              color: iconBg,
              shape: BoxShape.circle,
            ),
            child: Icon(icon, color: iconColor, size: 21),
          ),
          const SizedBox(height: 16),
          Text(
            value,
            style: const TextStyle(
              fontSize: 30,
              fontWeight: FontWeight.w900,
              color: textDark,
            ),
          ),
          Text(
            label,
            style: const TextStyle(fontSize: 12, color: textMuted),
          ),
        ],
      ),
    );
  }

  static Widget _routeTile({
    required String number,
    required String title,
    required String subtitle,
    required bool active,
  }) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: active ? const Color(0xFFDDEAFF) : Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: active ? const Color(0xFFBBD2FF) : const Color(0xFFE5E7EB),
        ),
      ),
      child: Row(
        children: [
          CircleAvatar(
            radius: 17,
            backgroundColor: active ? primaryBlue : const Color(0xFFEFF3F9),
            child: Text(
              number,
              style: TextStyle(
                color: active ? Colors.white : textMuted,
                fontWeight: FontWeight.w900,
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    color: textDark,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                Text(
                  subtitle,
                  style: TextStyle(
                    color: active ? primaryBlue : textMuted,
                    fontSize: 12,
                    fontWeight: active ? FontWeight.w800 : FontWeight.w500,
                  ),
                ),
              ],
            ),
          ),
          Icon(
            Icons.more_vert,
            color: active ? primaryBlue : textMuted,
          ),
        ],
      ),
    );
  }
}

/* =========================
   REUSABLE WIDGETS
========================= */

class AuthScaffold extends StatelessWidget {
  const AuthScaffold({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: bgColor,
      body: SafeArea(child: child),
    );
  }
}

class AuthCard extends StatelessWidget {
  const AuthCard({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final screenWidth = MediaQuery.of(context).size.width;

    return Container(
      width: screenWidth > 430 ? 390 : screenWidth - 32,
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFFE5E7EB)),
        boxShadow: softShadow,
      ),
      child: child,
    );
  }
}

class BrandMiniHeader extends StatelessWidget {
  const BrandMiniHeader({
    super.key,
    required this.title,
    required this.subtitle,
    required this.icon,
  });

  final String title;
  final String subtitle;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, color: primaryBlue, size: 20),
            const SizedBox(width: 6),
            Text(
              title,
              style: const TextStyle(
                color: primaryBlue,
                fontWeight: FontWeight.w900,
                fontSize: 16,
              ),
            ),
          ],
        ),
        const SizedBox(height: 4),
        Text(
          subtitle,
          style: const TextStyle(fontSize: 12, color: textMuted),
        ),
      ],
    );
  }
}

class AppIcon extends StatelessWidget {
  const AppIcon({
    super.key,
    required this.icon,
    this.size = 58,
    this.iconSize = 28,
  });

  final IconData icon;
  final double size;
  final double iconSize;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: primaryBlue,
        borderRadius: BorderRadius.circular(size * 0.25),
        boxShadow: [
          BoxShadow(
            color: primaryBlue.withAlpha(45),
            blurRadius: 16,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Icon(icon, color: Colors.white, size: iconSize),
    );
  }
}

class AppTextField extends StatelessWidget {
  const AppTextField({
    super.key,
    required this.label,
    required this.hint,
    required this.controller,
    required this.icon,
    this.obscureText = false,
    this.suffixIcon,
    this.keyboardType,
  });

  final String label;
  final String hint;
  final TextEditingController controller;
  final IconData icon;
  final bool obscureText;
  final Widget? suffixIcon;
  final TextInputType? keyboardType;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(
            fontSize: 12,
            color: textDark,
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: 7),
        TextField(
          controller: controller,
          obscureText: obscureText,
          keyboardType: keyboardType,
          decoration: InputDecoration(
            hintText: hint,
            hintStyle: const TextStyle(fontSize: 13, color: Color(0xFF94A3B8)),
            prefixIcon: Icon(icon, size: 20),
            suffixIcon: suffixIcon,
            filled: true,
            fillColor: const Color(0xFFF8FAFC),
            contentPadding:
                const EdgeInsets.symmetric(horizontal: 12, vertical: 13),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(7),
              borderSide: const BorderSide(color: Color(0xFFCBD5E1)),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(7),
              borderSide: const BorderSide(color: Color(0xFFCBD5E1)),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(7),
              borderSide: const BorderSide(color: primaryBlue, width: 1.5),
            ),
          ),
        ),
      ],
    );
  }
}

class PrimaryButton extends StatelessWidget {
  const PrimaryButton({
    super.key,
    required this.text,
    required this.onPressed,
    this.icon,
  });

  final String text;
  final VoidCallback? onPressed;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      height: 52,
      child: ElevatedButton(
        onPressed: onPressed,
        style: ElevatedButton.styleFrom(
          backgroundColor: primaryBlue,
          foregroundColor: Colors.white,
          disabledBackgroundColor: primaryBlue.withAlpha(130),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(8),
          ),
          elevation: 4,
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(
              text,
              style: const TextStyle(fontWeight: FontWeight.w800),
            ),
            if (icon != null) ...[
              const SizedBox(width: 8),
              Icon(icon, size: 17),
            ],
          ],
        ),
      ),
    );
  }
}

class LightButton extends StatelessWidget {
  const LightButton({
    super.key,
    required this.text,
    required this.onPressed,
  });

  final String text;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      height: 52,
      child: ElevatedButton(
        onPressed: onPressed,
        style: ElevatedButton.styleFrom(
          backgroundColor: const Color(0xFFD8E8FF),
          foregroundColor: primaryBlue,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(8),
          ),
          elevation: 0,
        ),
        child: Text(
          text,
          style: const TextStyle(fontWeight: FontWeight.w800),
        ),
      ),
    );
  }
}

class SecondaryButton extends StatelessWidget {
  const SecondaryButton({
    super.key,
    required this.text,
    required this.iconText,
    required this.onPressed,
  });

  final String text;
  final String iconText;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      height: 48,
      child: OutlinedButton(
        onPressed: onPressed,
        style: OutlinedButton.styleFrom(
          foregroundColor: textDark,
          side: const BorderSide(color: Color(0xFFCBD5E1)),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(7),
          ),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(
              iconText,
              style: const TextStyle(
                color: Color(0xFFEA4335),
                fontWeight: FontWeight.w900,
              ),
            ),
            const SizedBox(width: 10),
            Text(
              text,
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
          ],
        ),
      ),
    );
  }
}

class DividerWithText extends StatelessWidget {
  const DividerWithText({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        const Expanded(child: Divider()),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Text(
            text,
            style: const TextStyle(fontSize: 11, color: Color(0xFF94A3B8)),
          ),
        ),
        const Expanded(child: Divider()),
      ],
    );
  }
}

class MessageBox extends StatelessWidget {
  const MessageBox({
    super.key,
    required this.message,
    required this.isError,
  });

  final String message;
  final bool isError;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: isError ? const Color(0xFFFEE2E2) : const Color(0xFFDCFCE7),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        message,
        style: TextStyle(
          color: isError ? const Color(0xFF991B1B) : const Color(0xFF166534),
          fontSize: 13,
        ),
      ),
    );
  }
}

class BottomNavItem extends StatelessWidget {
  const BottomNavItem({
    super.key,
    required this.icon,
    required this.label,
    this.active = false,
  });

  final IconData icon;
  final String label;
  final bool active;

  @override
  Widget build(BuildContext context) {
    if (active) {
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        decoration: BoxDecoration(
          color: primaryBlue,
          borderRadius: BorderRadius.circular(999),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, color: Colors.white, size: 20),
            const SizedBox(height: 2),
            Text(
              label,
              style: const TextStyle(
                color: Colors.white,
                fontSize: 10,
                fontWeight: FontWeight.w800,
              ),
            ),
          ],
        ),
      );
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, color: const Color(0xFF334155), size: 20),
        const SizedBox(height: 4),
        Text(
          label,
          style: const TextStyle(
            color: Color(0xFF334155),
            fontSize: 10,
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    );
  }
}