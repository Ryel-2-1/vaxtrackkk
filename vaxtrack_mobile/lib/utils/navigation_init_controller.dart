/// Phase of the embedded Google Navigation consent + session-initialization
/// flow. The Google Navigation SDK is the source of truth for terms acceptance
/// (via `areTermsAccepted()`); this controller only sequences and guards the
/// flow so the widget never initializes twice, shows two Terms dialogs, or
/// updates state after disposal.
enum NavInitPhase {
  /// Nothing has started yet (before the first frame).
  idle,

  /// Checking permission / terms, or initializing the session (quick,
  /// non-interactive steps).
  preparing,

  /// The native Terms & Conditions dialog is expected to be on screen, waiting
  /// for the rider. Deliberately NOT a spinner state (see the screen), and the
  /// map is never rendered here.
  awaitingTermsDecision,

  /// The rider declined (or closed) the Terms — no session was initialized.
  declined,

  /// Initialization failed for a non-terms reason (e.g. Maps key / SDK config).
  failed,

  /// The session initialized successfully; the platform map may now render.
  ready,
}

/// Pure, platform-free coordinator for the embedded-navigation start-up flow.
///
/// All external effects are injected (permission check, terms check, terms
/// dialog, session init/dispose, terms reset), so the whole state machine is
/// deterministically unit-testable with plain fakes — no Firebase, no method
/// channels, no widget harness. The real screen wires these to
/// `GoogleMapsNavigator` / `Geolocator`.
///
/// Guarantees:
///  * only ONE attempt runs at a time — concurrent [start]/[retry] calls while
///    one is in flight are ignored (single native dialog per attempt);
///  * once [NavInitPhase.ready], further [start] calls are no-ops;
///  * `initSession` is only called AFTER terms are accepted;
///  * the in-flight guard is released in `finally` on EVERY outcome (decline,
///    exception, disposal), followed by a notify, so the Review button re-enables
///    after a declined/failed attempt;
///  * if `initSession` reports `termsNotAccepted` (the SDK's own init check
///    disagreeing with `areTermsAccepted()`), the stale native terms flag is
///    reset AND the next attempt is forced to re-show the dialog — so "Review
///    navigation terms" cannot get stuck never invoking the dialog.
class NavigationInitController {
  NavigationInitController({
    required Future<bool> Function() ensurePermission,
    required Future<bool> Function() areTermsAccepted,
    required Future<bool> Function() showTerms,
    required Future<void> Function() initSession,
    required Future<void> Function() disposeSession,
    Future<void> Function()? resetTerms,
    bool Function(Object error)? isTermsError,
    this.onChange,
    this.onError,
    this.onLog,
  })  : _ensurePermission = ensurePermission,
        _areTermsAccepted = areTermsAccepted,
        _showTerms = showTerms,
        _initSession = initSession,
        _disposeSession = disposeSession,
        _resetTerms = resetTerms ?? _noopReset,
        _isTermsError = isTermsError ?? _never;

  final Future<bool> Function() _ensurePermission;
  final Future<bool> Function() _areTermsAccepted;
  final Future<bool> Function() _showTerms;
  final Future<void> Function() _initSession;
  final Future<void> Function() _disposeSession;
  final Future<void> Function() _resetTerms;
  final bool Function(Object error) _isTermsError;

  /// Called after each published phase change / guard change (wire to
  /// `setState`). Never fires once the controller is disposed.
  final void Function()? onChange;

  /// Called once with the raw error when initialization throws (wire to a
  /// debug-only log). Never carries the error into the UI text.
  final void Function(Object error)? onError;

  /// Debug-only stage logger (wire to `debugPrint('[GoogleNavigation] $m')`).
  /// Only receives stage labels + booleans + an error's toString — never keys,
  /// tokens, or the API key.
  final void Function(String message)? onLog;

  static bool _never(Object _) => false;
  static Future<void> _noopReset() async {}

  NavInitPhase _phase = NavInitPhase.idle;
  bool _inFlight = false;
  bool _disposed = false;
  bool _ownsSession = false;
  bool _forceTermsPrompt = false; // set after a termsNotAccepted rejection
  int _initCount = 0;
  int _dialogCount = 0;
  int _resetCount = 0;
  Object? _lastError;
  String _reason = '';

  NavInitPhase get phase => _phase;

  /// True only once a session this controller created is live — the widget uses
  /// this to decide whether it must clean the session up on dispose.
  bool get ownsSession => _ownsSession;

  /// The platform navigation view may render only when the session is ready.
  bool get shouldShowMap => _phase == NavInitPhase.ready;

  /// True while an attempt is running (used to disable the retry button).
  bool get isBusy => _inFlight;

  bool get isDisposed => _disposed;

  /// Number of successful `initSession` completions (diagnostics/tests).
  int get initCount => _initCount;

  /// Number of terms dialogs shown (diagnostics/tests).
  int get dialogCount => _dialogCount;

  /// Number of native terms resets performed (diagnostics/tests).
  int get resetCount => _resetCount;

  /// Reason category for the current non-ready phase: 'permission', 'declined',
  /// or 'failed' (empty when ready/preparing/awaitingTermsDecision).
  String get reason => _reason;

  /// Last raw initialization error, if any (debug only — never shown verbatim).
  Object? get lastError => _lastError;

  void _log(String message) => onLog?.call(message);

  void _notify() {
    if (!_disposed) onChange?.call();
  }

  void _set(NavInitPhase phase) {
    _phase = phase;
    _notify();
  }

  /// Run the consent + initialization flow. Safe to call repeatedly: a call
  /// while an attempt is in flight, after disposal, or once ready is ignored.
  Future<void> start() async {
    if (_disposed || _inFlight || _phase == NavInitPhase.ready) return;
    _inFlight = true;
    _lastError = null;
    _reason = '';
    _set(NavInitPhase.preparing);
    try {
      _log('checking location permission');
      final permOk = await _ensurePermission();
      _log('location permission result: $permOk');
      if (_disposed) return;
      if (!permOk) {
        _reason = 'permission';
        _set(NavInitPhase.failed);
        return;
      }

      // Terms — the SDK is the source of truth. Prompt when not accepted, OR
      // when a prior init reported termsNotAccepted (force flag) so a stale
      // "accepted" reading can't skip the dialog forever.
      _log('checking terms acceptance');
      final already = await _areTermsAccepted();
      _log('terms already accepted: $already');
      if (_disposed) return;
      if (!already || _forceTermsPrompt) {
        _forceTermsPrompt = false;
        _dialogCount++;
        _set(NavInitPhase.awaitingTermsDecision);
        _log('requesting native terms dialog');
        final accepted = await _showTerms();
        _log('native terms dialog result: $accepted');
        if (_disposed) return;
        if (!accepted) {
          _reason = 'declined';
          _set(NavInitPhase.declined);
          return;
        }
        _set(NavInitPhase.preparing);
      }

      // Initialize exactly one session — only after terms are accepted.
      _log('initializing navigation session');
      await _initSession();
      _log('session initialized');
      _initCount++;
      if (_disposed) {
        // The screen went away mid-init: release the session we just created so
        // it is not leaked, and publish nothing.
        try {
          await _disposeSession();
        } catch (_) {}
        return;
      }
      _ownsSession = true;
      _set(NavInitPhase.ready);
    } catch (e) {
      if (_disposed) return;
      _lastError = e;
      _log('initialization failed: $e');
      onError?.call(e);
      if (_isTermsError(e)) {
        // The SDK rejected init for terms even though the dialog was skipped
        // (areTermsAccepted() said true). Clear the stale native flag and force
        // the next attempt to re-show the dialog, so "Review navigation terms"
        // actually invokes it instead of looping on the same rejection.
        _forceTermsPrompt = true;
        try {
          await _resetTerms();
          _resetCount++;
          _log('terms acceptance reset after termsNotAccepted');
        } catch (err) {
          _log('terms reset failed: $err');
        }
        if (_disposed) return;
        _reason = 'declined';
        _set(NavInitPhase.declined);
      } else {
        _reason = 'failed';
        _set(NavInitPhase.failed);
      }
    } finally {
      // Always release the guard, then notify, so the Review button re-enables
      // after decline / failure / disposal.
      _inFlight = false;
      _notify();
    }
  }

  /// Re-run the flow (e.g. "Review navigation terms"). Guarded identically to
  /// [start], so a rapid double-tap can never start two attempts.
  Future<void> retry() => start();

  /// Mark disposed so no further phase change is published; if a session is
  /// still owned, the widget releases it (see [ownsSession]).
  void markDisposed() {
    _disposed = true;
  }
}
