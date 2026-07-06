import 'dart:async';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/app_user.dart';

class RegistrationError implements Exception {
  final String code;
  final String message;
  RegistrationError(this.code, this.message);
  @override
  String toString() => message;
}

class AuthService {
  /// Message set by AuthGate when it rejects a session (e.g. pending,
  /// wrong role, disabled, rejected, missing profile). LoginScreen reads
  /// and clears this on the next mount so the user sees why they were
  /// bounced back instead of a silent redirect.
  static String? pendingLoginMessage;

  /// True while registerRider() is running. AuthGate must stay passive
  /// during registration: creating the Auth account fires authStateChanges,
  /// and without this flag AuthGate would load the brand-new pending
  /// profile and sign the user out while the Firestore profile write is
  /// still in flight, corrupting the registration.
  static bool registrationInProgress = false;

  static String? rejectionMessageFor(AppUser? user) {
    if (user == null) {
      return 'Rider profile not found. Please contact your administrator.';
    }
    if (!user.isRider) {
      return 'This mobile app is for riders only. Please use the VaxTrack web portal.';
    }
    if (user.isPending) {
      return 'Your rider account is pending admin approval.';
    }
    if (user.isDisabled || user.isRejected) {
      return 'Your rider account is not active. Contact your administrator.';
    }
    if (!user.isApproved) {
      return 'Access denied. Contact your administrator.';
    }
    return null;
  }

  final FirebaseAuth _auth = FirebaseAuth.instance;
  final FirebaseFirestore _db = FirebaseFirestore.instance;

  User? get currentUser => _auth.currentUser;
  Stream<User?> get authStateChanges => _auth.authStateChanges();

  Future<AppUser> signIn(String email, String password) async {
    final credential = await _auth.signInWithEmailAndPassword(
      email: email.trim(),
      password: password,
    );
    final user = credential.user;
    if (user == null) throw Exception('Login failed.');

    return await getUserProfile(user.uid);
  }

  Future<AppUser> getUserProfile(String uid) async {
    final doc = await _db.collection('users').doc(uid).get();
    if (!doc.exists) {
      throw Exception('No user profile found. Contact your administrator.');
    }
    return AppUser.fromFirestore(uid, doc.data()!);
  }

  Stream<AppUser?> userProfileStream(String uid) {
    return _db.collection('users').doc(uid).snapshots().map((doc) {
      if (!doc.exists) return null;
      return AppUser.fromFirestore(uid, doc.data()!);
    });
  }

  Future<void> signOut() => _auth.signOut();

  Future<void> registerRider({
    required String fullName,
    required String email,
    required String password,
    required String phone,
    required String vehiclePlate,
  }) async {
    User? createdUser;
    registrationInProgress = true;
    try {
      final credential = await _auth
          .createUserWithEmailAndPassword(
            email: email.trim(),
            password: password,
          )
          .timeout(const Duration(seconds: 30));
      createdUser = credential.user;
      if (createdUser == null) {
        throw RegistrationError('unknown', 'Registration failed. Please try again.');
      }

      try {
        await _db
            .collection('users')
            .doc(createdUser.uid)
            .set({
              'role': 'rider',
              'status': 'pending',
              'fullName': fullName.trim(),
              'email': email.trim(),
              'phone': phone.trim(),
              'vehiclePlate': vehiclePlate.trim(),
              'createdAt': FieldValue.serverTimestamp(),
              'updatedAt': FieldValue.serverTimestamp(),
            })
            .timeout(const Duration(seconds: 30));
      } on FirebaseException catch (e) {
        // Remove the orphaned Auth account so the email stays usable for a
        // retry after the Firestore failure is resolved.
        try {
          await createdUser.delete();
        } catch (_) {}
        if (e.code == 'permission-denied') {
          throw RegistrationError(
            'permission-denied',
            'Unable to save rider profile. Please check Firestore rules.',
          );
        }
        throw RegistrationError(
          e.code,
          'Unable to save rider profile. Please try again.',
        );
      }

      await _auth.signOut();
    } on FirebaseAuthException catch (e) {
      switch (e.code) {
        case 'email-already-in-use':
          throw RegistrationError(e.code, 'This email is already registered.');
        case 'weak-password':
          throw RegistrationError(
              e.code, 'Password must be at least 6 characters.');
        case 'invalid-email':
          throw RegistrationError(e.code, 'Please enter a valid email address.');
        case 'network-request-failed':
          throw RegistrationError(
              e.code, 'Network error. Please check your connection.');
        case 'operation-not-allowed':
          throw RegistrationError(
              e.code,
              'Email/password registration is disabled in Firebase Authentication.');
        case 'too-many-requests':
          throw RegistrationError(
              e.code, 'Too many attempts. Please try again later.');
        default:
          throw RegistrationError(e.code, e.message ?? 'Registration failed.');
      }
    } on RegistrationError {
      rethrow;
    } on TimeoutException {
      throw RegistrationError(
        'timeout',
        'Registration timed out. Please check your connection and try again.',
      );
    } catch (e) {
      throw RegistrationError('unknown', 'Registration failed. Please try again.');
    } finally {
      registrationInProgress = false;
    }
  }
}
