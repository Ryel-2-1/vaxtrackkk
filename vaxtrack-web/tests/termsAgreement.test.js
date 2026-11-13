import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TERMS_CONSENT_LABEL,
  TERMS_INTRO,
  TERMS_SECTIONS,
  TERMS_TITLE,
  TERMS_VERSION,
  hasAcceptedCurrentTerms,
  termsAcceptanceFields,
} from "../src/services/termsAgreement.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("an account has agreed only to the wording now in force, with a recorded time", () => {
  assert.equal(hasAcceptedCurrentTerms(null), false);
  assert.equal(hasAcceptedCurrentTerms({}), false);
  assert.equal(hasAcceptedCurrentTerms({ termsAcceptedVersion: TERMS_VERSION }), false, "no time, not accepted");
  assert.equal(hasAcceptedCurrentTerms({ termsAcceptedVersion: "2020-01-01", termsAcceptedAt: {} }), false, "an older wording asks again");
  assert.equal(hasAcceptedCurrentTerms({ termsAcceptedVersion: TERMS_VERSION, termsAcceptedAt: {} }), true);
  assert.deepEqual(termsAcceptanceFields("NOW"), { termsAcceptedVersion: TERMS_VERSION, termsAcceptedAt: "NOW" });
  assert.match(TERMS_VERSION, /^\d{4}-\d{2}-\d{2}$/, "the shape firestore.rules accepts");
});

test("the agreement names the Data Privacy Act and the confidentiality duty", () => {
  const text = TERMS_SECTIONS.flatMap((s) => [s.heading, ...s.body]).join(" ");
  assert.match(text, /Republic Act No\. 10173/);
  assert.match(text, /Data Privacy Act of 2012/);
  assert.match(text, /only to do your work for 3MGS Pharma/);
  assert.match(text, /Do not copy, photograph, screenshot, download, share, post or sell/);
});

test("the Rider app shows the same version and wording as the web", () => {
  const dart = read("../vaxtrack_mobile/lib/utils/terms_agreement.dart");
  assert.ok(dart.includes(`const String kTermsVersion = '${TERMS_VERSION}';`), "same version");
  assert.ok(dart.includes(`'${TERMS_TITLE}'`), "same title");
  assert.ok(dart.includes(`'${TERMS_CONSENT_LABEL}'`), "same tick-box sentence");
  // Dart writes the intro across two string literals; compare without the join.
  const flat = dart.replace(/"\s*\n\s*'/g, "").replace(/'\s*\n\s*'/g, "");
  assert.ok(flat.includes(TERMS_INTRO.replace("3MGS Pharma's", "3MGS Pharma's")), "same intro");
  for (const section of TERMS_SECTIONS) {
    assert.ok(dart.includes(`'${section.heading}'`), section.heading);
    for (const line of section.body) assert.ok(dart.includes(`'${line}'`), line.slice(0, 50));
  }
});

test("every role's area sits behind the agreement, and sign-up requires the tick", () => {
  for (const guard of ["AdminRoute", "SalesRepRoute", "DispatcherRoute"]) {
    assert.match(read(`src/components/${guard}.jsx`), /return <TermsGate><Outlet \/><\/TermsGate>;/, guard);
  }
  const register = read("src/pages/Register.jsx");
  assert.match(register, /if \(!agreed\) \{\s*fail\(TERMS_REQUIRED_MESSAGE, "terms"\);\s*return;/);
  assert.match(register, /\.\.\.termsAcceptanceFields\(serverTimestamp\(\)\),/);
  const gate = read("src/components/terms/TermsGate.jsx");
  assert.match(gate, /updateDoc\(doc\(db, "users", uid\), termsAcceptanceFields\(serverTimestamp\(\)\)\)/);
  // The Rider app: tick required on sign-up, gate before the home screen.
  assert.match(read("../vaxtrack_mobile/lib/screens/register_screen.dart"), /if \(!_agreedToTerms\) \{/);
  assert.match(read("../vaxtrack_mobile/lib/app.dart"), /TermsGate\(uid: uid, child: const HomeScreen\(\)\)/);
  const rules = read("firestore.rules");
  assert.match(rules, /d\.get\('termsAcceptedAt', null\) == request\.time/);
  assert.match(rules, /&& !changedKeys\(\)\.hasAny\(termsUserFields\(\)\)/, "an Admin cannot agree for someone else");
});
