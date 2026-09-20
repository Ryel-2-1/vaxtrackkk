/**
 * Public account-application logic — pure and dependency-free.
 *
 * A visitor applies for a staff position (sales rep, dispatcher, or rider) by
 * creating their own login. The account lands as `status: "pending"` and can do
 * NOTHING until an admin approves it in User Management. No Firebase and no
 * React live here — Register.jsx supplies the real createUser/setDoc; every
 * decision about what a valid application is, and — critically — that the
 * applied-for role can never be `admin`, lives here so it is unit-testable.
 *
 * The applied-for position is stored as the document's own `role` with
 * `status: "pending"`, exactly as a self-registering rider already does. That
 * role carries NO privilege while pending — the route guards and the Firestore
 * rules deny every pending user — so approval is a deliberate admin act, never
 * something an applicant grants themselves. `admin` is deliberately not an
 * option and is refused by buildApplicationProfile even if a tampered client
 * asks for it; the Firestore rules enforce the same boundary as the real
 * authority.
 */

/**
 * The positions a visitor may apply for. `admin` is NEVER here — an admin is
 * created only by an existing admin changing an approved user's role in User
 * Management, never applied for through a public form.
 */
export const APPLICABLE_ROLES = Object.freeze([
  { value: "salesrep", label: "Sales Representative" },
  { value: "dispatcher", label: "Dispatcher" },
  { value: "rider", label: "Rider" },
]);

const APPLICABLE_ROLE_VALUES = Object.freeze(APPLICABLE_ROLES.map((r) => r.value));

/**
 * The company operates motorcycles only, so a rider application is pinned to
 * this one vehicle type — identical to the Flutter self-registration contract
 * (kRiderVehicleType) and the Firestore rule that requires it.
 */
export const RIDER_VEHICLE_TYPE = "Motorcycle";

export const MIN_PASSWORD_LENGTH = 8;

// Loose "is this even an address" gate; Firebase is the real authority.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isApplicableRole(role) {
  return APPLICABLE_ROLE_VALUES.includes(role);
}

function cleanText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

/**
 * Validate an application before any network call. Returns the cleaned values
 * on success so the caller stores exactly what was checked.
 */
export function validateApplication({ name, email, password, confirmPassword, role }) {
  const cleanName = cleanText(name);
  const cleanEmail = typeof email === "string" ? email.trim() : "";

  if (!cleanName) return { ok: false, message: "Please enter your full name." };
  if (!cleanEmail) return { ok: false, message: "Please enter your email address." };
  if (!EMAIL_SHAPE.test(cleanEmail)) {
    return { ok: false, message: "Please enter a valid email address." };
  }
  if (!isApplicableRole(role)) {
    return { ok: false, message: "Please choose the position you are applying for." };
  }
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (password !== confirmPassword) {
    return { ok: false, message: "Passwords do not match." };
  }

  return { ok: true, value: { name: cleanName, email: cleanEmail, role } };
}

/**
 * Build the users/{uid} document for a new application. Pure — the component
 * adds createdAt/updatedAt with serverTimestamp().
 *
 * The role is SET from the applicable allowlist, never read blindly, and a
 * value outside it (including "admin") THROWS. That means a stale draft, a
 * tampered DOM value, or a caller supplying its own role cannot mint an admin
 * application through this path. The document is always `status: "pending"`; a
 * rider is pinned to the one supported vehicle type.
 */
export function buildApplicationProfile({ name, email, role, phone }) {
  if (!isApplicableRole(role)) {
    throw new Error(`Role "${role}" is not an applicable position.`);
  }
  const profile = {
    fullName: cleanText(name),
    email: typeof email === "string" ? email.trim() : "",
    role,
    status: "pending",
  };
  const cleanPhone = cleanText(phone);
  if (cleanPhone) profile.phone = cleanPhone;
  if (role === "rider") profile.vehicleType = RIDER_VEHICLE_TYPE;
  return profile;
}

/**
 * Firebase Auth codes -> applicant-facing text.
 *
 * Unlike password reset, a registration form legitimately reveals that an email
 * is already taken — the applicant cannot proceed otherwise, and there is
 * nothing to hide that signing in would not also show.
 */
export function mapRegistrationError(code) {
  if (code === "auth/email-already-in-use") {
    return "An account with this email already exists. Try signing in, or reset your password.";
  }
  if (code === "auth/invalid-email") {
    return "Please enter a valid email address.";
  }
  if (code === "auth/weak-password") {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (code === "auth/too-many-requests") {
    return "Too many attempts. Please wait a moment and then try again.";
  }
  if (code === "auth/network-request-failed") {
    return "Unable to connect. Check your internet connection and try again.";
  }
  return "Something went wrong. Please try again.";
}
