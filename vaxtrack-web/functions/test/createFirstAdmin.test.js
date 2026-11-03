"use strict";

// The first-Admin setup script's command-line guards (scripts/createFirstAdmin.mjs).

const test = require("node:test");
const assert = require("node:assert/strict");

test("the setup script refuses unsafe or incomplete commands", async () => {
  const script = await import("../scripts/createFirstAdmin.mjs");
  const base = ["--project", "client-vaxtrack", "--email", "owner@client.ph", "--name", "Owner Name"];
  assert.throws(() => script.parseOptions([]), /--project is required/);
  assert.throws(() => script.parseOptions(["--project", "vaxtrack-bef1b", "--email", "a@b.ph", "--name", "Ab Cd"]), /refused/);
  assert.throws(() => script.parseOptions(["--project", "client-vaxtrack"]), /--email and --name are required/);
  assert.throws(() => script.parseOptions([...base, "--apply"]), /--confirm with the same email/);
  assert.throws(() => script.parseOptions([...base, "--apply", "--confirm", "typo@client.ph"]), /--confirm with the same email/);
  assert.throws(() => script.parseOptions(["--project", "p", "--email", "not-email", "--name", "Owner Name"]), { code: "invalid-staff" });
  assert.deepEqual(script.parseOptions(base), { project: "client-vaxtrack", email: "owner@client.ph", name: "Owner Name", apply: false });
  assert.equal(script.parseOptions([...base, "--apply", "--confirm", "OWNER@client.ph"]).apply, true);
});
