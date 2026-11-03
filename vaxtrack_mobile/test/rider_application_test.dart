import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/screens/login_screen.dart';
import 'package:vaxtrack_mobile/screens/register_screen.dart';
import 'package:vaxtrack_mobile/theme/app_branding.dart';
import 'package:vaxtrack_mobile/utils/password_policy.dart';
import 'package:vaxtrack_mobile/utils/rider_application_validation.dart';
import 'package:vaxtrack_mobile/widgets/skeleton.dart';

void main() {
  group('password rules', () {
    test('8+ characters with upper, lower and a number pass', () {
      final a = assessPassword('Motor2026', email: 'juan@example.com', fullName: 'Juan Dela Cruz');
      expect(a.isValid, isTrue);
      expect(a.strength, PasswordStrength.fair);
    });

    test('each missing rule is reported', () {
      PasswordRule? failing(String pw) {
        final a = assessPassword(pw, email: 'juan@example.com', fullName: 'Juan Dela Cruz');
        return a.rules.entries.where((e) => !e.value).map((e) => e.key).firstOrNull;
      }

      expect(failing('Moto26'), PasswordRule.length);
      expect(failing('MOTOR2026'), PasswordRule.lowercase);
      expect(failing('motor2026'), PasswordRule.uppercase);
      expect(failing('MotorBike'), PasswordRule.number);
      expect(failing(' Motor2026'), PasswordRule.noEdgeSpaces);
      expect(failing('Juan2026x'), PasswordRule.notPersonal, reason: 'name');
      expect(failing('xJUAN99yy'), PasswordRule.notPersonal, reason: 'email local part, any case');
      expect(failing('Password123'), PasswordRule.notCommon);
      expect(failing('a' * 129 + 'A1'), PasswordRule.length, reason: 'over the maximum');
    });

    test('strength grows with length and symbols, only once every rule is met', () {
      expect(assessPassword('motorbike').strength, PasswordStrength.weak);
      expect(assessPassword('Motorbike2026').strength, PasswordStrength.good);
      expect(assessPassword('Motor#2026').strength, PasswordStrength.good);
      expect(assessPassword('Cold-Chain#Rider2026').strength, PasswordStrength.strong);
    });

    test('the first problem reads as a sentence', () {
      expect(assessPassword('abc').firstProblem, 'Password needs: at least 8 characters.');
      expect(assessPassword('Motor2026').firstProblem, isNull);
    });
  });

  group('application fields', () {
    test('full name needs first and last name', () {
      expect(validateFullName(''), isNotNull);
      expect(validateFullName('Juan'), isNotNull);
      expect(validateFullName('Juan Dela Cruz'), isNull);
      expect(validateFullName("Ma. Niña O'Neil-Reyes"), isNull);
      expect(validateFullName('Juan 2'), isNotNull);
    });

    test('email shape', () {
      expect(validateEmail('juan@example.com'), isNull);
      expect(validateEmail(' juan@example.com '), isNull);
      for (final bad in ['', 'juan', 'juan@', 'juan@example', 'juan @example.com']) {
        expect(validateEmail(bad), isNotNull, reason: bad);
      }
    });

    test('PH mobile numbers in any common form, stored as 09XXXXXXXXX', () {
      for (final ok in ['09171234567', '0917 123 4567', '0917-123-4567', '+639171234567', '639171234567']) {
        expect(normalizePhMobile(ok), '09171234567', reason: ok);
        expect(validatePhone(ok), isNull, reason: ok);
      }
      for (final bad in ['', '0917123456', '08171234567', '+11234567890', '(02) 8123 4567']) {
        expect(validatePhone(bad), isNotNull, reason: bad);
      }
    });

    test('plates: letters and digits, normalised to upper case', () {
      expect(normalizePlate(' 123-abc '), '123 ABC');
      for (final ok in ['123 ABC', 'AB 1234', '1234 AB', 'ab12345']) {
        expect(validatePlate(ok), isNull, reason: ok);
      }
      for (final bad in ['', 'ABC', '1234', 'A1', 'ABCDE 12345', 'AB#123']) {
        expect(validatePlate(bad), isNotNull, reason: bad);
      }
    });

    test('confirmation must match', () {
      expect(validatePasswordConfirmation('Motor2026', ''), isNotNull);
      expect(validatePasswordConfirmation('Motor2026', 'Motor2025'), "Passwords don't match.");
      expect(validatePasswordConfirmation('Motor2026', 'Motor2026'), isNull);
    });
  });

  group('screens', () {
    Widget app(Widget home) => MaterialApp(home: home);

    testWidgets('sign-in shows the VaxTrack icon and an Apply as a rider button', (tester) async {
      await tester.pumpWidget(app(LoginScreen(signIn: (_, _) async {})));
      expect(find.byType(VaxTrackLogo), findsOneWidget);
      expect(find.byKey(const Key('applyAsRiderButton')), findsOneWidget);
      expect(find.byIcon(Icons.local_shipping), findsNothing, reason: 'the old truck placeholder is gone');
    });

    testWidgets('sign-in refuses a malformed email before calling Firebase', (tester) async {
      var calls = 0;
      await tester.pumpWidget(app(LoginScreen(signIn: (_, _) async => calls++)));
      await tester.enterText(find.byKey(const Key('loginEmailField')), 'juan@example');
      await tester.enterText(find.byKey(const Key('loginPasswordField')), 'whatever');
      await tester.tap(find.text('Sign In'));
      await tester.pump();
      expect(find.text('Please enter a valid email address.'), findsOneWidget);
      expect(calls, 0);
    });

    testWidgets('apply: the checklist ticks rules as the password is typed', (tester) async {
      await tester.pumpWidget(app(const RegisterScreen()));
      expect(find.byKey(const Key('passwordChecklist')), findsOneWidget);
      expect(find.byIcon(Icons.check_circle), findsNothing);
      await tester.enterText(find.byKey(const Key('registerPassword')), 'Motor2026');
      await tester.pump();
      expect(find.byIcon(Icons.check_circle), findsNWidgets(PasswordRule.values.length));
      expect(find.text('Fair'), findsOneWidget);
    });

    testWidgets('apply: submitting with bad fields shows each problem and sends nothing', (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(app(const RegisterScreen()));
      await tester.enterText(find.byKey(const Key('registerFullName')), 'Juan');
      await tester.enterText(find.byKey(const Key('registerPhone')), '12345');
      await tester.enterText(find.byKey(const Key('registerPlate')), 'ABC');
      await tester.enterText(find.byKey(const Key('registerEmail')), 'juan@');
      await tester.enterText(find.byKey(const Key('registerPassword')), 'motor');
      await tester.enterText(find.byKey(const Key('registerConfirmPassword')), 'motor2');
      await tester.ensureVisible(find.byKey(const Key('registerSubmit')));
      await tester.tap(find.byKey(const Key('registerSubmit')));
      await tester.pump();
      expect(find.text('Check the highlighted fields.'), findsOneWidget);
      expect(find.text('Enter your first and last name.'), findsOneWidget);
      expect(find.text('Enter a PH mobile number, like 0917 123 4567.'), findsOneWidget);
      expect(find.text('Enter the plate as shown, like 123 ABC.'), findsOneWidget);
      expect(find.text("Passwords don't match."), findsOneWidget);
      expect(find.text('Password needs: at least 8 characters.'), findsOneWidget);
    });

    testWidgets('skeletons render without errors and keep their shape', (tester) async {
      await tester.pumpWidget(const MaterialApp(home: SkeletonHome()));
      await tester.pump(const Duration(milliseconds: 450));
      expect(find.byKey(const Key('skeleton-home')), findsOneWidget);
      expect(find.byType(SkeletonDeliveryCard), findsNWidgets(3));
      await tester.pumpWidget(const MaterialApp(home: Scaffold(body: SkeletonDeliveryList())));
      await tester.pump(const Duration(milliseconds: 450));
      expect(find.byKey(const Key('skeleton-delivery-list')), findsOneWidget);
    });
  });
}
