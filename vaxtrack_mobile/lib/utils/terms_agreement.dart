/// Terms of Use and Data Privacy agreement (2026-11-12).
///
/// The Rider app's copy of vaxtrack-web/src/services/termsAgreement.js: the
/// same version and the same wording (a web test compares the two files).
/// Riders agree once — on the sign-up form, or the first time they sign in —
/// and the acceptance is stored on users/{uid} as `termsAcceptedVersion` and
/// `termsAcceptedAt` (server time; firestore.rules pins both).
///
/// WORDING: a plain-language DRAFT for 3MGS Pharma to review with their own
/// counsel before production use.
///
/// Pure: no Flutter or Firebase imports.
library;

/// The date this wording took effect. Change it to ask everyone again.
const String kTermsVersion = '2026-11-12';

const String kTermsTitle = 'Terms of Use and Data Privacy Agreement';

const String kTermsIntro =
    "VaxTrack holds information about 3MGS Pharma's clients, orders and deliveries. "
    'Before you use it, please read and agree to the following.';

class TermsSection {
  const TermsSection(this.heading, this.body);
  final String heading;
  final List<String> body;
}

const List<TermsSection> kTermsSections = [
  TermsSection('1. Information you will see', [
    'VaxTrack contains confidential business and personal information: the names, addresses and contact details of doctors, clinics and their staff; orders, prices and invoices; stock records; delivery locations and proof-of-delivery photos; and the location of riders on delivery.',
  ]),
  TermsSection('2. How you may use it', [
    'Use this information only to do your work for 3MGS Pharma.',
    'Do not copy, photograph, screenshot, download, share, post or sell it, and do not use it for yourself, for another business or for anyone outside 3MGS Pharma.',
    'Open only the records you need for your work.',
  ]),
  TermsSection('3. Your account', [
    'Your account is for you alone. Keep your password private and do not let anyone else use your account.',
    'Tell an Administrator at once if your phone or password is lost, or if you think someone else has seen information they should not have.',
  ]),
  TermsSection('4. Data Privacy Act of 2012', [
    'Personal information in VaxTrack is protected by Republic Act No. 10173, the Data Privacy Act of 2012, and its Implementing Rules and Regulations.',
    'Using or disclosing personal information without authority can lead to disciplinary action by 3MGS Pharma and to penalties under that law.',
  ]),
  TermsSection('5. Information about you', [
    'VaxTrack records your name, contact details and the actions you take in it, so that orders and deliveries can be traced.',
    'For riders, the app shares your location with 3MGS Pharma dispatch while you have deliveries assigned to you, to monitor those deliveries.',
  ]),
  TermsSection('6. How long this applies', [
    'These duties continue after you stop using VaxTrack and after your work with 3MGS Pharma ends.',
  ]),
];

/// The sentence beside the tick box.
const String kTermsConsentLabel =
    'I have read and agree to the Terms of Use and Data Privacy Agreement.';

const String kTermsRequiredMessage = 'Please read and tick the agreement to continue.';

/// True when this users/{uid} record agreed to the wording now in force.
bool hasAcceptedCurrentTerms(Map<String, dynamic>? profile) =>
    profile != null &&
    profile['termsAcceptedVersion'] == kTermsVersion &&
    profile['termsAcceptedAt'] != null;
