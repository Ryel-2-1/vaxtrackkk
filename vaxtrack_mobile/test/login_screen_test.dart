import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/screens/login_screen.dart';
import 'package:vaxtrack_mobile/services/auth_service.dart';
import 'package:vaxtrack_mobile/theme/app_theme.dart';
import 'package:vaxtrack_mobile/utils/password_reset.dart';

/// Regression: the existing sign-in behaviour is unchanged by Forgot Password.
void main() {
  const emailKey = Key('loginEmailField');
  const passwordKey = Key('loginPasswordField');

  Future<PasswordResetOutcome> noReset(String _) async => PasswordResetOutcome.sent;

  Future<void> pump(WidgetTester tester, RiderSignIn signIn) => tester.pumpWidget(MaterialApp(
        theme: AppTheme.theme,
        home: LoginScreen(signIn: signIn, sendPasswordReset: noReset),
      ));

  ElevatedButton signInButton(WidgetTester tester) =>
      tester.widget<ElevatedButton>(find.widgetWithText(ElevatedButton, 'Sign In'));

  testWidgets('blank fields are rejected before any sign-in', (tester) async {
    var calls = 0;
    await pump(tester, (_, _) async => calls++);
    await tester.tap(find.text('Sign In'));
    await tester.pump();
    expect(find.text('Please enter email and password.'), findsOneWidget);
    await tester.enterText(find.byKey(emailKey), 'rider@example.test');
    await tester.tap(find.text('Sign In'));
    await tester.pump();
    expect(find.text('Please enter email and password.'), findsOneWidget);
    expect(calls, 0);
  });

  testWidgets('a normal sign-in sends the trimmed email and the password once', (tester) async {
    final calls = <List<String>>[];
    final pending = Completer<void>();
    await pump(tester, (email, password) {
      calls.add([email, password]);
      return pending.future;
    });
    await tester.enterText(find.byKey(emailKey), '  rider@example.test ');
    await tester.enterText(find.byKey(passwordKey), ' secret ');
    await tester.tap(find.text('Sign In'));
    await tester.pump();
    expect(calls, [
      ['rider@example.test', ' secret '],
    ], reason: 'the password is never trimmed');
    // Loading: Sign In and Forgot password? are disabled until it finishes.
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(tester.widget<TextButton>(find.byKey(const Key('forgotPasswordButton'))).onPressed, isNull);
    pending.complete();
    await tester.pumpAndSettle();
    expect(signInButton(tester).onPressed, isNotNull);
  });

  testWidgets('sign-in errors keep their existing messages', (tester) async {
    for (final entry in {
      'wrong-password': 'Invalid email or password.',
      'user-not-found': 'Invalid email or password.',
      'invalid-credential': 'Invalid email or password.',
      'user-disabled': 'Your rider account is not active. Contact your administrator.',
      'too-many-requests': 'Too many attempts. Please try again later.',
      'network-request-failed': 'Network error. Please try again.',
    }.entries) {
      await tester.pumpWidget(const SizedBox());
      await pump(tester, (_, _) async => throw FirebaseAuthException(code: entry.key));
      await tester.enterText(find.byKey(emailKey), 'rider@example.test');
      await tester.enterText(find.byKey(passwordKey), 'secret1');
      await tester.tap(find.text('Sign In'));
      await tester.pumpAndSettle();
      expect(find.text(entry.value), findsOneWidget, reason: entry.key);
    }
  });

  testWidgets('the password visibility toggle still works', (tester) async {
    await pump(tester, (_, _) async {});
    TextField password() => tester.widget<TextField>(find.byKey(passwordKey));
    expect(password().obscureText, isTrue);
    await tester.tap(find.byIcon(Icons.visibility_off));
    await tester.pump();
    expect(password().obscureText, isFalse);
    await tester.tap(find.byIcon(Icons.visibility));
    await tester.pump();
    expect(password().obscureText, isTrue);
  });

  testWidgets('a message left by AuthGate is still shown on the next mount', (tester) async {
    AuthService.pendingLoginMessage = 'Your rider account is pending admin approval.';
    await pump(tester, (_, _) async {});
    expect(find.text('Your rider account is pending admin approval.'), findsOneWidget);
    expect(AuthService.pendingLoginMessage, isNull);
  });
}
