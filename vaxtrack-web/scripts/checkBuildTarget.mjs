// Refuses a build whose Firebase project does not match its mode, so a
// production build can never ship pointing at staging, or the reverse.
// Reads the same values Vite will: .env.<mode> files and the host's
// environment variables (Netlify dashboard), which take precedence.
//   node scripts/checkBuildTarget.mjs production
import { loadEnv } from "vite";

export const EXPECTED_PROJECT = Object.freeze({
  staging: "vaxtrack-staging",
  production: "vaxtrack-bef1b",
});

export function checkBuildTarget(mode, env) {
  const expected = EXPECTED_PROJECT[mode];
  if (!expected) return `Unknown build mode "${mode}". Use staging or production.`;
  const actual = env.VITE_FIREBASE_PROJECT_ID;
  if (actual !== expected) {
    return `A ${mode} build must use Firebase project ${expected}, but VITE_FIREBASE_PROJECT_ID is ${actual ? `"${actual}"` : "not set"}.`;
  }
  return null;
}

// Run as a command (not when a test imports it).
if (process.argv[1]?.endsWith("checkBuildTarget.mjs")) {
  const mode = process.argv[2];
  const problem = checkBuildTarget(mode, loadEnv(mode, process.cwd(), "VITE_"));
  if (problem) {
    console.error(`\n✖ ${problem}\n`);
    process.exit(1);
  }
  console.log(`✓ ${mode} build targets ${EXPECTED_PROJECT[mode]}`);
}
