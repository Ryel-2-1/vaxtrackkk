/// A delivery outcome the Rider recorded ON THE PHONE because there was no
/// signal at the clinic: a completion (photos + recipient + the GPS fix taken
/// at the handoff) or a failed-delivery report. It is sent by itself once the
/// phone is back online (OfflineDeliveryQueue).
///
/// The server decides what it is worth: a completion is checked against the
/// clinic geofence and the Rider's tracked trail and completes the order only
/// when it fits (functions/src/offlineCompletion.js); otherwise a Dispatcher
/// reviews it. Nothing here ever marks an order delivered.
library;

enum OfflineRecordKind { completion, failure }

/// Where a record is on its way to the server.
enum OfflineRecordStage {
  /// Saved on the phone; not sent yet (or the last attempt had no signal).
  waiting,

  /// Sent. The server accepted it: the order is delivered / reported failed.
  done,

  /// Sent. The server could not verify it; a Dispatcher reviews it.
  inReview,

  /// Sent and refused (the order changed meanwhile, …). Shown with the reason.
  refused,
}

/// The GPS fix taken at the handoff, from the phone's GPS (works offline).
class OfflineCapture {
  final double latitude;
  final double longitude;
  final double accuracyMeters;
  final int capturedAtMs;

  /// The phone said this fix came from a mock-location app. The server never
  /// verifies such a record automatically; a Dispatcher reviews it.
  final bool mocked;

  const OfflineCapture({
    required this.latitude,
    required this.longitude,
    required this.accuracyMeters,
    required this.capturedAtMs,
    this.mocked = false,
  });

  /// Exactly the server's payload shape (offlineCompletion.parseOfflinePayload).
  Map<String, Object> toPayload() => {
        'latitude': latitude,
        'longitude': longitude,
        'accuracyMeters': accuracyMeters,
        'capturedAtMs': capturedAtMs,
        if (mocked) 'mocked': true,
      };

  Map<String, Object> toJson() => toPayload();

  static OfflineCapture? fromJson(Object? json) {
    if (json is! Map) return null;
    final lat = json['latitude'], lng = json['longitude'], acc = json['accuracyMeters'], at = json['capturedAtMs'];
    if (lat is! num || lng is! num || acc is! num || at is! int) return null;
    return OfflineCapture(
      latitude: lat.toDouble(),
      longitude: lng.toDouble(),
      accuracyMeters: acc.toDouble(),
      capturedAtMs: at,
      mocked: json['mocked'] == true,
    );
  }
}

class OfflineDeliveryRecord {
  /// The signed-in rider who saved it. Only that rider's app session ever
  /// shows or sends it; null only on records from before this field existed,
  /// which are dropped.
  final String? riderUid;
  final String orderId;
  final String orderNumber;
  final String destinationName;
  final OfflineRecordKind kind;
  final int recordedAtMs;

  /// Completion only.
  final String? recipientName;
  final String? proofPhotoPath;
  final String? invoicePhotoPath;
  final OfflineCapture? capture;

  /// Failure only.
  final String? failureReason;

  final OfflineRecordStage stage;

  /// Why it was refused or is in review (Rider-facing), when known.
  final String? message;
  final int attempts;

  const OfflineDeliveryRecord({
    this.riderUid,
    required this.orderId,
    required this.orderNumber,
    required this.destinationName,
    required this.kind,
    required this.recordedAtMs,
    this.recipientName,
    this.proofPhotoPath,
    this.invoicePhotoPath,
    this.capture,
    this.failureReason,
    this.stage = OfflineRecordStage.waiting,
    this.message,
    this.attempts = 0,
  });

  bool get isWaiting => stage == OfflineRecordStage.waiting;

  OfflineDeliveryRecord copyWith({OfflineRecordStage? stage, String? message, int? attempts}) => OfflineDeliveryRecord(
        riderUid: riderUid,
        orderId: orderId,
        orderNumber: orderNumber,
        destinationName: destinationName,
        kind: kind,
        recordedAtMs: recordedAtMs,
        recipientName: recipientName,
        proofPhotoPath: proofPhotoPath,
        invoicePhotoPath: invoicePhotoPath,
        capture: capture,
        failureReason: failureReason,
        stage: stage ?? this.stage,
        message: message ?? this.message,
        attempts: attempts ?? this.attempts,
      );

  Map<String, Object?> toJson() => {
        'riderUid': riderUid,
        'orderId': orderId,
        'orderNumber': orderNumber,
        'destinationName': destinationName,
        'kind': kind.name,
        'recordedAtMs': recordedAtMs,
        'recipientName': recipientName,
        'proofPhotoPath': proofPhotoPath,
        'invoicePhotoPath': invoicePhotoPath,
        'capture': capture?.toJson(),
        'failureReason': failureReason,
        'stage': stage.name,
        'message': message,
        'attempts': attempts,
      };

  /// Null for anything unreadable (a damaged file never crashes the app).
  static OfflineDeliveryRecord? fromJson(Object? json) {
    if (json is! Map) return null;
    final orderId = json['orderId'];
    final kind = OfflineRecordKind.values.where((k) => k.name == json['kind']).firstOrNull;
    final stage = OfflineRecordStage.values.where((s) => s.name == json['stage']).firstOrNull;
    final recordedAt = json['recordedAtMs'];
    if (orderId is! String || orderId.isEmpty || kind == null || stage == null || recordedAt is! int) return null;
    final capture = OfflineCapture.fromJson(json['capture']);
    if (kind == OfflineRecordKind.completion && capture == null) return null;
    String? str(String k) => json[k] is String ? json[k] as String : null;
    return OfflineDeliveryRecord(
      riderUid: str('riderUid'),
      orderId: orderId,
      orderNumber: str('orderNumber') ?? '',
      destinationName: str('destinationName') ?? '',
      kind: kind,
      recordedAtMs: recordedAt,
      recipientName: str('recipientName'),
      proofPhotoPath: str('proofPhotoPath'),
      invoicePhotoPath: str('invoicePhotoPath'),
      capture: capture,
      failureReason: str('failureReason'),
      stage: stage,
      message: str('message'),
      attempts: json['attempts'] is int ? json['attempts'] as int : 0,
    );
  }
}

/// The handoff fix: the tracker's latest fix when it is recent and accurate
/// enough, so no extra GPS wait is needed; otherwise null (take a new one).
OfflineCapture? captureFromRecentFix({
  required double? latitude,
  required double? longitude,
  required double? accuracyMeters,
  required DateTime? capturedAt,
  required DateTime now,
  Duration maxAge = const Duration(seconds: 60),
  bool mocked = false,
}) {
  if (latitude == null || longitude == null || accuracyMeters == null || capturedAt == null) return null;
  if (now.difference(capturedAt) > maxAge || capturedAt.isAfter(now.add(const Duration(seconds: 5)))) return null;
  if (accuracyMeters > kOfflineMaxAccuracyMeters) return null;
  return OfflineCapture(
    latitude: latitude,
    longitude: longitude,
    accuracyMeters: accuracyMeters,
    capturedAtMs: capturedAt.millisecondsSinceEpoch,
    mocked: mocked,
  );
}

/// Same as the server's MAX_ACCURACY_M: a worse fix cannot place the Rider.
const double kOfflineMaxAccuracyMeters = 100;

/// Rider-facing line for a record's state.
String offlineRecordStatusText(OfflineDeliveryRecord r) {
  final what = r.kind == OfflineRecordKind.completion ? 'Proof' : 'Failed-delivery report';
  switch (r.stage) {
    case OfflineRecordStage.waiting:
      return '$what saved on phone — will send when you are back online.';
    case OfflineRecordStage.done:
      return r.kind == OfflineRecordKind.completion ? 'Sent — delivery completed.' : 'Sent — delivery reported as failed.';
    case OfflineRecordStage.inReview:
      return 'Sent — waiting for dispatcher review${r.message == null ? '.' : ': ${r.message}'}';
    case OfflineRecordStage.refused:
      return 'Could not be sent${r.message == null ? '.' : ': ${r.message}'}';
  }
}
