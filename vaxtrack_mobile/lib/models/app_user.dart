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
    );
  }

  bool get isRider => role == 'rider';
  bool get isApproved => status == 'approved';
  bool get isPending => status == 'pending' || status == 'pending_approval';
  bool get isDisabled => status == 'disabled';
  bool get isRejected => status == 'rejected';
  bool get canAccess => isRider && isApproved;
}
