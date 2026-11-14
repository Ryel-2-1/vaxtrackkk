import 'dart:async';
import 'dart:io';

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';
import 'package:vaxtrack_mobile/models/app_user.dart';
import 'package:vaxtrack_mobile/models/delivery.dart';
import 'package:vaxtrack_mobile/screens/profile_screen.dart';
import 'package:vaxtrack_mobile/services/profile_photo_service.dart';
import 'package:vaxtrack_mobile/utils/person_initials.dart';
import 'package:vaxtrack_mobile/widgets/rider_avatar.dart';

/// Rider profile photo + three-letter initials (2026-11-15).

class _Store implements ProfilePhotoStore {
  final List<String> calls = [];
  Object? uploadError;
  Object? saveError;
  Object? deleteError;
  Completer<void>? gate;

  @override
  Future<String> upload(String uid, File file) async {
    calls.add('upload:$uid');
    if (gate != null) await gate!.future;
    if (uploadError != null) throw uploadError!;
    return 'https://firebasestorage.googleapis.com/v0/b/x/o/profile_photos%2F$uid%2Fphoto.jpg?alt=media&token=t';
  }

  @override
  Future<void> saveRecord(String uid, String downloadUrl) async {
    calls.add('save:$uid');
    if (saveError != null) throw saveError!;
  }

  @override
  Future<void> clearRecord(String uid) async => calls.add('clear:$uid');

  @override
  Future<void> deleteObject(String uid) async {
    calls.add('delete:$uid');
    if (deleteError != null) throw deleteError!;
  }
}

Future<File> _tempFile(int bytes) async {
  final dir = await Directory.systemTemp.createTemp('vax-photo-');
  final f = File('${dir.path}${Platform.pathSeparator}photo.jpg');
  await f.writeAsBytes(List.filled(bytes, 0));
  return f;
}

void main() {
  group('initials and display URL (same rules as the web)', () {
    test('up to three initials, like staff', () {
      expect(initialsOf('Juan Dela Cruz'), 'JDC');
      expect(initialsOf('Ryel Jan Espinili'), 'RJE');
      expect(initialsOf('Maria Clara Santos Reyes'), 'MCR');
      expect(initialsOf('  ana   reyes '), 'AR');
      expect(initialsOf('rider'), 'R');
      expect(initialsOf(''), '?');
      expect(initialsOf(null), '?');
    });

    test('only https URLs are shown, versioned by update time', () {
      const url = 'https://firebasestorage.googleapis.com/o/p.jpg?alt=media';
      expect(profilePhotoDisplayUrl(url, null), url);
      expect(profilePhotoDisplayUrl(url, DateTime.fromMillisecondsSinceEpoch(42)), '$url&v=42');
      expect(profilePhotoDisplayUrl('https://x/p.jpg', DateTime.fromMillisecondsSinceEpoch(7)), 'https://x/p.jpg?v=7');
      for (final bad in [null, '', 'http://x/p.jpg', 'javascript:alert(1)', 'https://x y']) {
        expect(profilePhotoDisplayUrl(bad, null), isNull, reason: '$bad');
      }
    });

    test('AppUser reads the photo fields from the user record', () {
      final at = DateTime.fromMillisecondsSinceEpoch(1000);
      final u = AppUser.fromFirestore('r1', {
        'fullName': 'Juan Dela Cruz', 'role': 'rider', 'status': 'approved',
        'photoUrl': 'https://x/p.jpg', 'photoUpdatedAt': at,
      });
      expect(u.initials, 'JDC');
      expect(u.displayPhotoUrl, 'https://x/p.jpg?v=1000');
      final none = AppUser.fromFirestore('r2', {'fullName': 'A B', 'photoUrl': 42});
      expect(none.photoUrl, isNull);
      expect(none.displayPhotoUrl, isNull);
    });
  });

  group('ProfilePhotoController', () {
    late _Store store;
    late ProfilePhotoController c;
    setUp(() {
      store = _Store();
      c = ProfilePhotoController(store: store);
    });

    test('replace uploads, THEN records — and reports success', () async {
      final file = await _tempFile(2048);
      expect(await c.replace('r1', file), isTrue);
      expect(store.calls, ['upload:r1', 'save:r1']);
      expect(c.noticeMessage, ProfilePhotoController.updatedMessage);
      expect(c.errorMessage, isNull);
      expect(c.busy, isFalse);
    });

    test('a failed upload records nothing', () async {
      store.uploadError = FirebaseException(plugin: 'firebase_storage', code: 'retry-limit-exceeded');
      expect(await c.replace('r1', await _tempFile(10)), isFalse);
      expect(store.calls, ['upload:r1']);
      expect(c.errorMessage, contains('No connection'));
    });

    test('a refused upload says permission, not connection', () async {
      store.uploadError = FirebaseException(plugin: 'firebase_storage', code: 'unauthorized');
      expect(await c.replace('r1', await _tempFile(10)), isFalse);
      expect(c.errorMessage, contains('permission denied'));
    });

    test('a photo of 5 MB or more is refused before any upload', () async {
      expect(await c.replace('r1', await _tempFile(kMaxProfilePhotoBytes)), isFalse);
      expect(store.calls, isEmpty);
      expect(c.errorMessage, ProfilePhotoController.tooLargeMessage);
    });

    test('remove clears the record first; a leftover file is not an error', () async {
      store.deleteError = FirebaseException(plugin: 'firebase_storage', code: 'unknown');
      expect(await c.remove('r1'), isTrue);
      expect(store.calls, ['clear:r1', 'delete:r1']);
      expect(c.noticeMessage, ProfilePhotoController.removedMessage);
    });

    test('a second request while one is running is ignored', () async {
      store.gate = Completer<void>();
      final file = await _tempFile(10);
      final first = c.replace('r1', file);
      await Future<void>.delayed(Duration.zero);
      expect(c.busy, isTrue);
      expect(await c.replace('r1', file), isFalse);
      expect(await c.remove('r1'), isFalse);
      store.gate!.complete();
      expect(await first, isTrue);
      expect(store.calls, ['upload:r1', 'save:r1']);
    });

    test('the Storage path is the one the rules pin', () {
      expect(profilePhotoPath('r1'), 'profile_photos/r1/photo.jpg');
    });
  });

  group('Profile screen', () {
    Widget app(Widget child) => MaterialApp(home: child);

    Future<void> pumpProfile(WidgetTester tester, AppUser user, _Store store,
        {ProfilePhotoPicker? pick}) async {
      tester.view.physicalSize = const Size(800, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(app(ProfileScreen(
        riderId: user.uid,
        profileFeed: (_) => Stream.value(user),
        deliveriesFeed: (_) => Stream.value(const <Delivery>[]),
        photoStore: store,
        pickPhoto: pick,
      )));
      await tester.pumpAndSettle();
    }

    final rider = AppUser(uid: 'r1', email: 'r@x.test', name: 'Juan Dela Cruz', role: 'rider', status: 'approved');

    testWidgets('no photo: three initials, and the sheet offers no Remove', (tester) async {
      await pumpProfile(tester, rider, _Store());
      expect(find.byKey(const ValueKey('rider-avatar-initials')), findsOneWidget);
      expect(find.text('JDC'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('profile-photo-edit')));
      await tester.pumpAndSettle();
      expect(find.text('Take a photo'), findsOneWidget);
      expect(find.text('Choose from gallery'), findsOneWidget);
      expect(find.text('Remove photo'), findsNothing);
    });

    testWidgets('cancelling the picker uploads nothing', (tester) async {
      final store = _Store();
      await pumpProfile(tester, rider, store, pick: (_) async => null);
      await tester.tap(find.byKey(const ValueKey('profile-photo-edit')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('profile-photo-gallery')));
      await tester.pumpAndSettle();
      expect(store.calls, isEmpty);
    });

    testWidgets('with a photo: Remove is offered and clears it', (tester) async {
      final store = _Store();
      final withPhoto = AppUser(
        uid: 'r1', email: 'r@x.test', name: 'Juan Dela Cruz', role: 'rider', status: 'approved',
        photoUrl: 'https://x/p.jpg', photoUpdatedAt: DateTime.fromMillisecondsSinceEpoch(1),
      );
      await pumpProfile(tester, withPhoto, store);
      await tester.tap(find.byKey(const ValueKey('profile-photo-edit')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('profile-photo-remove')));
      await tester.pumpAndSettle();
      expect(store.calls, ['clear:r1', 'delete:r1']);
      expect(find.text(ProfilePhotoController.removedMessage), findsOneWidget);
    });

    testWidgets('the camera choice asks the picker for the camera', (tester) async {
      ImageSource? asked;
      await pumpProfile(tester, rider, _Store(), pick: (source) async {
        asked = source;
        return null;
      });
      await tester.tap(find.byKey(const ValueKey('profile-photo-edit')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('profile-photo-camera')));
      await tester.pumpAndSettle();
      expect(asked, ImageSource.camera);
    });
  });

  testWidgets('RiderAvatar falls back to initials when the photo cannot load', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(body: RiderAvatar(name: 'Ana Reyes', photoUrl: 'https://invalid.test/p.jpg')),
    ));
    await tester.pumpAndSettle();
    expect(find.text('AR'), findsOneWidget);
  });
}
