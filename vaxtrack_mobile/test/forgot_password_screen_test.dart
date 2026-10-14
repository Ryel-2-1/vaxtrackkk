import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/screens/forgot_password_screen.dart';
import 'package:vaxtrack_mobile/screens/login_screen.dart';
import 'package:vaxtrack_mobile/theme/app_theme.dart';
import 'package:vaxtrack_mobile/utils/password_reset.dart';

/// A reset sender the test controls: every call is recorded, and each one
/// waits for the test to answer it (or answers immediately with [auto]).
class FakeSender {
  FakeSender({this.auto});
  final PasswordResetOutcome? auto;
  final List<String> emails = [];
  final List<Completer<PasswordResetOutcome>> _pending = [];

  Future<PasswordResetOutcome> call(String email) {
    emails.add(email);
    if (auto != null) return Future.value(auto);
    final c = Completer<PasswordResetOutcome>();
    _pending.add(c);
    return c.future;
  }

  void answer(PasswordResetOutcome outcome) => _pending.removeAt(0).complete(outcome);
}

const _forgot = Key('forgotPasswordButton');
const _resetEmail = Key('resetEmailField');
const _send = Key('sendResetButton');
const _cancel = Key('cancelResetButton');
const _sent = Key('resetSentMessage');
const _backToSignIn = Key('backToSignInButton');
const _resend = Key('resendResetButton');

Widget _app(Widget home) => MaterialApp(theme: AppTheme.theme, home: home);

Future<void> _openReset(WidgetTester tester, FakeSender sender, {String loginEmail = ''}) async {
  await tester.pumpWidget(_app(LoginScreen(
    signIn: (_, _) async {},
    sendPasswordReset: sender.call,
  )));
  if (loginEmail.isNotEmpty) {
    await tester.enterText(find.byKey(const Key('loginEmailField')), loginEmail);
  }
  await tester.tap(find.byKey(_forgot));
  await tester.pumpAndSettle();
}

TextField _field(WidgetTester tester) => tester.widget<TextField>(find.byKey(_resetEmail));
ButtonStyleButton _button(WidgetTester tester, Key key) =>
    tester.widget<ButtonStyleButton>(find.byKey(key));

void main() {
  testWidgets('the login screen shows a Forgot password? action with a proper target and label', (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(_app(LoginScreen(signIn: (_, _) async {}, sendPasswordReset: FakeSender().call)));

    expect(find.text('Forgot password?'), findsOneWidget);
    final size = tester.getSize(find.byKey(_forgot));
    expect(size.height, greaterThanOrEqualTo(48));
    expect(size.width, greaterThanOrEqualTo(48));
    expect(
      tester.getSemantics(find.byKey(_forgot)),
      isSemantics(label: 'Forgot password? Reset your password', isButton: true, hasTapAction: true, isFocusable: true),
    );
    // Placed directly beneath the password field.
    expect(tester.getTopLeft(find.byKey(_forgot)).dy,
        greaterThan(tester.getBottomLeft(find.byKey(const Key('loginPasswordField'))).dy));
    handle.dispose();
  });

  testWidgets('it is reachable and operable with the keyboard', (tester) async {
    final sender = FakeSender();
    await tester.pumpWidget(_app(LoginScreen(signIn: (_, _) async {}, sendPasswordReset: sender.call)));
    await tester.tap(find.byKey(const Key('loginEmailField')));
    await tester.pump();

    bool forgotFocused() =>
        FocusManager.instance.primaryFocus?.context?.findAncestorWidgetOfExactType<TextButton>()?.key == _forgot;
    for (var i = 0; i < 8 && !forgotFocused(); i++) {
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
    }
    expect(forgotFocused(), isTrue, reason: 'Tab reaches the action');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.text('Reset password'), findsWidgets, reason: 'Enter activates it');
  });

  testWidgets('the reset screen has the title, explanation, prefilled email and actions', (tester) async {
    await _openReset(tester, FakeSender(), loginEmail: '  rider@example.test ');
    expect(find.text('Reset password'), findsWidgets);
    expect(
      find.text("Enter the email address connected to your VaxTrack account. We'll send instructions for creating a new password."),
      findsOneWidget,
    );
    expect(_field(tester).controller!.text, 'rider@example.test', reason: 'prefilled from the login field');
    expect(find.text('Send reset link'), findsOneWidget);
    expect(find.text('Cancel'), findsOneWidget);
  });

  testWidgets('blank and invalid emails are rejected without a request', (tester) async {
    final sender = FakeSender();
    await _openReset(tester, sender);
    await tester.tap(find.byKey(_send));
    await tester.pump();
    expect(find.text('Enter your email address.'), findsOneWidget);

    await tester.enterText(find.byKey(_resetEmail), 'rider@nowhere');
    await tester.tap(find.byKey(_send));
    await tester.pump();
    expect(find.text('Enter a valid email address.'), findsOneWidget);
    expect(sender.emails, isEmpty);
  });

  testWidgets('a valid email is sent once, trimmed; repeated taps do not duplicate it', (tester) async {
    final sender = FakeSender();
    await _openReset(tester, sender);
    await tester.enterText(find.byKey(_resetEmail), '  rider@example.test  ');
    await tester.tap(find.byKey(_send));
    await tester.pump();
    // While sending: disabled actions, a progress indicator, the field locked.
    expect(_button(tester, _send).onPressed, isNull);
    expect(_button(tester, _cancel).onPressed, isNull);
    expect(_field(tester).enabled, isFalse);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    await tester.tap(find.byKey(_send), warnIfMissed: false);
    await tester.tap(find.byKey(_send), warnIfMissed: false);
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pump();
    expect(sender.emails, ['rider@example.test']);

    sender.answer(PasswordResetOutcome.sent);
    await tester.pumpAndSettle();
    expect(find.byKey(_sent), findsOneWidget);
    expect(find.text(kPasswordResetSentMessage), findsOneWidget);
    expect(sender.emails, hasLength(1));
  });

  testWidgets('an unknown account looks exactly like a successful send', (tester) async {
    final sender = FakeSender(auto: passwordResetOutcomeForCode('user-not-found'));
    await _openReset(tester, sender, loginEmail: 'nobody@example.test');
    await tester.tap(find.byKey(_send));
    await tester.pumpAndSettle();
    expect(find.text(kPasswordResetSentMessage), findsOneWidget);
    for (final leak in ['not found', 'no account', 'not registered', 'does not exist', 'rider', 'dispatcher']) {
      expect(find.textContaining(RegExp(leak, caseSensitive: false)), findsNothing, reason: leak);
    }
    expect(find.byKey(const Key('resetRequestError')), findsNothing);
  });

  testWidgets('a failure shows the mapped message and keeps the email', (tester) async {
    final sender = FakeSender(auto: passwordResetOutcomeForCode('network-request-failed'));
    await _openReset(tester, sender, loginEmail: 'rider@example.test');
    await tester.tap(find.byKey(_send));
    await tester.pumpAndSettle();
    expect(find.text(kResetOfflineMessage), findsOneWidget);
    expect(find.byKey(_sent), findsNothing);
    expect(_field(tester).controller!.text, 'rider@example.test');
    expect(_button(tester, _send).onPressed, isNotNull, reason: 'the rider can try again');
  });

  testWidgets('Cancel returns to sign-in without sending', (tester) async {
    final sender = FakeSender();
    await _openReset(tester, sender, loginEmail: 'rider@example.test');
    await tester.tap(find.byKey(_cancel));
    await tester.pumpAndSettle();
    expect(find.byType(ForgotPasswordScreen), findsNothing);
    expect(find.byType(LoginScreen), findsOneWidget);
    expect(sender.emails, isEmpty);
  });

  testWidgets('Back to sign in returns to the login screen without signing in', (tester) async {
    final sender = FakeSender(auto: PasswordResetOutcome.sent);
    var signIns = 0;
    await tester.pumpWidget(_app(LoginScreen(
      signIn: (_, _) async => signIns++,
      sendPasswordReset: sender.call,
    )));
    await tester.enterText(find.byKey(const Key('loginEmailField')), 'rider@example.test');
    await tester.tap(find.byKey(_forgot));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(_send));
    await tester.pumpAndSettle();
    expect(find.byKey(_sent), findsOneWidget);

    await tester.tap(find.byKey(_backToSignIn));
    await tester.pumpAndSettle();
    expect(find.byType(LoginScreen), findsOneWidget);
    expect(find.byType(ForgotPasswordScreen), findsNothing);
    expect(signIns, 0, reason: 'no automatic sign-in');
  });

  testWidgets('resend is disabled during the cooldown, then sends to the same address', (tester) async {
    final sender = FakeSender(auto: PasswordResetOutcome.sent);
    var now = DateTime(2026, 10, 11, 9);
    await tester.pumpWidget(_app(ForgotPasswordScreen(
      sendReset: sender.call,
      initialEmail: 'rider@example.test',
      clock: () => now,
    )));
    await tester.tap(find.byKey(_send));
    await tester.pump();
    await tester.pump();

    expect(_button(tester, _resend).onPressed, isNull);
    expect(find.text('Resend in 30s'), findsOneWidget);
    now = now.add(const Duration(seconds: 10));
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('Resend in 20s'), findsOneWidget);
    now = now.add(const Duration(seconds: 20));
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('Resend'), findsOneWidget);
    expect(_button(tester, _resend).onPressed, isNotNull);

    await tester.tap(find.byKey(_resend));
    await tester.pump();
    await tester.pump();
    expect(sender.emails, ['rider@example.test', 'rider@example.test']);
    expect(_button(tester, _resend).onPressed, isNull, reason: 'the cooldown restarts');
    expect(find.text(kPasswordResetSentMessage), findsOneWidget);
  });

  testWidgets('closing the screen while sending is safe when the request finishes later', (tester) async {
    final sender = FakeSender();
    await _openReset(tester, sender, loginEmail: 'rider@example.test');
    await tester.tap(find.byKey(_send));
    await tester.pump();
    // System/app-bar back while the request is in flight.
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.byType(ForgotPasswordScreen), findsNothing);

    sender.answer(PasswordResetOutcome.sent);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull, reason: 'no setState after dispose');
    expect(find.byType(SnackBar), findsNothing);
    expect(find.text(kPasswordResetSentMessage), findsNothing);
  });

  group('small screens and large text', () {
    Future<void> layoutAt(WidgetTester tester, {required double textScale}) async {
      tester.view.physicalSize = const Size(320, 800);
      tester.view.devicePixelRatio = 1;
      tester.platformDispatcher.textScaleFactorTestValue = textScale;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);

      final sender = FakeSender(auto: passwordResetOutcomeForCode('too-many-requests'));
      await _openReset(tester, sender, loginEmail: 'a.very.long.rider.address@example-clinic.test');
      expect(find.byType(ForgotPasswordScreen), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.ensureVisible(find.byKey(_send));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(_send));
      await tester.pumpAndSettle();
      expect(find.text(kResetTooManyRequestsMessage), findsOneWidget);
      expect(tester.takeException(), isNull, reason: 'form with an error');

      final ok = FakeSender(auto: PasswordResetOutcome.sent);
      await tester.pumpWidget(const SizedBox()); // a fresh navigator, not the pushed route
      await tester.pumpWidget(_app(ForgotPasswordScreen(sendReset: ok.call, initialEmail: 'r@example.test')));
      await tester.ensureVisible(find.byKey(_send));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(_send));
      await tester.pumpAndSettle();
      expect(find.byKey(_sent), findsOneWidget);
      expect(tester.takeException(), isNull, reason: 'confirmation');
      await tester.pump(const Duration(seconds: 31));
    }

    testWidgets('320×800 dp at normal text size', (tester) async {
      await tester.pumpWidget(_app(LoginScreen(signIn: (_, _) async {}, sendPasswordReset: FakeSender().call)));
      await layoutAt(tester, textScale: 1.0);
    });

    testWidgets('320×800 dp at 2× text size', (tester) async {
      await layoutAt(tester, textScale: 2.0);
      // The login screen itself, with the new action, at the same size.
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(_app(LoginScreen(signIn: (_, _) async {}, sendPasswordReset: FakeSender().call)));
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(find.byKey(_forgot), findsOneWidget);
    });
  });
}
