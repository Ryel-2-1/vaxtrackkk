import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Web App Check: initialised only when the project's reCAPTCHA Enterprise site
// key is configured, before any other Firebase service, with the debug token
// confined to local development; and every CSP lets its requests through.

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const firebase = read("src/firebase.js");

test("App Check starts only with a site key, and before Auth and Firestore", () => {
  assert.match(firebase, /import \{ initializeAppCheck, ReCaptchaEnterpriseProvider \} from "firebase\/app-check";/);
  assert.match(firebase, /const appCheckSiteKey = import\.meta\.env\.VITE_APPCHECK_RECAPTCHA_SITE_KEY;\s*\nif \(appCheckSiteKey\) \{/);
  assert.match(firebase, /provider: new ReCaptchaEnterpriseProvider\(appCheckSiteKey\)/);
  assert.match(firebase, /isTokenAutoRefreshEnabled: true/);
  const appCheckAt = firebase.indexOf("initializeAppCheck(app");
  assert.ok(appCheckAt > 0 && appCheckAt < firebase.indexOf("getAuth(app)"), "App Check must start before Auth");
  assert.ok(appCheckAt < firebase.indexOf("getFirestore(app)"), "App Check must start before Firestore");
});

test("the debug token can only ever be enabled in local development", () => {
  assert.match(
    firebase,
    /if \(import\.meta\.env\.DEV && import\.meta\.env\.VITE_APPCHECK_DEBUG === "true"\) \{\s*\n\s*globalThis\.FIREBASE_APPCHECK_DEBUG_TOKEN = true;/
  );
  assert.equal((firebase.match(/FIREBASE_APPCHECK_DEBUG_TOKEN/g) || []).length, 1);
});

test("dev, preview and Netlify CSPs allow reCAPTCHA Enterprise and the App Check endpoint", () => {
  const vite = read("vite.config.js");
  const netlify = read("../netlify.toml");
  for (const [name, src, count] of [["vite.config.js", vite, 2], ["netlify.toml", netlify, 1]]) {
    const directive = (dir) => [...src.matchAll(new RegExp(`${dir} [^;"]*`, "g"))].map((m) => m[0]);
    for (const d of directive("script-src")) assert.ok(d.includes("https://www.google.com/recaptcha/"), `${name} script-src`);
    for (const d of directive("frame-src")) assert.ok(d.includes("https://www.google.com/recaptcha/"), `${name} frame-src`);
    for (const d of directive("connect-src")) {
      assert.ok(d.includes("https://content-firebaseappcheck.googleapis.com"), `${name} connect-src`);
    }
    assert.equal(directive("connect-src").length, count, `${name} has ${count} connect-src`);
  }
});
