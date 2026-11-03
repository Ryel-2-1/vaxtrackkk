import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vaxtrack_mobile/models/delivery.dart';
import 'package:vaxtrack_mobile/offline/offline_delivery_queue.dart';
import 'package:vaxtrack_mobile/offline/offline_delivery_record.dart';
import 'package:vaxtrack_mobile/services/image_upload_service.dart';
import 'package:vaxtrack_mobile/services/proof_service.dart';
import 'package:vaxtrack_mobile/utils/order_workflow.dart';
import 'package:vaxtrack_mobile/utils/proof_validation.dart';

const rider = 'riderA';
final t0 = DateTime.utc(2026, 11, 2, 8);

Delivery order(String id, {String status = 'in_transit', bool proof = false, bool invoice = false}) =>
    Delivery.fromFirestore(id, {
      'orderNumber': 'VT-$id',
      'clinicName': 'Terminal',
      'status': status,
      'assignedRiderId': rider,
      if (proof) ...{
        'proofOfDeliveryUrl': 'https://x/proof',
        'proofOfDeliveryPath': proofObjectPath(id),
        'proofRecipientName': 'Maria',
        'proofSubmittedAt': Timestamp.fromDate(t0),
      },
      if (invoice) ...{
        'invoiceUrl': 'https://x/invoice',
        'invoicePath': invoiceObjectPath(id),
        'invoiceSubmittedAt': Timestamp.fromDate(t0),
      },
    });

const capture = OfflineCapture(latitude: 14.6, longitude: 121.0, accuracyMeters: 8, capturedAtMs: 1793606400000);

class MemoryStore implements OfflineRecordStore {
  List<OfflineDeliveryRecord> saved = [];
  final Set<String> photosDeleted = {};
  @override
  Future<List<OfflineDeliveryRecord>> load() async => saved;
  @override
  Future<void> save(List<OfflineDeliveryRecord> records) async {
    // Round-trip through JSON, as the file store does.
    saved = records.map((r) => OfflineDeliveryRecord.fromJson(r.toJson())!).toList();
  }

  @override
  Future<String> keepPhoto(String orderId, String name, File photo) async => '/kept/$orderId/$name.jpg';
  @override
  Future<void> deletePhotos(String orderId) async => photosDeleted.add(orderId);
}

class FakeSender implements OfflineDeliverySender {
  Delivery Function(String id) server = (id) => order(id);
  bool offline = false;
  OfflineSubmitResult result = const OfflineSubmitResult(delivered: true);
  Object? submitError;
  final List<String> submitted = [];
  final List<String> failures = [];

  void _net() {
    if (offline) throw FirebaseException(plugin: 'cloud_firestore', code: 'unavailable');
  }

  @override
  Future<Delivery> fetchDelivery(String orderId) async {
    _net();
    return server(orderId);
  }

  @override
  Future<OfflineSubmitResult> submitOfflineCompletion(String orderId, OfflineCapture c) async {
    _net();
    if (submitError != null) throw submitError!;
    submitted.add(orderId);
    return result;
  }

  @override
  Future<void> reportDeliveryFailure(String orderId, String currentStatus, String reason) async {
    _net();
    failures.add('$orderId:$reason');
  }
}

class FakeUploader implements ProofUploader {
  final List<String> uploads = [];
  @override
  Future<EvidenceUpload> uploadProof(String orderId, File file) async {
    uploads.add('proof:$orderId');
    return EvidenceUpload(downloadUrl: 'https://x/p', storagePath: proofObjectPath(orderId));
  }

  @override
  Future<EvidenceUpload> uploadInvoice(String orderId, File file) async {
    uploads.add('invoice:$orderId');
    return EvidenceUpload(downloadUrl: 'https://x/i', storagePath: invoiceObjectPath(orderId));
  }

  @override
  Future<String?> existingProofUrl(String orderId) async => null;
  @override
  Future<String?> existingInvoiceUrl(String orderId) async => null;
}

class FakeWriter implements ProofMetadataWriter {
  final List<String> writes = [];
  @override
  Future<void> saveProofOfDelivery({required String orderId, required String recipientName, required String proofUrl, String? storagePath}) async =>
      writes.add('proof:$orderId:$recipientName');
  @override
  Future<void> saveInvoicePhoto({required String orderId, required String invoiceUrl, String? storagePath}) async =>
      writes.add('invoice:$orderId');
}

void main() {
  late MemoryStore store;
  late FakeSender sender;
  late FakeUploader uploader;
  late FakeWriter writer;
  late OfflineDeliveryQueue queue;
  String? signedIn;

  setUp(() {
    signedIn = rider;
    store = MemoryStore();
    sender = FakeSender()..offline = true;
    uploader = FakeUploader();
    writer = FakeWriter();
    queue = OfflineDeliveryQueue(
        currentRider: () => signedIn, store: store, sender: sender, uploader: uploader, writer: writer, clock: () => t0);
  });
  tearDown(() => queue.dispose());

  Future<void> saveCompletion({Delivery? d}) => queue.saveCompletion(
        delivery: d ?? order('o1'),
        recipientName: 'Maria Santos',
        proofPhoto: File('/camera/p.jpg'),
        invoicePhoto: File('/camera/i.jpg'),
        capture: capture,
      );

  test('saving needs no connection; the record and photo copies are kept on the phone', () async {
    await saveCompletion();
    await queue.idle;
    final r = store.saved.single;
    expect(r.stage, OfflineRecordStage.waiting);
    expect(r.proofPhotoPath, '/kept/o1/proof.jpg');
    expect(r.capture!.capturedAtMs, capture.capturedAtMs);
    expect(queue.isWaitingFor('o1'), isTrue);
    expect(sender.submitted, isEmpty);
    expect(offlineRecordStatusText(r), contains('saved on phone'));
  });

  test('back online: uploads and records both photos, then submits the handoff fix', () async {
    await saveCompletion();
    await queue.idle;
    sender.offline = false;
    await queue.sync();
    expect(uploader.uploads, ['proof:o1', 'invoice:o1']);
    expect(writer.writes, ['proof:o1:Maria Santos', 'invoice:o1']);
    expect(sender.submitted, ['o1']);
    expect(store.saved.single.stage, OfflineRecordStage.done);
    expect(store.photosDeleted, {'o1'});
    expect(queue.isWaitingFor('o1'), isFalse);
  });

  test('photos the order already recorded are not uploaded again (a retried send)', () async {
    await saveCompletion();
    await queue.idle;
    sender.offline = false;
    sender.server = (id) => order(id, proof: true, invoice: true);
    await queue.sync();
    expect(uploader.uploads, isEmpty);
    expect(sender.submitted, ['o1']);
  });

  test('still offline: the record stays waiting, untouched', () async {
    await saveCompletion();
    await queue.idle;
    await queue.sync();
    expect(store.saved.single.stage, OfflineRecordStage.waiting);
    expect(store.photosDeleted, isEmpty);
  });

  test('the server sends it to review: shown with the reason', () async {
    await saveCompletion();
    await queue.idle;
    sender.offline = false;
    sender.result = const OfflineSubmitResult(delivered: false, reviewReason: 'too_old');
    await queue.sync();
    final r = store.saved.single;
    expect(r.stage, OfflineRecordStage.inReview);
    expect(offlineRecordStatusText(r), contains('more than 3 hours'));
  });

  test('a refusal (order changed meanwhile) is kept with the reason, not retried forever', () async {
    await saveCompletion();
    await queue.idle;
    sender.offline = false;
    sender.submitError = const WorkflowException('not-assigned-rider', 'This delivery is not assigned to you.');
    await queue.sync();
    final r = store.saved.single;
    expect(r.stage, OfflineRecordStage.refused);
    expect(r.message, 'This delivery is not assigned to you.');
    await queue.dismiss('o1');
    expect(store.saved, isEmpty);
  });

  test('an order already delivered (e.g. sent from another attempt) is simply done', () async {
    await saveCompletion();
    await queue.idle;
    sender.offline = false;
    sender.server = (id) => order(id, status: 'delivered');
    await queue.sync();
    expect(sender.submitted, isEmpty);
    expect(store.saved.single.stage, OfflineRecordStage.done);
  });

  test('a failed-delivery report is kept offline and sent once back online', () async {
    await queue.saveFailure(delivery: order('o2'), reason: 'Clinic closed, no one to receive');
    await queue.idle;
    expect(store.saved.single.kind, OfflineRecordKind.failure);
    sender.offline = false;
    await queue.sync();
    expect(sender.failures, ['o2:Clinic closed, no one to receive']);
    expect(store.saved.single.stage, OfflineRecordStage.done);
  });

  test('nothing required may be missing, and a poor GPS fix is refused at the clinic', () async {
    expect(
      () => queue.saveCompletion(delivery: order('o1'), recipientName: '', proofPhoto: File('/p'), invoicePhoto: File('/i'), capture: capture),
      throwsA(isA<ProofException>()),
    );
    expect(
      () => queue.saveCompletion(delivery: order('o1'), recipientName: 'Maria', proofPhoto: null, invoicePhoto: File('/i'), capture: capture),
      throwsA(isA<ProofException>()),
    );
    const poor = OfflineCapture(latitude: 14.6, longitude: 121, accuracyMeters: 150, capturedAtMs: 1);
    expect(
      () => queue.saveCompletion(delivery: order('o1'), recipientName: 'Maria', proofPhoto: File('/p'), invoicePhoto: File('/i'), capture: poor),
      throwsA(isA<ProofException>()),
    );
    // Already recorded on the order: the photo is not needed again.
    await queue.saveCompletion(delivery: order('o3', proof: true), recipientName: '', proofPhoto: null, invoicePhoto: File('/i'), capture: capture);
    expect(queue.isWaitingFor('o3'), isTrue);
    await queue.idle;
  });

  test('records survive a restart (JSON round trip); damaged entries are skipped', () {
    final r = OfflineDeliveryRecord(
      riderUid: rider, orderId: 'o1', orderNumber: 'VT-1', destinationName: 'Terminal', kind: OfflineRecordKind.completion,
      recordedAtMs: 5, recipientName: 'Maria', proofPhotoPath: '/a', invoicePhotoPath: '/b', capture: capture,
    );
    final back = OfflineDeliveryRecord.fromJson(r.toJson())!;
    expect(back.toJson(), r.toJson());
    expect(OfflineDeliveryRecord.fromJson({'orderId': 'x'}), isNull);
    expect(OfflineDeliveryRecord.fromJson({...r.toJson(), 'capture': null}), isNull, reason: 'a completion needs its fix');
  });

  test('another rider on the same phone never sees or sends these records', () async {
    await saveCompletion();
    await queue.idle;
    signedIn = 'riderB';
    sender.offline = false;
    expect(queue.records, isEmpty);
    expect(queue.hasWaiting, isFalse);
    expect(queue.isWaitingFor('o1'), isFalse);
    await queue.sync();
    expect(sender.submitted, isEmpty, reason: "riderB must not send another rider's handoff");
    expect(store.saved.single.stage, OfflineRecordStage.waiting);
    // riderA back: it goes.
    signedIn = rider;
    await queue.sync();
    expect(sender.submitted, ['o1']);
  });

  test("signing out removes that rider's finished records and photos; unsent ones stay", () async {
    await queue.saveFailure(delivery: order('o2'), reason: 'Clinic closed, no one to receive');
    await queue.idle;
    sender.offline = false;
    await queue.sync();
    sender.offline = true;
    await saveCompletion();
    await queue.idle;
    expect(queue.waitingCountFor(rider), 1);
    await queue.onSignedOut(rider);
    expect(store.saved.map((r) => r.orderId), ['o1'], reason: 'the sent failure report is gone, the unsent completion stays');
    expect(store.photosDeleted, contains('o2'));
    expect(store.photosDeleted, isNot(contains('o1')));
  });

  test('saving with nobody signed in is refused', () async {
    signedIn = null;
    expect(() => saveCompletion(), throwsA(isA<ProofException>()));
    expect(() => queue.saveFailure(delivery: order('o2'), reason: 'Clinic closed, no one to receive'), throwsA(isA<ProofException>()));
  });

  test('on start, records with no owner or older than a week are dropped with their photos', () async {
    OfflineDeliveryRecord rec(String id, {String? uid = rider, required DateTime at}) => OfflineDeliveryRecord(
          riderUid: uid, orderId: id, orderNumber: 'VT-$id', destinationName: 'Terminal',
          kind: OfflineRecordKind.failure, recordedAtMs: at.millisecondsSinceEpoch, failureReason: 'Clinic closed');
    store.saved = [
      rec('fresh', at: t0.subtract(const Duration(days: 1))),
      rec('old', at: t0.subtract(const Duration(days: 8))),
      rec('nobody', uid: null, at: t0),
    ];
    await queue.load();
    expect(store.saved.map((r) => r.orderId), ['fresh']);
    expect(store.photosDeleted, {'old', 'nobody'});
  });

  test('the handoff fix reuses a recent, accurate tracker fix; otherwise a new one is taken', () {
    OfflineCapture? recent({double acc = 10, int ageS = 20}) => captureFromRecentFix(
          latitude: 14.6, longitude: 121.0, accuracyMeters: acc, capturedAt: t0.subtract(Duration(seconds: ageS)), now: t0);
    expect(recent()!.capturedAtMs, t0.subtract(const Duration(seconds: 20)).millisecondsSinceEpoch);
    expect(recent(ageS: 61), isNull);
    expect(recent(acc: 101), isNull);
  });

  test('a mock-location fix is sent flagged (and survives a restart); a real one sends no flag', () {
    const mocked = OfflineCapture(latitude: 14.6, longitude: 121.0, accuracyMeters: 8, capturedAtMs: 1, mocked: true);
    expect(mocked.toPayload()['mocked'], isTrue);
    expect(OfflineCapture.fromJson(mocked.toJson())!.mocked, isTrue);
    expect(capture.toPayload().containsKey('mocked'), isFalse);
    expect(
      captureFromRecentFix(latitude: 14.6, longitude: 121, accuracyMeters: 8, capturedAt: t0, now: t0, mocked: true)!.mocked,
      isTrue,
    );
    expect(kOfflineReviewReasons['mocked_location'], contains('mock-location'));
  });
}

extension on OfflineDeliveryQueue {
  /// Lets the background send started by a save finish.
  Future<void> get idle async {
    for (var i = 0; i < 5 && isSyncing; i++) {
      await Future<void>.delayed(Duration.zero);
    }
    await Future<void>.delayed(Duration.zero);
  }
}
