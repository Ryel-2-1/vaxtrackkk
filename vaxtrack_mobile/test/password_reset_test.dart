import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/models/app_user.dart';
import 'package:vaxtrack_mobile/services/auth_service.dart';
import 'package:vaxtrack_mobile/utils/password_reset.dart';

/// Records every password-reset call; fails the test on any other use.
class FakeAuth implements FirebaseAuth {
  final List<String> resetEmails = [];
  Object? error;
  Completer<void>? gate;

  @override
  Future<void> sendPasswordResetEmail({
    required String email,
    ActionCodeSettings? actionCodeSettings,
  }) async {
    resetEmails.add(email);
    if (gate != null) await gate!.future;
    if (error != null) throw error!;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('Password reset must not call FirebaseAuth.${invocation.memberName}');
}

/// Any Firestore access at all fails the test.
class ForbiddenFirestore implements FirebaseFirestore {
  int touches = 0;

  @override
  dynamic noSuchMethod(Invocation invocation) {
    touches += 1;
    throw StateError('Password reset must not use Firestore (${invocation.memberName})');
  }
}

void main() {
  const email = 'rider.one@example.test';

  late FakeAuth auth;
  late ForbiddenFirestore db;
  late AuthService service;
  late List<String> logs;
  late DebugPrintCallback originalDebugPrint;

  setUp(() {
    auth = FakeAuth();
    db = ForbiddenFirestore();
    service = AuthService(auth: auth, db: db);
    logs = [];
    originalDebugPrint = debugPrint;
    debugPrint = (String? message, {int? wrapWidth}) => logs.add(message ?? '');
  });

  tearDown(() {
    debugPrint = originalDebugPrint;
    // Never: a Firestore read or write, or the address in any log line.
    expect(db.touches, 0, reason: 'no Firestore read/write');
    for (final line in logs) {
      expect(line.contains(email), isFalse, reason: 'the email is never logged: $line');
      expect(line.toLowerCase().contains('example.test'), isFalse);
    }
  });

  group('AuthService.sendPasswordReset', () {
    test('sends the trimmed email exactly once and reports success', () async {
      final outcome = await service.sendPasswordReset('   $email \t');
      expect(auth.resetEmails, [email]);
      expect(outcome.accepted, isTrue);
      expect(outcome.errorMessage, isNull);
    });

    test('only surrounding whitespace is removed — the address is not altered', () async {
      await service.sendPasswordReset(' Rider.One+Ops@Example.TEST ');
      expect(auth.resetEmails, ['Rider.One+Ops@Example.TEST']);
    });

    test('user-not-found is reported exactly like a successful send', () async {
      auth.error = FirebaseAuthException(code: 'user-not-found', message: 'There is no user record for $email');
      final outcome = await service.sendPasswordReset(email);
      expect(outcome.accepted, isTrue);
      expect(outcome.errorMessage, isNull);
      expect(identical(outcome, PasswordResetOutcome.sent), isTrue);
    });

    test('user-disabled also reveals nothing', () async {
      auth.error = FirebaseAuthException(code: 'user-disabled');
      expect((await service.sendPasswordReset(email)).accepted, isTrue);
    });

    final cases = <String, String>{
      'invalid-email': 'Enter a valid email address.',
      'too-many-requests': 'Too many reset attempts. Wait a few minutes and try again.',
      'network-request-failed': 'You appear to be offline. Check your connection and try again.',
      'operation-not-allowed': 'Password reset is temporarily unavailable. Contact your administrator.',
      'internal-error': "We couldn't send the reset instructions. Please try again.",
      'some-future-code': "We couldn't send the reset instructions. Please try again.",
    };
    for (final entry in cases.entries) {
      test('${entry.key} → "${entry.value}"', () async {
        auth.error = FirebaseAuthException(
          code: entry.key,
          message: 'RAW FIREBASE TEXT for $email in project vaxtrack-xyz',
        );
        final outcome = await service.sendPasswordReset(email);
        expect(outcome.accepted, isFalse);
        expect(outcome.errorMessage, entry.value);
        expect(outcome.errorMessage, isNot(contains('RAW')));
        expect(outcome.errorMessage, isNot(contains('vaxtrack-')));
        expect(auth.resetEmails, [email], reason: 'one request, not retried');
      });
    }

    test('a non-Firebase failure is generic and logs only its type', () async {
      auth.error = Exception('socket closed while sending to $email');
      final outcome = await service.sendPasswordReset(email);
      expect(outcome.errorMessage, kResetUnknownMessage);
      expect(logs.single, 'AuthService: password reset failed (_Exception)');
    });

    test('a request that never answers ends as offline', () async {
      auth.gate = Completer<void>();
      final outcome = await service.sendPasswordReset(email, timeout: const Duration(milliseconds: 10));
      expect(outcome.errorMessage, kResetOfflineMessage);
    });

    test('blank and malformed emails never reach Firebase', () async {
      expect((await service.sendPasswordReset('   ')).errorMessage, kResetEmailRequiredMessage);
      expect((await service.sendPasswordReset('rider@nowhere')).errorMessage, kResetEmailInvalidMessage);
      expect((await service.sendPasswordReset('two words@x.ph')).errorMessage, kResetEmailInvalidMessage);
      expect(auth.resetEmails, isEmpty);
    });
  });

  group('validation', () {
    test('basic format', () {
      expect(validateResetEmail(''), kResetEmailRequiredMessage);
      for (final bad in ['rider', 'rider@', '@x.ph', 'rider@x', 'a b@x.ph', 'rider@@x.ph']) {
        expect(validateResetEmail(bad), kResetEmailInvalidMessage, reason: bad);
      }
      for (final ok in ['r@x.ph', 'rider.one+tag@sub.example.test']) {
        expect(validateResetEmail(ok), isNull, reason: ok);
      }
      expect(normalizeResetEmail('  A.B@C.d  '), 'A.B@C.d');
    });
  });

  group('PasswordResetController', () {
    late List<String> sent;
    late Completer<PasswordResetOutcome> pending;
    late DateTime now;
    late PasswordResetController controller;

    setUp(() {
      sent = [];
      pending = Completer<PasswordResetOutcome>();
      now = DateTime(2026, 10, 11, 9);
      controller = PasswordResetController(
        send: (e) {
          sent.add(e);
          return pending.future;
        },
        initialEmail: '  $email ',
        clock: () => now,
      );
    });

    test('prefills the trimmed email', () {
      expect(controller.email, email);
      expect(controller.status, PasswordResetStatus.editing);
    });

    test('rejects blank and invalid input without sending', () async {
      expect(await controller.submit('  '), isFalse);
      expect(controller.fieldError, kResetEmailRequiredMessage);
      expect(await controller.submit('nope'), isFalse);
      expect(controller.fieldError, kResetEmailInvalidMessage);
      expect(sent, isEmpty);
    });

    test('repeated submits while sending produce one request', () async {
      final first = controller.submit(' $email ');
      final second = controller.submit(email);
      final third = controller.submit(email);
      expect(controller.isSending, isTrue);
      pending.complete(PasswordResetOutcome.sent);
      expect(await first, isTrue);
      expect(await second, isFalse);
      expect(await third, isFalse);
      expect(sent, [email]);
      expect(controller.isSent, isTrue);
    });

    test('a failure keeps the email and returns to the form', () async {
      final run = controller.submit(email);
      pending.complete(const PasswordResetOutcome.failed(kResetOfflineMessage));
      await run;
      expect(controller.status, PasswordResetStatus.editing);
      expect(controller.requestError, kResetOfflineMessage);
      expect(controller.email, email);
    });

    test('a thrown sender error is shown generically', () async {
      final c = PasswordResetController(send: (_) async => throw StateError('raw details'));
      await c.submit(email);
      expect(c.requestError, kResetUnknownMessage);
      c.dispose();
    });

    test('resend waits for the cooldown, then sends to the same address', () async {
      final run = controller.submit(email);
      pending.complete(PasswordResetOutcome.sent);
      await run;
      expect(controller.canResend, isFalse);
      expect(controller.resendWait, kPasswordResetResendCooldown);
      expect(await controller.resend(), isFalse);
      now = now.add(const Duration(seconds: 29));
      expect(controller.canResend, isFalse);
      now = now.add(const Duration(seconds: 1));
      expect(controller.canResend, isTrue);
      pending = Completer<PasswordResetOutcome>()..complete(PasswordResetOutcome.sent);
      expect(await controller.resend(), isTrue);
      expect(sent, [email, email]);
      expect(controller.canResend, isFalse, reason: 'cooldown restarts');
    });

    test('a request finishing after dispose changes nothing and notifies nobody', () async {
      var notified = 0;
      controller.addListener(() => notified += 1);
      final run = controller.submit(email);
      final before = notified;
      controller.dispose();
      pending.complete(PasswordResetOutcome.sent);
      await run;
      expect(notified, before);
      expect(controller.isSent, isFalse);
    });
  });

  group('role enforcement after sign-in is unchanged', () {
    AppUser user(String role, String status) =>
        AppUser(uid: 'u1', email: '', name: '', role: role, status: status);
    test('only approved riders pass AuthGate', () {
      expect(AuthService.rejectionMessageFor(user('rider', 'approved')), isNull);
      expect(AuthService.rejectionMessageFor(user('rider', 'pending')), 'Your rider account is pending admin approval.');
      expect(AuthService.rejectionMessageFor(user('dispatcher', 'approved')),
          'This mobile app is for riders only. Please use the VaxTrack web portal.');
      expect(AuthService.rejectionMessageFor(user('rider', 'disabled')),
          'Your rider account is not active. Contact your administrator.');
      expect(AuthService.rejectionMessageFor(null), 'Rider profile not found. Please contact your administrator.');
    });
  });
}
