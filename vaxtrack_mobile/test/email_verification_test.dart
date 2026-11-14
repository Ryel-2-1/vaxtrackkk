import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/services/auth_service.dart';

// An administrator can approve a rider only once their email is verified
// (2026-11-14). The sign-in message tells an unverified rider what to do.
void main() {
  test('an unverified pending rider is told to open the new link', () {
    final message = AuthService.pendingMessage(emailVerified: false, email: ' rider@example.test ');
    expect(message, contains('Verify your email first'));
    expect(message, contains('to rider@example.test'));
    expect(message, contains('only after that'));
  });

  test('without an email address the message still reads correctly', () {
    final message = AuthService.pendingMessage(emailVerified: false, email: null);
    expect(message, startsWith('Verify your email first: we sent a new link. '));
  });

  test('a verified pending rider just waits for approval', () {
    expect(AuthService.pendingMessage(emailVerified: true, email: 'r@x.test'),
        'Your rider account is pending admin approval.');
  });
}
