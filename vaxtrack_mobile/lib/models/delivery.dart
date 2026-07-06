import 'package:cloud_firestore/cloud_firestore.dart';

class Delivery {
  final String id;
  final String orderNumber;
  final String clinicName;
  final String clinicAddress;
  final String vaccineName;
  final String? vaccineType;
  final int quantity;
  final String unit;
  final String priority;
  final String status;
  final String statusLabel;
  final String? region;
  final String? deliveryInstructions;
  final String? assignedRiderId;
  final String? assignedRiderName;
  final String? proofOfDeliveryUrl;
  final String? invoiceUrl;
  final List<String> itemSummaries;
  final DateTime? createdAt;
  final DateTime? assignedAt;
  final DateTime? startedAt;
  final DateTime? deliveredAt;
  final DateTime? updatedAt;
  final GeoPoint? lastLocation;

  Delivery({
    required this.id,
    required this.orderNumber,
    required this.clinicName,
    required this.clinicAddress,
    required this.vaccineName,
    this.vaccineType,
    required this.quantity,
    required this.unit,
    required this.priority,
    required this.status,
    required this.statusLabel,
    this.region,
    this.deliveryInstructions,
    this.assignedRiderId,
    this.assignedRiderName,
    this.proofOfDeliveryUrl,
    this.invoiceUrl,
    this.itemSummaries = const [],
    this.createdAt,
    this.assignedAt,
    this.startedAt,
    this.deliveredAt,
    this.updatedAt,
    this.lastLocation,
  });

  factory Delivery.fromFirestore(String docId, Map<String, dynamic> data) {
    final rawStatus = _getStatus(data);
    final normalizedStatus = _normalizeStatus(rawStatus);

    return Delivery(
      id: docId,
      orderNumber: data['orderNumber'] ?? docId,
      clinicName: data['clinicName'] ?? 'Unknown Clinic',
      clinicAddress: data['clinicAddress'] ?? '',
      vaccineName: data['vaccineName'] ?? '',
      vaccineType: data['vaccineType'],
      quantity: (data['quantity'] ?? 0).toInt(),
      unit: data['unit'] ?? 'vials',
      priority: data['priority'] ?? 'Standard',
      status: normalizedStatus,
      statusLabel: _statusLabel(normalizedStatus),
      region: data['region'],
      deliveryInstructions: data['deliveryInstructions'],
      assignedRiderId: data['assignedRiderId'],
      assignedRiderName: data['assignedRiderName'],
      proofOfDeliveryUrl: data['proofOfDeliveryUrl'],
      invoiceUrl: data['invoiceUrl'],
      itemSummaries: _itemSummaries(data['items']),
      createdAt: _toDateTime(data['createdAt']),
      assignedAt: _toDateTime(data['assignedAt']),
      startedAt: _toDateTime(data['startedAt']),
      deliveredAt: _toDateTime(data['deliveredAt']),
      updatedAt: _toDateTime(data['updatedAt']),
      lastLocation: data['lastLocation'] as GeoPoint?,
    );
  }

  static List<String> _itemSummaries(dynamic items) {
    if (items is! List) return const [];
    return items
        .whereType<Map>()
        .map((item) {
          final name = (item['vaccineName'] ?? item['name'] ?? '').toString();
          if (name.isEmpty) return '';
          final qty = item['quantity'];
          final unit = (item['unit'] ?? 'vials').toString();
          return qty == null ? name : '$name — $qty $unit';
        })
        .where((s) => s.isNotEmpty)
        .toList();
  }

  bool get isDelivered => status == 'delivered' || status == 'completed';
  bool get isInTransit => status == 'in_transit';
  bool get isLoading => status == 'loading';
  bool get isAssigned => status == 'assigned';
  bool get isDelayed => status == 'delayed';
  bool get isCancelled => status == 'cancelled' || status == 'canceled';
  bool get isActive => !isDelivered && !isCancelled;
  bool get isUrgent => priority == 'Urgent' && !isDelivered;
  bool get canStartLoading => status == 'assigned';
  bool get canStartTransit => status == 'loading';
  bool get canDeliver => status == 'in_transit';

  static String _getStatus(Map<String, dynamic> data) {
    return (data['status'] ??
            data['orderStatus'] ??
            data['deliveryStatus'] ??
            data['shipmentStatus'] ??
            data['dispatchStatus'] ??
            'pending')
        .toString();
  }

  static String _normalizeStatus(String raw) {
    return raw.trim().toLowerCase().replaceAll('-', '_').replaceAll(RegExp(r'\s+'), '_');
  }

  static String _statusLabel(String status) {
    switch (status) {
      case 'pending':
      case 'pending_dispatch':
        return 'Pending';
      case 'assigned':
        return 'Assigned';
      case 'loading':
        return 'Loading';
      case 'in_transit':
        return 'In Transit';
      case 'delivered':
      case 'completed':
        return 'Delivered';
      case 'delayed':
        return 'Delayed';
      case 'cancelled':
      case 'canceled':
        return 'Cancelled';
      default:
        return 'Pending';
    }
  }

  static DateTime? _toDateTime(dynamic value) {
    if (value is Timestamp) return value.toDate();
    if (value is DateTime) return value;
    return null;
  }
}
