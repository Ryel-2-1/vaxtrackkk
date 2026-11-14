import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_storage/firebase_storage.dart';
import 'package:flutter/foundation.dart';
import 'package:image_picker/image_picker.dart';

import '../utils/evidence_errors.dart';
import '../utils/proof_validation.dart';

/// A rider's profile photo (2026-11-15).
///
/// One object per rider at [profilePhotoPath], and three fields on
/// users/{uid}: `photoUrl`, `photoPath`, `photoUpdatedAt`. storage.rules and
/// firestore.rules allow only the signed-in, approved rider to write their
/// own, and only in exactly this shape; Admin and Dispatcher see it on the web.

/// Must stay identical to the `profile_photos/{uid}/photo.jpg` match in
/// vaxtrack-web/storage.rules and riderPhotoPathOf() in firestore.rules.
const String kProfilePhotoFileName = 'photo.jpg';
String profilePhotoPath(String uid) => 'profile_photos/$uid/$kProfilePhotoFileName';

/// Under storage.rules' 5 MB limit. The picker already shrinks the photo to at
/// most 1024 px, so this only stops an unusual file before a doomed upload.
const int kMaxProfilePhotoBytes = 5 * 1024 * 1024;

/// What the controller needs from Storage and Firestore — a fake in tests.
abstract class ProfilePhotoStore {
  /// Upload [file] as [uid]'s photo; returns its download URL.
  Future<String> upload(String uid, File file);

  /// Record the uploaded photo on users/{uid}.
  Future<void> saveRecord(String uid, String downloadUrl);

  /// Remove the photo fields from users/{uid}.
  Future<void> clearRecord(String uid);

  /// Delete the Storage object (absent is fine).
  Future<void> deleteObject(String uid);
}

class FirebaseProfilePhotoStore implements ProfilePhotoStore {
  FirebaseProfilePhotoStore({FirebaseStorage? storage, FirebaseFirestore? firestore})
      : _storage = storage,
        _firestore = firestore;

  // Resolved on first use, so building a screen never touches Firebase.
  final FirebaseStorage? _storage;
  final FirebaseFirestore? _firestore;
  FirebaseStorage get _st => _storage ?? FirebaseStorage.instance;
  FirebaseFirestore get _db => _firestore ?? FirebaseFirestore.instance;

  @override
  Future<String> upload(String uid, File file) async {
    final ref = _st.ref(profilePhotoPath(uid));
    await ref.putFile(
      file,
      SettableMetadata(contentType: imageContentTypeFor(file.path)),
    );
    return ref.getDownloadURL();
  }

  @override
  Future<void> saveRecord(String uid, String downloadUrl) {
    return _db.collection('users').doc(uid).update({
      'photoUrl': downloadUrl,
      'photoPath': profilePhotoPath(uid),
      'photoUpdatedAt': FieldValue.serverTimestamp(),
    });
  }

  @override
  Future<void> clearRecord(String uid) {
    return _db.collection('users').doc(uid).update({
      'photoUrl': FieldValue.delete(),
      'photoPath': FieldValue.delete(),
      'photoUpdatedAt': FieldValue.delete(),
    });
  }

  @override
  Future<void> deleteObject(String uid) async {
    try {
      await _st.ref(profilePhotoPath(uid)).delete();
    } on FirebaseException catch (e) {
      if (e.code != 'object-not-found') rethrow;
    }
  }
}

/// Picks a photo, shrunk on the phone to at most 1024 px. A seam for tests.
typedef ProfilePhotoPicker = Future<File?> Function(ImageSource source);

Future<File?> pickProfilePhoto(ImageSource source) async {
  final picked = await ImagePicker().pickImage(
    source: source,
    maxWidth: 1024,
    maxHeight: 1024,
    imageQuality: 80,
    preferredCameraDevice: CameraDevice.front,
  );
  return picked == null ? null : File(picked.path);
}

/// Changing or removing the photo, one request at a time.
class ProfilePhotoController extends ChangeNotifier {
  ProfilePhotoController({required ProfilePhotoStore store}) : _store = store;

  final ProfilePhotoStore _store;

  static const String updatedMessage = 'Profile photo updated.';
  static const String removedMessage = 'Profile photo removed.';
  static const String tooLargeMessage =
      'That photo is too large. Choose a smaller one (under 5 MB).';

  bool _busy = false;
  String? _error;
  String? _notice;

  bool get busy => _busy;
  String? get errorMessage => _error;
  String? get noticeMessage => _notice;

  /// Upload [file] as [uid]'s photo, then record it. Returns true on success.
  /// The record is written only after the upload succeeded, so the profile
  /// never points at a photo that is not there.
  Future<bool> replace(String uid, File file) => _run(() async {
        final size = await file.length();
        if (size >= kMaxProfilePhotoBytes) throw const _Refusal(tooLargeMessage);
        final url = await _store.upload(uid, file);
        await _store.saveRecord(uid, url);
        return updatedMessage;
      }, 'upload');

  /// Remove [uid]'s photo. The record goes first, so no page keeps pointing at
  /// a deleted file; a leftover file is harmless (it is overwritten next time).
  Future<bool> remove(String uid) => _run(() async {
        await _store.clearRecord(uid);
        try {
          await _store.deleteObject(uid);
        } catch (_) {
          // The photo is already gone from the profile; ignore the leftover.
        }
        return removedMessage;
      }, 'remove');

  Future<bool> _run(Future<String> Function() action, String what) async {
    if (_busy) return false;
    _busy = true;
    _error = null;
    _notice = null;
    notifyListeners();
    try {
      _notice = await action();
      return true;
    } on _Refusal catch (r) {
      _error = r.message;
      return false;
    } catch (e) {
      _error = _messageFor(e, what);
      return false;
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  static String _messageFor(Object error, String what) {
    final verb = what == 'upload' ? 'update' : 'remove';
    switch (classifyEvidenceError(error)) {
      case EvidenceErrorKind.permissionDenied:
        return 'You are not allowed to $verb this profile photo (permission '
            'denied). If your account was just approved, sign out and in again.';
      case EvidenceErrorKind.notSignedIn:
        return 'Your sign-in could not be verified. Sign out and sign in again.';
      case EvidenceErrorKind.network:
        return 'No connection. Try again once you are back online.';
      case EvidenceErrorKind.other:
        return 'Could not $verb your profile photo. Please try again.';
    }
  }
}

class _Refusal implements Exception {
  const _Refusal(this.message);
  final String message;
}
