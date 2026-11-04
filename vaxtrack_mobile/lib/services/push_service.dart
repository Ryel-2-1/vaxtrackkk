import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';

/// Rider push notifications (server: functions/src/riderPush.js).
///
/// The server tells a Rider about a new assignment, a reassignment away from
/// them, a cancellation, and a dispatcher's decision on an offline delivery.
/// This app only registers where to send them: its FCM token is kept in
/// `riderPushTokens/{riderUid}` (at most [kMaxPushTokens], newest last — one
/// per phone the Rider is signed in on) and removed when the Rider signs out,
/// so a shared phone never receives the previous Rider's notifications.
///
/// Push is a convenience, never the source of truth: the delivery list is.
/// Every failure here is swallowed and never blocks sign-in or sign-out.
const String kPushTokensCollection = 'riderPushTokens';
const int kMaxPushTokens = 5;

/// [existing] with [token] moved to the end, keeping the newest [max].
List<String> mergePushTokens(List<String> existing, String token, {int max = kMaxPushTokens}) {
  final next = [...existing.where((t) => t.isNotEmpty && t != token), token];
  return next.length <= max ? next : next.sublist(next.length - max);
}

/// [existing] without [token].
List<String> withoutPushToken(List<String> existing, String token) => existing.where((t) => t != token).toList();

List<String> _tokensOf(Map<String, dynamic>? data) {
  final raw = data?['tokens'];
  return raw is List ? raw.whereType<String>().toList() : <String>[];
}

/// Shows a foreground notification in the app (FCM only displays it by itself
/// while the app is in the background).
final GlobalKey<ScaffoldMessengerState> pushMessengerKey = GlobalKey<ScaffoldMessengerState>();

class PushService {
  PushService({FirebaseMessaging? messaging, FirebaseFirestore? db})
      : _messagingOverride = messaging,
        _dbOverride = db;

  final FirebaseMessaging? _messagingOverride;
  final FirebaseFirestore? _dbOverride;
  FirebaseMessaging get _messaging => _messagingOverride ?? FirebaseMessaging.instance;
  FirebaseFirestore get _db => _dbOverride ?? FirebaseFirestore.instance;

  String? _riderUid;
  String? _token;
  StreamSubscription<String>? _refresh;
  StreamSubscription<RemoteMessage>? _foreground;

  DocumentReference<Map<String, dynamic>> _doc(String uid) => _db.collection(kPushTokensCollection).doc(uid);

  /// Start receiving pushes for [riderUid] on this phone. Safe to call again.
  Future<void> start(String riderUid) async {
    try {
      if (_riderUid == riderUid && _token != null) return;
      _riderUid = riderUid;
      await _messaging.requestPermission();
      final token = await _messaging.getToken();
      if (token == null || _riderUid != riderUid) return;
      await _save(riderUid, token);
      _refresh ??= _messaging.onTokenRefresh.listen((t) {
        final uid = _riderUid;
        if (uid != null) unawaited(_save(uid, t).catchError((Object _) {}));
      });
      _foreground ??= FirebaseMessaging.onMessage.listen(_showInApp);
    } catch (e) {
      // No Firebase (tests), no Play services, offline: push is optional.
      debugPrint('PushService: start skipped (${e.runtimeType})');
    }
  }

  Future<void> _save(String riderUid, String token) async {
    final ref = _doc(riderUid);
    await _db.runTransaction((tx) async {
      final snap = await tx.get(ref);
      tx.set(ref, {
        'riderUid': riderUid,
        'tokens': mergePushTokens(_tokensOf(snap.data()), token),
        'updatedAt': FieldValue.serverTimestamp(),
      });
    });
    _token = token;
  }

  /// This phone stops receiving [riderUid]'s pushes (call BEFORE signing out,
  /// while the Rider may still write their own document).
  Future<void> stop(String riderUid) async {
    final token = _token;
    _riderUid = null;
    _token = null;
    await _refresh?.cancel();
    _refresh = null;
    if (token == null) return;
    try {
      final ref = _doc(riderUid);
      await _db.runTransaction((tx) async {
        final snap = await tx.get(ref);
        if (!snap.exists) return;
        final left = withoutPushToken(_tokensOf(snap.data()), token);
        if (left.isEmpty) {
          tx.delete(ref);
        } else {
          tx.set(ref, {'riderUid': riderUid, 'tokens': left, 'updatedAt': FieldValue.serverTimestamp()});
        }
      });
      await _messaging.deleteToken();
    } catch (e) {
      debugPrint('PushService: stop incomplete (${e.runtimeType})');
    }
  }

  void _showInApp(RemoteMessage message) {
    final title = message.notification?.title;
    final body = message.notification?.body;
    if (title == null && body == null) return;
    pushMessengerKey.currentState?.showSnackBar(SnackBar(
      content: Text([title, body].whereType<String>().join(' — ')),
      duration: const Duration(seconds: 6),
    ));
  }
}

/// The app's one push service. Created on first use, so tests that never
/// start it never touch Firebase.
final PushService riderPush = PushService();

/// The signed-in Rider's uid, or null (also when Firebase is not set up).
String? signedInRiderUid() {
  try {
    return FirebaseAuth.instance.currentUser?.uid;
  } catch (_) {
    return null;
  }
}
