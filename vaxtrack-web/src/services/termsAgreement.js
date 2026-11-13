/**
 * Terms of Use and Data Privacy agreement (2026-11-12).
 *
 * Every account agrees once: applicants on the sign-up form, and anyone whose
 * account was created for them (Add Staff) the first time they sign in. The
 * acceptance is stored on users/{uid} as `termsAcceptedVersion` and
 * `termsAcceptedAt` (server time; firestore.rules pins both). Raising
 * TERMS_VERSION asks everyone again.
 *
 * WORDING: a plain-language DRAFT written for 3MGS Pharma to review with their
 * own counsel before production use. It is not legal advice. The Rider app
 * shows the same text (vaxtrack_mobile/lib/utils/terms_agreement.dart); a
 * test keeps the version and wording identical.
 *
 * Pure: no Firebase or React import.
 */

/** The date this wording took effect. Change it to ask everyone to agree again. */
export const TERMS_VERSION = "2026-11-12";

export const TERMS_TITLE = "Terms of Use and Data Privacy Agreement";

export const TERMS_INTRO =
  "VaxTrack holds information about 3MGS Pharma's clients, orders and deliveries. " +
  "Before you use it, please read and agree to the following.";

export const TERMS_SECTIONS = Object.freeze([
  {
    heading: "1. Information you will see",
    body: [
      "VaxTrack contains confidential business and personal information: the names, addresses and contact details of doctors, clinics and their staff; orders, prices and invoices; stock records; delivery locations and proof-of-delivery photos; and the location of riders on delivery.",
    ],
  },
  {
    heading: "2. How you may use it",
    body: [
      "Use this information only to do your work for 3MGS Pharma.",
      "Do not copy, photograph, screenshot, download, share, post or sell it, and do not use it for yourself, for another business or for anyone outside 3MGS Pharma.",
      "Open only the records you need for your work.",
    ],
  },
  {
    heading: "3. Your account",
    body: [
      "Your account is for you alone. Keep your password private and do not let anyone else use your account.",
      "Tell an Administrator at once if your phone or password is lost, or if you think someone else has seen information they should not have.",
    ],
  },
  {
    heading: "4. Data Privacy Act of 2012",
    body: [
      "Personal information in VaxTrack is protected by Republic Act No. 10173, the Data Privacy Act of 2012, and its Implementing Rules and Regulations.",
      "Using or disclosing personal information without authority can lead to disciplinary action by 3MGS Pharma and to penalties under that law.",
    ],
  },
  {
    heading: "5. Information about you",
    body: [
      "VaxTrack records your name, contact details and the actions you take in it, so that orders and deliveries can be traced.",
      "For riders, the app shares your location with 3MGS Pharma dispatch while you have deliveries assigned to you, to monitor those deliveries.",
    ],
  },
  {
    heading: "6. How long this applies",
    body: [
      "These duties continue after you stop using VaxTrack and after your work with 3MGS Pharma ends.",
    ],
  },
]);

/** The sentence beside the tick box. */
export const TERMS_CONSENT_LABEL =
  "I have read and agree to the Terms of Use and Data Privacy Agreement.";

export const TERMS_REQUIRED_MESSAGE =
  "Please read and tick the agreement to continue.";

/** True when this profile agreed to the wording now in force. */
export function hasAcceptedCurrentTerms(profile) {
  return profile?.termsAcceptedVersion === TERMS_VERSION && profile?.termsAcceptedAt != null;
}

/**
 * The fields recorded on users/{uid} when someone agrees. [serverTime] is the
 * Firestore serverTimestamp() sentinel, passed in so this stays pure.
 */
export function termsAcceptanceFields(serverTime) {
  return { termsAcceptedVersion: TERMS_VERSION, termsAcceptedAt: serverTime };
}
