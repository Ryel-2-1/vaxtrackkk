import '../utils/person_initials.dart';

class AppUser {
  final String uid;
  final String email;
  final String name;
  final String role;
  final String status;
  final String? employeeId;
  final String? vehiclePlate;
  final String? phone;
  final String? region;

  /// The rider's profile photo (2026-11-15): the Storage download URL and
  /// when it was set, from users/{uid}.photoUrl / photoUpdatedAt. Null when
  /// the rider has none — the avatar then shows initials.
  final String? photoUrl;
  final DateTime? photoUpdatedAt;

  AppUser({
    required this.uid,
    required this.email,
    required this.name,
    required this.role,
    required this.status,
    this.employeeId,
    this.vehiclePlate,
    this.phone,
    this.region,
    this.photoUrl,
    this.photoUpdatedAt,
  });

  factory AppUser.fromFirestore(String uid, Map<String, dynamic> data) {
    return AppUser(
      uid: uid,
      email: data['email'] ?? '',
      name: data['fullName'] ?? data['name'] ?? data['displayName'] ?? data['email'] ?? '',
      role: (data['role'] ?? '').toString().trim().toLowerCase(),
      status: (data['status'] ?? 'pending').toString().trim().toLowerCase(),
      employeeId: data['employeeId'],
      vehiclePlate: data['vehiclePlate'] ?? data['motorcycle'] ?? data['motorcycleId'] ?? data['vehicle'],
      phone: data['phone'] ?? data['contactNumber'],
      region: data['region'] ?? data['route'],
      photoUrl: data['photoUrl'] is String ? data['photoUrl'] as String : null,
      photoUpdatedAt: _toDateTime(data['photoUpdatedAt']),
    );
  }

  bool get isRider => role == 'rider';
  bool get isApproved => status == 'approved';
  bool get isPending => status == 'pending' || status == 'pending_approval';
  bool get isDisabled => status == 'disabled';
  bool get isRejected => status == 'rejected';
  bool get canAccess => isRider && isApproved;

  /// Up to three initials, the rule staff avatars use on the web.
  String get initials => initialsOf(name);

  /// The photo URL to display, versioned by its update time so a replaced
  /// photo is not served from the image cache; null when there is none.
  String? get displayPhotoUrl => profilePhotoDisplayUrl(photoUrl, photoUpdatedAt);

  static DateTime? _toDateTime(dynamic value) {
    if (value == null) return null;
    if (value is DateTime) return value;
    try {
      // A Firestore Timestamp, without importing cloud_firestore here.
      return (value as dynamic).toDate() as DateTime;
    } catch (_) {
      return null;
    }
  }
}
