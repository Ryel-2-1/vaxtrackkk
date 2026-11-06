/**
 * The first Admin of a NEW VaxTrack installation. Run once, by the installer.
 *
 * An app screen that creates an Admin before any Admin exists could be used by
 * anyone, so the very first Admin is created here, with the installer's own
 * Firebase credentials, outside the app. After that, Admins add staff from
 * Admin → Settings → User Management (functions/src/staffAccounts.js).
 *
 *   # check only (reads): is there already an approved Admin?
 *   node scripts/createFirstAdmin.mjs --project <id> --email owner@client.ph --name "Owner Name"
 *   # create — repeat the email in --confirm
 *   node scripts/createFirstAdmin.mjs --project <id> --email owner@client.ph --name "Owner Name" --apply --confirm owner@client.ph
 *
 * It creates the Firebase Auth account WITHOUT a password, writes
 * users/{uid} as an approved Admin, records a staffAccountEvents entry, and
 * prints a one-time "set your password" link to hand to that person. The
 * password is chosen by them on Firebase's page; the installer never sees it.
 *
 * Guards: --project is required; vaxtrack-bef1b (the current production
 * project, which already has Admins) is refused; --apply needs --confirm equal
 * to --email; the server logic refuses whenever an approved Admin exists, so
 * the script can never add a second Admin to a running system.
 *
 * Credentials: Application Default Credentials (gcloud auth
 * application-default login), or the emulators via FIRESTORE_EMULATOR_HOST
 * and FIREBASE_AUTH_EMULATOR_HOST.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const admin = require("firebase-admin");
const staff = require("../src/staffAccounts.js");

export const REFUSED_PROJECTS = Object.freeze(["vaxtrack-bef1b"]);

/** Command-line options, validated. Throws (refusing) on anything unsafe. */
export function parseOptions(argv) {
  const value = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  };
  const project = value("--project");
  if (!project) throw new Error("--project is required.");
  if (REFUSED_PROJECTS.includes(project)) throw new Error(`${project} is refused: it already has Admins.`);
  const email = value("--email");
  const name = value("--name");
  if (!email || !name) throw new Error("--email and --name are required.");
  const apply = argv.includes("--apply");
  const confirm = value("--confirm");
  if (apply && (confirm ?? "").trim().toLowerCase() !== email.trim().toLowerCase()) {
    throw new Error("--apply requires --confirm with the same email as --email.");
  }
  // Same validation as the server (name length, email shape).
  staff.parseNewStaff({ name, email, role: "admin" });
  return { project, email, name, apply };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  admin.initializeApp({ projectId: options.project });
  const db = admin.firestore();
  const admins = await db.collection("users").where("role", "==", "admin").get();
  const approved = admins.docs.filter((d) => String(d.get("status") ?? "").trim().toLowerCase() === "approved").length;
  console.log(`Project ${options.project}: ${approved} approved Admin(s).`);
  if (approved > 0) {
    console.log("Nothing to do. Add staff from Admin → Settings → User Management.");
    return;
  }
  if (!options.apply) {
    console.log(`Ready to create ${options.email} as the first Admin. Re-run with --apply --confirm ${options.email}.`);
    return;
  }
  const result = await staff.bootstrapFirstAdmin({
    db,
    authAdmin: admin.auth(),
    FieldValue: admin.firestore.FieldValue,
    name: options.name,
    email: options.email,
  });
  console.log(`Created ${result.email} as the first Admin.`);
  console.log(
    result.setupLink
      ? `Send this one-time link so they can set their password:\n${result.setupLink}`
      : "No setup link could be made now. They can use Forgot password on the sign-in page.",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exitCode = 1;
  });
}
