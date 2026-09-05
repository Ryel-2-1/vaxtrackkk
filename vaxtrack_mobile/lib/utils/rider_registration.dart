/// Rider self-registration payload.
///
/// Riders create their own accounts in this app; Admin only approves them. That
/// makes this the real identity boundary, so the fields that must never be
/// chosen by the person registering are SET here rather than read from the
/// form: role, initial status, and vehicle type.
///
/// The company operates motorcycles only for rider delivery work, so
/// `vehicleType` is always [kRiderVehicleType]. It is deliberately not a
/// parameter — a stale controller, a modified UI, or a future caller passing
/// its own value cannot override it.
///
/// Nothing here fabricates an identifier. The rider's own plate is passed
/// through as typed; no rider id, employee id or motorcycle id is invented.
///
/// Kept free of Firebase imports so it can be unit-tested directly. The two
/// server timestamps stay with the writer in `AuthService.registerRider`.
library;

/// The only vehicle type a rider account is registered with.
const String kRiderVehicleType = 'Motorcycle';

/// Riders may only ever self-register as riders.
const String kRiderRole = 'rider';

/// New riders always start unapproved and wait for an Admin decision.
const String kRiderInitialStatus = 'pending';

/// Build the Firestore fields for a new rider account.
///
/// Returns everything except `createdAt` / `updatedAt`, which are server
/// timestamps owned by the writer.
Map<String, Object?> buildRiderRegistrationFields({
  required String fullName,
  required String email,
  required String phone,
  required String vehiclePlate,
}) {
  return <String, Object?>{
    // Not parameters: a rider cannot register as admin, dispatcher or sales
    // rep, and cannot start already approved.
    'role': kRiderRole,
    'status': kRiderInitialStatus,
    'vehicleType': kRiderVehicleType,

    // Operator-supplied, passed through as typed.
    'fullName': fullName.trim(),
    'email': email.trim(),
    'phone': phone.trim(),
    'vehiclePlate': vehiclePlate.trim(),
  };
}
