import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/utils/navigation_init_controller.dart';

/// Configurable, platform-free harness around [NavigationInitController]. Every
/// injected dependency is a plain fake — no Firebase, no method channels. Fields
/// are mutable so a test can change behaviour between the first attempt and a
/// retry.
class _Harness {
  _Harness({
    this.permission = true,
    this.termsAccepted = false,
    this.termsDialogResult = true,
    this.throwOnInit = false,
    Object? initError,
    this.resetClearsTerms = true,
    bool Function(Object)? isTermsError,
  }) : initError = initError ?? StateError('init failed') {
    controller = NavigationInitController(
      ensurePermission: () async {
        calls.add('perm');
        return permission;
      },
      areTermsAccepted: () async {
        calls.add('areTerms');
        return termsAccepted;
      },
      showTerms: () async {
        calls.add('showTerms');
        if (dialogGate != null) await dialogGate!.future;
        return termsDialogResult;
      },
      initSession: () async {
        calls.add('init');
        if (initGate != null) await initGate!.future;
        if (throwOnInit) throw this.initError;
      },
      disposeSession: () async {
        calls.add('dispose');
      },
      resetTerms: () async {
        calls.add('reset');
        if (resetClearsTerms) termsAccepted = false;
      },
      isTermsError: isTermsError,
      onChange: () => phases.add(controller.phase),
      onError: (e) => errors.add(e),
      onLog: (m) => logs.add(m),
    );
  }

  bool permission;
  bool termsAccepted;
  bool termsDialogResult;
  bool throwOnInit;
  Object initError;
  bool resetClearsTerms;

  /// When set, `initSession` blocks until this completes (models a slow init).
  Completer<void>? initGate;

  /// When set, `showTerms` blocks until this completes (models the dialog being
  /// on screen while the rider reads it).
  Completer<void>? dialogGate;

  late final NavigationInitController controller;
  final List<String> calls = [];
  final List<NavInitPhase> phases = [];
  final List<Object> errors = [];
  final List<String> logs = [];

  int get initCalls => calls.where((c) => c == 'init').length;
  int get dialogCalls => calls.where((c) => c == 'showTerms').length;
  int get resetCalls => calls.where((c) => c == 'reset').length;
  int get disposeCalls => calls.where((c) => c == 'dispose').length;
}

bool _isTerms(Object e) => e.toString().contains('termsNotAccepted');

void main() {
  test('1. first attempt: terms unaccepted, dialog false -> declined', () async {
    final h = _Harness(termsAccepted: false, termsDialogResult: false);
    await h.controller.start();

    expect(h.controller.phase, NavInitPhase.declined);
    expect(h.dialogCalls, 1);
    expect(h.initCalls, 0);
    expect(h.controller.ownsSession, isFalse);
  });

  test('2. in-flight guard is cleared after decline (button re-enables)', () async {
    final h = _Harness(termsAccepted: false, termsDialogResult: false);
    await h.controller.start();
    expect(h.controller.isBusy, isFalse);
  });

  test('3./5. retry re-invokes the dialog; two attempts => dialogCount 2', () async {
    final h = _Harness(termsAccepted: false, termsDialogResult: false);
    await h.controller.start(); // decline 1
    expect(h.dialogCalls, 1);
    await h.controller.retry(); // still unaccepted -> dialog again -> decline 2
    expect(h.controller.phase, NavInitPhase.declined);
    expect(h.dialogCalls, 2);
    expect(h.initCalls, 0);
  });

  test('4. second dialog returns true -> session initializes exactly once', () async {
    final h = _Harness(termsAccepted: false, termsDialogResult: false);
    await h.controller.start(); // decline
    h.termsDialogResult = true; // rider accepts on the retry
    await h.controller.retry();
    expect(h.controller.phase, NavInitPhase.ready);
    expect(h.dialogCalls, 2);
    expect(h.initCalls, 1);
    expect(h.controller.initCount, 1);
  });

  test('6. rapid double-tap during an attempt -> only ONE native dialog', () async {
    final h = _Harness(termsAccepted: false, termsDialogResult: true);
    h.dialogGate = Completer<void>(); // hold the dialog "open"

    final first = h.controller.start();
    await pumpEventQueue();
    expect(h.controller.phase, NavInitPhase.awaitingTermsDecision);
    expect(h.dialogCalls, 1);

    // second + third taps while the dialog is up are ignored (in flight)
    await h.controller.retry();
    await h.controller.start();
    expect(h.dialogCalls, 1, reason: 'still only one dialog');

    h.dialogGate!.complete();
    await first;
    expect(h.controller.phase, NavInitPhase.ready);
    expect(h.dialogCalls, 1);
  });

  test('7./8. review/retry re-runs the flow and button is enabled after decline',
      () async {
    final h = _Harness(termsAccepted: false, termsDialogResult: false);
    await h.controller.start();
    expect(h.controller.isBusy, isFalse); // #7 button enabled
    final dialogsBefore = h.dialogCalls;
    await h.controller.retry(); // #8 retry invokes the flow again
    expect(h.dialogCalls, dialogsBefore + 1);
  });

  test('9. an init exception clears the guard and allows retry', () async {
    final h = _Harness(termsAccepted: true, throwOnInit: true); // generic error
    await h.controller.start();
    expect(h.controller.phase, NavInitPhase.failed);
    expect(h.controller.isBusy, isFalse); // guard cleared
    // retry is not blocked
    h.throwOnInit = false;
    await h.controller.retry();
    expect(h.controller.phase, NavInitPhase.ready);
  });

  test('10. map stays gated until init succeeds (shouldShowMap)', () async {
    final h = _Harness(termsAccepted: false, termsDialogResult: false);
    expect(h.controller.shouldShowMap, isFalse); // idle
    await h.controller.start();
    expect(h.controller.phase, NavInitPhase.declined);
    expect(h.controller.shouldShowMap, isFalse); // declined
    h.termsDialogResult = true;
    await h.controller.retry();
    expect(h.controller.phase, NavInitPhase.ready);
    expect(h.controller.shouldShowMap, isTrue); // only now
  });

  group('termsNotAccepted-from-init recovery (the regression)', () {
    test('areTermsAccepted=true but init rejects termsNotAccepted: resets + '
        'retry re-shows the dialog', () async {
      final h = _Harness(
        termsAccepted: true, // SDK claims accepted, so the dialog is skipped
        throwOnInit: true,
        initError: 'SessionInitializationException(termsNotAccepted)',
        isTermsError: _isTerms,
        resetClearsTerms: true,
      );

      // Attempt 1: no dialog, init throws termsNotAccepted -> reset -> declined.
      await h.controller.start();
      expect(h.controller.phase, NavInitPhase.declined);
      expect(h.dialogCalls, 0, reason: 'dialog was skipped (areTermsAccepted true)');
      expect(h.resetCalls, 1, reason: 'stale terms flag reset');
      expect(h.termsAccepted, isFalse, reason: 'reset cleared the flag');

      // Attempt 2 (Review terms): now unaccepted -> dialog IS shown this time.
      h.throwOnInit = false; // accepting terms makes init succeed
      await h.controller.retry();
      expect(h.dialogCalls, 1, reason: 'dialog finally invoked on retry');
      expect(h.controller.phase, NavInitPhase.ready);
      expect(h.controller.initCount, 1);
    });

    test('force flag still shows the dialog even if reset does not clear the '
        'flag', () async {
      final h = _Harness(
        termsAccepted: true,
        throwOnInit: true,
        initError: 'SessionInitializationException(termsNotAccepted)',
        isTermsError: _isTerms,
        resetClearsTerms: false, // reset ineffective -> areTermsAccepted stays true
      );
      await h.controller.start(); // declined, force flag set
      expect(h.dialogCalls, 0);

      await h.controller.retry(); // forced dialog despite areTermsAccepted==true
      expect(h.dialogCalls, 1, reason: 'forced dialog on retry');
    });
  });

  test('permission denied -> failed, no dialog, no init', () async {
    final h = _Harness(permission: false);
    await h.controller.start();
    expect(h.controller.phase, NavInitPhase.failed);
    expect(h.controller.reason, 'permission');
    expect(h.dialogCalls, 0);
    expect(h.initCalls, 0);
  });

  test('stage logs cover permission, terms check, dialog request, and result',
      () async {
    final h = _Harness(termsAccepted: false, termsDialogResult: false);
    await h.controller.start();
    expect(h.logs, containsAllInOrder([
      'checking location permission',
      'checking terms acceptance',
      'requesting native terms dialog',
    ]));
    expect(h.logs.any((l) => l.startsWith('native terms dialog result:')), isTrue);
  });
}
