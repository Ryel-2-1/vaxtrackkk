import 'dart:async';
import 'dart:io';

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/utils/evidence_errors.dart';
import 'package:vaxtrack_mobile/utils/proof_validation.dart';

FirebaseException storage(String code) =>
    FirebaseException(plugin: 'firebase_storage', code: code);
FirebaseException firestore(String code) =>
    FirebaseException(plugin: 'cloud_firestore', code: code);

void main() {
  group('classifyEvidenceError', () {
    test('a Storage 403 is a permission refusal, not a network fault', () {
      // What the physical-phone staging run hit: storage/unauthorized.
      expect(classifyEvidenceError(storage('unauthorized')),
          EvidenceErrorKind.permissionDenied);
      expect(classifyEvidenceError(firestore('permission-denied')),
          EvidenceErrorKind.permissionDenied);
    });

    test('missing credentials are their own category', () {
      expect(classifyEvidenceError(storage('unauthenticated')),
          EvidenceErrorKind.notSignedIn);
      expect(classifyEvidenceError(firestore('unauthenticated')),
          EvidenceErrorKind.notSignedIn);
    });

    test('only genuine transport failures are called network', () {
      for (final e in <Object>[
        storage('retry-limit-exceeded'),
        firestore('unavailable'),
        firestore('deadline-exceeded'),
        const SocketException('no route'),
        TimeoutException('slow'),
        const ProofException('unavailable', 'network unavailable'),
      ]) {
        expect(classifyEvidenceError(e), EvidenceErrorKind.network,
            reason: '$e');
      }
    });

    test('anything else is other — never guessed to be the network', () {
      expect(classifyEvidenceError(storage('quota-exceeded')),
          EvidenceErrorKind.other);
      expect(classifyEvidenceError(storage('unknown')), EvidenceErrorKind.other);
      expect(classifyEvidenceError(StateError('boom')), EvidenceErrorKind.other);
    });

    test('text-only errors fall back to their category words', () {
      expect(classifyEvidenceError(Exception('[firebase_storage/unauthorized]')),
          EvidenceErrorKind.permissionDenied);
      expect(classifyEvidenceError(Exception('[x/permission-denied]')),
          EvidenceErrorKind.permissionDenied);
      expect(classifyEvidenceError(Exception('[x/unauthenticated]')),
          EvidenceErrorKind.notSignedIn);
    });
  });

  group('recoveryCheckMessage', () {
    test('a permission refusal says so and does not blame the connection', () {
      final m = recoveryCheckMessage(storage('unauthorized'));
      expect(m, contains('permission denied'));
      expect(m, contains('not a connection problem'));
      expect(m.contains('Check your connection'), isFalse);
    });

    test('a network failure still points at the connection', () {
      expect(recoveryCheckMessage(storage('retry-limit-exceeded')),
          contains('Check your connection'));
    });

    test('a sign-in failure asks the rider to sign in again', () {
      expect(recoveryCheckMessage(storage('unauthenticated')),
          contains('sign in again'));
    });

    test('an unknown failure blames neither permission nor connection', () {
      final m = recoveryCheckMessage(storage('unknown'));
      expect(m.contains('connection'), isFalse);
      expect(m.contains('permission'), isFalse);
    });
  });
}
