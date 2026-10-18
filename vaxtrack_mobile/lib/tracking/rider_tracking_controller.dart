import 'dart:async';

import 'package:flutter/foundation.dart';

import 'location_write_policy.dart';
import 'tracking_contract.dart';
import 'tracking_lifecycle.dart';

/// Device location, behind an interface so the controller is testable without
/// a phone. The real implementation is GeolocatorLocationSource.
abstract class TrackingLocationSource {
  /// Current access WITHOUT prompting.
  Future<LocationAccess> checkAccess();

  /// Show the system permission prompt (only after the app explained why).
  Future<LocationAccess> requestAccess();

  /// Continuous fixes for [mode]. On Android this runs as a foreground service
  /// with a visible notification, so it continues with the screen locked.
  Stream<LocationFix> fixes(TrackingMode mode);

  /// Whether the tracking notification can be shown (Android 13+ permission).
  /// Sharing works either way; the rider is told when it is hidden.
  Future<bool> notificationsAllowed();

  Future<void> openAppSettings();
  Future<void> openLocationSettings();
}

/// Where tracking state is stored (Firestore in the app; a fake in tests).
abstract class TrackingStore {
  /// Replace the rider's riderLocations doc with an active fix.
  Future<void> writeLocation({
    required String riderUid,
    required LocationFix fix,
    String? activeOrderId,
    String? navigationSessionId,
  });

  /// Mark tracking ended: coordinates are cleared (privacy).
  Future<void> writeEnded({required String riderUid, required DateTime at});

  /// Start (or replace) the rider's navigation session.
  Future<void> startSession({
    required String riderUid,
    required String orderId,
    required String sessionId,
  });

  /// End the rider's CURRENT session if it is still [sessionId] and navigating.
  Future<void> endSession({
    required String riderUid,
    required String sessionId,
    required String reason,
  });

  /// The id of the rider's session the SERVER still holds as navigating, or
  /// null. Used once per sign-in to end a session this app instance does not
  /// know about (left behind by a killed or reinstalled app).
  Future<String?> navigatingSessionId(String riderUid);
}

/// Shown while sharing has been asked for but no position has arrived yet.
const String kNoFixYetMessage =
    'Location sharing has not started yet — no position has been received. '
    'VaxTrack is retrying. Check that location is on.';

/// The one navigation route the rider is following.
class ActiveNavigation {
  final String orderId;
  final String sessionId;
  const ActiveNavigation(this.orderId, this.sessionId);
}

/// Owns the Rider app's live-location lifecycle.
///
///  * Tracking follows the rider's assigned orders (planTracking): it starts
///    while at least one is active and stops — writing an 'ended' state that
///    clears the coordinates — when none is. Opening a screen never starts it.
///  * Navigation is explicit: [startNavigation] for one order replaces any
///    previous one; it ends when the rider stops, the order stops being
///    navigable, tracking stops, or the rider signs out.
///  * Location writes go through [LocationWritePolicy]: jitter, repeated and
///    out-of-order fixes are dropped; at most one write is in flight and only
///    the newest fix waits behind it (bounded offline queue).
///  * Permission is never requested silently: [needsPermission] is shown with
///    an explanation and [allowLocation] prompts only when the rider agrees.
class RiderTrackingController extends ChangeNotifier {
  RiderTrackingController({
    required TrackingLocationSource source,
    required TrackingStore store,
    DateTime Function()? clock,
    Timer Function(Duration, void Function())? startTimer,
    this.firstFixTimeout = const Duration(seconds: 45),
  })  : _source = source,
        _store = store,
        _clock = clock ?? DateTime.now,
        _startTimer = startTimer ?? Timer.new;

  final TrackingLocationSource _source;
  final TrackingStore _store;
  final DateTime Function() _clock;
  final Timer Function(Duration, void Function()) _startTimer;
  final LocationWritePolicy _policy = LocationWritePolicy();

  /// A stream that has produced no position by then is restarted (one stream
  /// replaces the other — never two). The Android plugin can accept a listen
  /// before its location service is bound and then stay silent with no error;
  /// waiting on such a stream is how sharing silently did not start.
  final Duration firstFixTimeout;
  Timer? _firstFixTimer;
  bool _awaitingFirstFix = false;
  int _restartsWithoutFix = 0;

  String? _riderUid;
  StreamSubscription<List<TrackedOrder>>? _ordersSub;
  StreamSubscription<LocationFix>? _fixSub;
  TrackingMode _streamMode = TrackingMode.off;
  List<TrackedOrder> _orders = const [];
  TrackingPlan _plan = const TrackingPlan(mode: TrackingMode.off, activeOrderIds: [], endNavigation: false);
  ActiveNavigation? _navigation;
  TrackingStatus _status = TrackingStatus.idle;
  bool _asked = false;
  // Android 12+ refuses to START a location foreground service while the app
  // is in the background, so a stream is only ever started in the foreground.
  // One already running keeps running in the background.
  bool _inForeground = true;
  bool _notificationsAllowed = true;
  bool _wroteSinceStart = false;
  LocationFix? _lastFix;
  String? _lastError;

  bool _writeInFlight = false;
  LocationFix? _pendingFix;
  Future<void> _ops = Future<void>.value();

  // ---- read-only state for the UI ----
  TrackingStatus get status => _status;
  TrackingMode get mode => _plan.mode;
  ActiveNavigation? get navigation => _navigation;
  List<String> get activeOrderIds => _plan.activeOrderIds;
  LocationFix? get lastFix => _lastFix;
  String? get lastError => _lastError;
  bool get isSharing => _fixSub != null;

  /// True only once the running stream has actually produced a position. The
  /// UI never says "sharing" before that.
  bool get sharingConfirmed => _fixSub != null && _writtenOnStream == _streamGeneration;

  // Each started stream gets a new generation; a write that succeeds while that
  // stream is current confirms sharing ON IT. A stream object alone, or a
  // position that was received but not saved, never counts as "sharing".
  int _streamGeneration = 0;
  int _writtenOnStream = -1;
  bool _disposed = false;

  /// Times the stream was restarted because no position arrived (diagnostics).
  int get restartsWithoutFix => _restartsWithoutFix;
  bool get notificationsAllowed => _notificationsAllowed;

  /// App lifecycle (HomeScreen). Returning to the foreground re-checks and
  /// starts sharing that had to wait.
  Future<void> setForeground(bool value) => _serialize(() async {
        _inForeground = value;
        if (value) await _reconcile();
      });

  /// Begin following [riderUid]'s assigned orders. Idempotent per rider.
  void attach(String riderUid, Stream<List<TrackedOrder>> orders) {
    if (_disposed) return;
    if (_riderUid == riderUid && _ordersSub != null) return;
    _riderUid = riderUid;
    // A navigation session this app instance did not start is one left behind
    // (app killed, reinstalled, signed out offline): end it, so nothing is
    // ever monitored for a route the rider is not following.
    _serialize(_endLeftoverSession);
    _ordersSub?.cancel();
    _ordersSub = orders.listen(
      (list) {
        _orders = list;
        _serialize(_reconcile);
      },
      onError: (Object e) {
        _lastError = 'Could not read your deliveries.';
        _notify();
      },
    );
  }

  /// The rider agreed to the explanation: show the system prompt.
  Future<void> allowLocation() => _serialize(() async {
        _asked = true;
        final access = await _source.requestAccess();
        _status = statusForAccess(access, asked: true);
        await _reconcile();
      });

  /// Retry after the rider changed a setting or switched location on. A stream
  /// that has produced no position yet is replaced (one stream, never two).
  Future<void> retry() => _serialize(() async {
        if (_fixSub != null && _awaitingFirstFix && _inForeground) {
          await _startStream(_streamMode);
        }
        await _reconcile();
      });

  Future<void> openAppSettings() => _source.openAppSettings();
  Future<void> openLocationSettings() => _source.openLocationSettings();

  /// Start Navigation for [orderId]. Replaces any route already navigated.
  /// Returns null on success, or a message why it could not start.
  Future<String?> startNavigation(String orderId) async {
    String? error;
    await _serialize(() async {
      final uid = _riderUid;
      if (uid == null) {
        error = 'Sign in to start navigation.';
        return;
      }
      TrackedOrder? order;
      for (final o in _orders) {
        if (o.id == orderId) order = o;
      }
      final eligibility = navigationEligibility(order: order, riderUid: uid, routeAvailable: true);
      if (!eligibility.canStart) {
        error = eligibility.blockers.first;
        return;
      }
      if (_navigation?.orderId == orderId) return; // already navigating it
      final sessionId = newNavigationSessionId();
      try {
        await _store.startSession(riderUid: uid, orderId: orderId, sessionId: sessionId);
      } catch (e) {
        error = 'Navigation could not start. Check your connection and try again.';
        return;
      }
      // The new session replaces the old one (the server closes the old route).
      _navigation = ActiveNavigation(orderId, sessionId);
      await _reconcile();
    });
    return error;
  }

  /// The rider tapped Stop.
  Future<void> stopNavigation() => _serialize(() async {
        await _endNavigation(kEndReasonRiderStopped);
        await _reconcile();
      });

  /// Sign-out / app teardown: end navigation and tracking, clear the stored
  /// coordinates, and stop following the rider's orders.
  Future<void> shutdown({String reason = kEndReasonSignedOut}) => _serialize(() async {
        await _ordersSub?.cancel();
        _ordersSub = null;
        await _endNavigation(reason);
        await _stopStream(writeEnded: true);
        _orders = const [];
        _plan = const TrackingPlan(mode: TrackingMode.off, activeOrderIds: [], endNavigation: false);
        _status = TrackingStatus.idle;
        _riderUid = null;
        _notify();
      });

  // ---------------------------------------------------------------- internals

  /// Every state change runs one at a time, in order, so repeated callbacks
  /// (order snapshots, taps, permission results) can never race.
  Future<void> _serialize(Future<void> Function() op) {
    final next = _ops.then((_) => op()).catchError((Object e) {
      _lastError = 'Tracking error: ${e.runtimeType}';
      _notify();
    });
    _ops = next;
    return next;
  }

  Future<void> _reconcile() async {
    final uid = _riderUid;
    if (uid == null) return;
    _plan = planTracking(riderUid: uid, orders: _orders, navigatingOrderId: _navigation?.orderId);
    if (_plan.endNavigation) {
      await _endNavigation(kEndReasonTrackingStopped);
      _plan = planTracking(riderUid: uid, orders: _orders);
    }
    if (_plan.mode == TrackingMode.off) {
      await _stopStream(writeEnded: true);
      _status = TrackingStatus.idle;
      _notify();
      return;
    }
    final access = await _source.checkAccess();
    if (access != LocationAccess.granted) {
      await _stopStream(writeEnded: false);
      _status = statusForAccess(access, asked: _asked);
      _notify();
      return;
    }
    final allowed = await _source.notificationsAllowed();
    // Notifications just turned on: restart the running stream once so the
    // foreground service re-posts its notice now — no waiting for a timeout.
    final regained = allowed && !_notificationsAllowed && _fixSub != null && _inForeground;
    _notificationsAllowed = allowed;
    if (_fixSub == null || _streamMode != _plan.mode || regained) {
      if (_inForeground) {
        await _startStream(_plan.mode);
      } else if (_fixSub == null) {
        // Cannot start from the background (Android 12+): wait for the rider
        // to open the app. Nothing is shared meanwhile, and nothing pretends to.
        _status = TrackingStatus.waitingForApp;
        _notify();
        return;
      }
      // Otherwise the running stream keeps its settings until the app is in
      // the foreground; write cadence already follows the current mode.
    }
    _status = _plan.mode == TrackingMode.navigating ? TrackingStatus.navigating : TrackingStatus.tracking;
    _notify();
  }

  Future<void> _startStream(TrackingMode mode) async {
    await _fixSub?.cancel();
    _fixSub = null;
    if (_disposed) return;
    _streamGeneration++;
    _streamMode = mode;
    _awaitingFirstFix = true;
    _firstFixTimer?.cancel();
    _firstFixTimer = _startTimer(firstFixTimeout, _onFirstFixTimeout);
    _fixSub = _source.fixes(mode).listen(
      _onFix,
      onError: (Object e) {
        _status = TrackingStatus.error;
        _lastError = 'Location could not be read. Check that location is on, then retry.';
        _fixSub?.cancel();
        _fixSub = null;
        _notify();
      },
      cancelOnError: false,
    );
  }

  /// No position arrived on the current stream: replace it (cancel, then one
  /// new listen) and say so — never a silent wait.
  void _onFirstFixTimeout() {
    _serialize(() async {
      if (_fixSub == null || !_awaitingFirstFix) return;
      _restartsWithoutFix++;
      _lastError = kNoFixYetMessage;
      if (_inForeground) {
        await _startStream(_streamMode);
      } else {
        _firstFixTimer = _startTimer(firstFixTimeout, _onFirstFixTimeout);
      }
      _notify();
    });
  }

  Future<void> _endLeftoverSession() async {
    final uid = _riderUid;
    if (uid == null || _navigation != null) return;
    try {
      final leftover = await _store.navigatingSessionId(uid);
      if (leftover == null || _navigation != null) return;
      await _store.endSession(riderUid: uid, sessionId: leftover, reason: kEndReasonTrackingStopped);
    } catch (_) {
      // Best effort: the server also ends a session once untagged fixes arrive.
    }
  }

  Future<void> _stopStream({required bool writeEnded}) async {
    final hadStream = _fixSub != null;
    _firstFixTimer?.cancel();
    _firstFixTimer = null;
    _awaitingFirstFix = false;
    await _fixSub?.cancel();
    _fixSub = null;
    _streamMode = TrackingMode.off;
    _pendingFix = null;
    _policy.reset();
    final uid = _riderUid;
    if (writeEnded && uid != null && (hadStream || _wroteSinceStart)) {
      try {
        await _store.writeEnded(riderUid: uid, at: _clock());
      } catch (_) {
        // Best effort: the server's retention purge removes an idle location.
      }
    }
    _wroteSinceStart = false;
  }

  Future<void> _endNavigation(String reason) async {
    final nav = _navigation;
    final uid = _riderUid;
    _navigation = null;
    if (nav == null || uid == null) return;
    try {
      await _store.endSession(riderUid: uid, sessionId: nav.sessionId, reason: reason);
    } catch (_) {
      // The server also ends sessions whose order stopped being navigable.
    }
  }

  void _onFix(LocationFix fix) {
    _lastFix = fix;
    if (_awaitingFirstFix) {
      _awaitingFirstFix = false;
      _firstFixTimer?.cancel();
      _firstFixTimer = null;
      _restartsWithoutFix = 0;
      if (_lastError == kNoFixYetMessage) _lastError = null;
    }
    final mode = _plan.mode;
    if (_writeInFlight) {
      // Keep only the newest fix while a write is pending (offline-safe).
      _pendingFix = fix;
      _notify();
      return;
    }
    _maybeWrite(fix, mode);
    _notify();
  }

  void _maybeWrite(LocationFix fix, TrackingMode mode) {
    final uid = _riderUid;
    if (uid == null) return;
    final decision = _policy.decide(fix, mode);
    if (!decision.write) return;
    _policy.markWritten(fix, mode);
    _writeInFlight = true;
    final nav = mode == TrackingMode.navigating ? _navigation : null;
    final generation = _streamGeneration;
    _store
        .writeLocation(
          riderUid: uid,
          fix: fix,
          activeOrderId: nav?.orderId,
          navigationSessionId: nav?.sessionId,
        )
        .then((_) {
          _wroteSinceStart = true;
          _lastError = null;
          // Saved while this stream is still the current one: sharing is real.
          if (generation == _streamGeneration) _writtenOnStream = generation;
        })
        .catchError((Object e) {
          // A rejected write (e.g. a newer fix already stored by another
          // device) is dropped; the next fix is tried normally.
          _lastError = 'Location update not saved.';
        })
        .whenComplete(() {
          _writeInFlight = false;
          final pending = _pendingFix;
          _pendingFix = null;
          if (pending != null && _fixSub != null) _maybeWrite(pending, _plan.mode);
          _notify();
        });
  }

  void _notify() {
    if (hasListeners) notifyListeners();
  }

  /// Releases every timer and stream. Nothing starts again afterwards.
  @override
  void dispose() {
    _disposed = true;
    _firstFixTimer?.cancel();
    _firstFixTimer = null;
    _fixSub?.cancel();
    _fixSub = null;
    _ordersSub?.cancel();
    _ordersSub = null;
    super.dispose();
  }

  @visibleForTesting
  Future<void> get idle => _ops;
}
