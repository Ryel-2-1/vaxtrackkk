const assert = require("node:assert/strict");
const test = require("node:test");
const { getStaffEmailVerification } = require("../src/staffAccounts");

function profileDb(role, status) {
  return {
    collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ role, status }) }) }) }),
  };
}

test("approved admins get verification and last sign-in for existing Auth accounts only", async () => {
  const lastSignInTime = "Wed, 25 Nov 2026 12:58:00 GMT";
  const authAdmin = {
    async getUsers(identifiers) {
      assert.deepEqual(identifiers, [{ uid: "verified" }, { uid: "unverified" }, { uid: "missing" }]);
      return {
        users: [
          { uid: "unverified", emailVerified: false, email: "example@example.com" },
          { uid: "verified", emailVerified: true, metadata: { lastSignInTime } },
        ],
        notFound: [{ uid: "missing" }],
      };
    },
  };

  const result = await getStaffEmailVerification({
    db: profileDb("admin", "approved"), authAdmin, uid: "admin",
    payload: { uids: ["verified", "unverified", "missing", "verified"] },
  });
  assert.deepEqual(result.accounts, [
    { uid: "unverified", emailVerified: false, lastSignInMs: null },
    { uid: "verified", emailVerified: true, lastSignInMs: Date.parse(lastSignInTime) },
  ]);
});

test("unauthorized and oversized requests stop before the Auth lookup", async () => {
  const uid = "caller";
  const authAdmin = { getUsers: () => assert.fail("Unexpected Auth lookup") };
  const payload = { uids: ["applicant"] };

  await assert.rejects(getStaffEmailVerification({ db: profileDb("dispatcher", "approved"), authAdmin, uid, payload }),
    { code: "wrong-role" });
  await assert.rejects(getStaffEmailVerification({ db: profileDb("admin", "disabled"), authAdmin, uid, payload }),
    { code: "not-approved" });
  await assert.rejects(getStaffEmailVerification({
    db: profileDb("admin", "approved"), authAdmin, uid, payload: { uids: Array(11).fill("applicant") },
  }), { code: "invalid-payload" });
});
