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
  { value: "salesrep", label: "Medical Representative" },
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

export function passwordRequirements(password) {
  const value = typeof password === "string" ? password : "";
  return [
    { key: "length", label: `${MIN_PASSWORD_LENGTH}+ characters`, message: `at least ${MIN_PASSWORD_LENGTH} characters`, met: value.length >= MIN_PASSWORD_LENGTH },
    { key: "upper", label: "Uppercase letter", message: "an uppercase letter", met: /[A-Z]/.test(value) },
    { key: "lower", label: "Lowercase letter", message: "a lowercase letter", met: /[a-z]/.test(value) },
    { key: "number", label: "Number", message: "a number", met: /[0-9]/.test(value) },
    { key: "symbol", label: "Symbol, such as ! or #", message: "a symbol (for example, ! or #)", met: /[^A-Za-z0-9\s]/u.test(value) },
  ];
}

export function passwordStrength(password) {
  const value = typeof password === "string" ? password : "";
  const requirements = passwordRequirements(value);
  const characterScore = Math.min(value.length, MIN_PASSWORD_LENGTH) / MIN_PASSWORD_LENGTH * 40;
  const varietyScore = requirements.slice(1).filter((rule) => rule.met).length * 15;
  const percent = Math.round(characterScore + varietyScore);
  const strong = requirements.every((rule) => rule.met);
  return {
    percent,
    label: strong ? "Strong password" : !value ? "Password strength" : percent >= 60 ? "Moderate password" : "Weak password",
    tone: strong ? "strong" : percent >= 60 ? "progressing" : "starting",
  };
}

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

  // `field` names the input each message belongs to, so the page can show it
  // there, mark it invalid and focus it.
  if (!cleanName) return { ok: false, field: "name", message: "Please enter your full name." };
  if (!cleanEmail) return { ok: false, field: "email", message: "Please enter your email address." };
  if (!EMAIL_SHAPE.test(cleanEmail)) {
    return { ok: false, field: "email", message: "Please enter a valid email address." };
  }
  if (!isApplicableRole(role)) {
    return { ok: false, field: "role", message: "Please choose the position you are applying for." };
  }
  const unmetPasswordRule = passwordRequirements(password).find((rule) => !rule.met);
  if (unmetPasswordRule) {
    return {
      ok: false,
      field: "password",
      message: `Password needs ${unmetPasswordRule.message}.`,
    };
  }
  if (password !== confirmPassword) {
    return { ok: false, field: "confirmPassword", message: "Passwords do not match." };
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
    return "This password was rejected. Use 8 or more characters with uppercase and lowercase letters, a number, and a symbol.";
  }
  if (code === "auth/too-many-requests") {
    return "Too many attempts. Please wait a moment and then try again.";
  }
  if (code === "auth/network-request-failed") {
    return "Unable to connect. Check your internet connection and try again.";
  }
  return "We couldn't submit your application. Nothing was saved — please try again.";
}

/** The form field a registration failure belongs to, by its code (or null). */
export function registrationErrorField(code) {
  if (code === "auth/email-already-in-use" || code === "auth/invalid-email") return "email";
  if (code === "auth/weak-password") return "password";
  return null;
}
