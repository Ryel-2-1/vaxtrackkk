import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// Does AuthGate's build() — which creates `authStateChanges()` and, per auth
/// event, the profile Future — ever run again for the SAME gate?
///
/// AuthGate calls FirebaseAuth.instance in build(), so it cannot be pumped
/// without Firebase. These tests therefore check the two facts its stability
/// rests on, rather than AuthGate itself:
///   1. at runtime, a const, dependency-free StatelessWidget used as
///      MaterialApp.home (exactly AuthGate's position and shape) is built ONCE
///      across every ordinary app-level change, and is mounted afresh — not
///      rebuilt — by the sign-out / registration navigation;
///   2. in the source, AuthGate is still that shape: const as `home`,
///      a StatelessWidget, and its build() reads no inherited widget.
/// Hot reload re-runs every build() — a debug-only event, not covered here.

int probeBuilds = 0;

/// Same shape as AuthGate: const StatelessWidget, no context dependencies.
class _Probe extends StatelessWidget {
  const _Probe();
  @override
  Widget build(BuildContext context) {
    probeBuilds += 1;
    return const Text('gate');
  }
}

class _App extends StatefulWidget {
  const _App();
  @override
  State<_App> createState() => _AppState();
}

class _AppState extends State<_App> {
  ThemeData theme = ThemeData(colorSchemeSeed: Colors.green);
  void change() => setState(() => theme = ThemeData(colorSchemeSeed: Colors.red));

  @override
  Widget build(BuildContext context) => MaterialApp(
        theme: theme,
        home: const _Probe(),
        routes: {'/other': (_) => const Scaffold(body: Text('other'))},
      );
}

void main() {
  setUp(() => probeBuilds = 0);

  testWidgets('built once across app rebuilds, theme, size, text scale, brightness and route push/pop', (tester) async {
    await tester.pumpWidget(const _App());
    expect(probeBuilds, 1);

    tester.state<_AppState>(find.byType(_App)).change(); // MaterialApp rebuilds
    await tester.pumpAndSettle();

    tester.view.physicalSize = const Size(400, 900); // rotation / resize / keyboard
    addTearDown(tester.view.reset);
    await tester.pumpAndSettle();

    tester.platformDispatcher.textScaleFactorTestValue = 1.6;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpAndSettle();

    tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
    addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
    await tester.pumpAndSettle();

    final nav = tester.state<NavigatorState>(find.byType(Navigator));
    nav.pushNamed('/other');
    await tester.pumpAndSettle();
    nav.pop();
    await tester.pumpAndSettle();

    expect(probeBuilds, 1, reason: 'build() — and so the auth stream it creates — ran once');
  });

  testWidgets("sign-out navigation (pushNamedAndRemoveUntil('/')) MOUNTS a new gate; the old one is disposed", (tester) async {
    await tester.pumpWidget(const _App());
    final firstElement = tester.element(find.byType(_Probe));
    final nav = tester.state<NavigatorState>(find.byType(Navigator));
    nav.pushNamedAndRemoveUntil('/', (route) => false);
    await tester.pumpAndSettle();

    expect(find.byType(_Probe), findsOneWidget);
    expect(tester.element(find.byType(_Probe)), isNot(same(firstElement)),
        reason: 'a fresh gate (new subscription), not a rebuild of the old one');
    expect(firstElement.mounted, isFalse, reason: "the old gate — and its subscription — is gone");
    expect(probeBuilds, 2);
  });

  test('AuthGate is still that shape: const home, StatelessWidget, build() reads no inherited widget', () {
    final src = File('lib/app.dart').readAsStringSync();
    expect(src, contains('home: const AuthGate(),'));
    expect(src, contains('class AuthGate extends StatelessWidget'));
    final gate = src.substring(src.indexOf('class AuthGate'), src.indexOf('class _ProfileResult'));
    // Theme.of / MediaQuery.of / Navigator.of / dependOnInheritedWidget… in
    // AuthGate would make its build() re-run (re-creating authStateChanges()).
    expect(RegExp(r'\.of\(|\.maybeOf\(|dependOnInherited|context\.watch').hasMatch(gate), isFalse);
  });
}
