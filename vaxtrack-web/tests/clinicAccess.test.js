import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  activeDoctorLinks,
  approvedMedReps,
  clinicReach,
  currentSelections,
  medRepReachesClinic,
  planClinicAccess,
  reachLabel,
  territoryWithClinic,
  territoryWithoutClinic,
} from "../src/services/clinicAccess.js";
import { MAX_ASSIGNED_CLINICS, isDestinationPermitted, readTerritory } from "../src/services/territory.js";

/**
 * "Who can order here" — clinic-side setup of Med Rep territory and doctor
 * delivery addresses. A clinic is orderable only with BOTH a Med Rep (clinic +
 * its area in territory) and a doctor (active delivery address).
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const clinic = { id: "clinicX", areaId: "areaA", locationVerified: true };
const rep = (id, areaIds = [], clinicIds = [], over = {}) => ({
  id, role: "salesrep", status: "approved", fullName: `Rep ${id}`, assignedAreaIds: areaIds, assignedClinicIds: clinicIds, ...over,
});
const doctor = (id, active = true) => ({ id, name: `Dr ${id}`, active });
const link = (clinicId, active = true) => ({ id: clinicId, destinationType: "clinic", active });

test("only approved Med Reps are offered, by name; the document id is the uid", () => {
  const users = [
    rep("b"), rep("a"), rep("p", [], [], { status: "pending" }), { id: "d", role: "dispatcher", status: "approved" },
    rep("x", [], [], { role: " SalesRep " }), { ...rep("s"), uid: "spoofed" },
  ];
  const reps = approvedMedReps(users);
  assert.deepEqual(reps.map((r) => r.uid), ["a", "b", "s", "x"]);
  assert.equal(reps.find((r) => r.id === "s").uid, "s", "a stored uid field never redirects the write");
});

test("ticking a Med Rep adds the clinic AND, when missing, its area — the same rule ordering enforces", () => {
  const without = rep("r1", ["areaB"], ["other"]);
  const next = territoryWithClinic(without, clinic);
  assert.deepEqual(next, { areaIds: ["areaB", "areaA"], clinicIds: ["other", "clinicX"] });
  const t = { ...readTerritory({ assignedAreaIds: next.areaIds, assignedClinicIds: next.clinicIds }) };
  assert.equal(isDestinationPermitted({ type: "clinic", areaId: "areaA", clinicDocId: "clinicX" }, t), true);
  // Area alone is not enough; clinic alone is not enough.
  assert.equal(medRepReachesClinic(rep("r", ["areaA"], []), clinic), false);
  assert.equal(medRepReachesClinic(rep("r", [], ["clinicX"]), clinic), false);
  assert.equal(medRepReachesClinic(rep("r", ["areaA"], ["clinicX"]), clinic), true);
});

test("unticking removes only the clinic; the area stays for their other clinics and home visits", () => {
  assert.deepEqual(territoryWithoutClinic(rep("r", ["areaA"], ["clinicX", "clinicY"]), clinic), {
    areaIds: ["areaA"], clinicIds: ["clinicY"],
  });
});

test("reach: orderable only with a Med Rep AND an active doctor link on an active doctor", () => {
  const reps = approvedMedReps([rep("r1", ["areaA"], ["clinicX"]), rep("r2", ["areaA"], [])]);
  const doctors = [doctor("d1"), doctor("d2", false), doctor("d3")];
  const links = activeDoctorLinks({ d1: [link("clinicX")], d2: [link("clinicX")], d3: [link("clinicX", false)] });
  const reach = clinicReach(clinic, reps, links, doctors);
  assert.deepEqual(reach, { medRepUids: ["r1"], doctorIds: ["d1"], orderable: true });
  assert.deepEqual(reachLabel(reach), { tone: "ok", text: "1 Med Rep · 1 doctor" });
  assert.deepEqual(reachLabel(clinicReach(clinic, reps, new Map(), doctors)), { tone: "warn", text: "Not orderable yet — no doctor linked" });
  assert.deepEqual(reachLabel(clinicReach(clinic, [], new Map(), doctors)), { tone: "warn", text: "Not orderable yet — no Med Rep or no doctor linked" });
});

test("the plan applies only the differences, and never newly links an inactive doctor", () => {
  const medReps = approvedMedReps([rep("keep", ["areaA"], ["clinicX"]), rep("add", ["areaB"], []), rep("drop", ["areaA"], ["clinicX"])]);
  const doctors = [doctor("dNew"), doctor("dOld"), doctor("dGone"), doctor("dOff", false), doctor("dStay")];
  const addressesByDoctor = { dOld: [link("clinicX", false)], dGone: [link("clinicX")], dStay: [link("clinicX")] };
  const plan = planClinicAccess({
    clinic, medReps, selectedRepUids: ["keep", "add"], doctors, addressesByDoctor,
    selectedDoctorIds: ["dNew", "dOld", "dOff", "dStay"],
  });
  assert.deepEqual(plan.repAdds.map((r) => [r.uid, r.addsArea]), [["add", true]]);
  assert.deepEqual(plan.repRemovals.map((r) => r.uid), ["drop"]);
  assert.deepEqual(plan.doctorLinks.map((d) => [d.doctorId, d.action]), [["dNew", "add"], ["dOld", "reactivate"]]);
  assert.deepEqual(plan.doctorUnlinks.map((d) => d.doctorId), ["dGone"]);
  assert.deepEqual(plan.blocked, []);
  assert.equal(plan.empty, false);
});

test("adding needs a verified pin and an area; removing never does; nothing changed is empty", () => {
  const medReps = approvedMedReps([rep("r", ["areaA"], ["clinicX"]), rep("n")]);
  const unpinned = { ...clinic, locationVerified: false };
  const adding = planClinicAccess({ clinic: unpinned, medReps, selectedRepUids: ["r", "n"], doctors: [], addressesByDoctor: {}, selectedDoctorIds: [] });
  assert.match(adding.blocked.join(" "), /verified location/);
  const removing = planClinicAccess({ clinic: unpinned, medReps, selectedRepUids: [], doctors: [], addressesByDoctor: {}, selectedDoctorIds: [] });
  assert.deepEqual(removing.blocked, []);
  assert.equal(removing.repRemovals.length, 1);
  const same = planClinicAccess({ clinic, medReps, selectedRepUids: ["r"], doctors: [], addressesByDoctor: {}, selectedDoctorIds: [] });
  assert.equal(same.empty, true);
});

test("removing a Med Rep warns about their open orders to this clinic (orders are never rewritten)", () => {
  const medReps = approvedMedReps([rep("r", ["areaA"], ["clinicX"])]);
  const orders = [
    { createdByUid: "r", status: "assigned", destinationType: "clinic", destinationAreaId: "areaA", clinicDocId: "clinicX" },
    { createdByUid: "r", status: "delivered", destinationType: "clinic", destinationAreaId: "areaA", clinicDocId: "clinicX" },
    { createdByUid: "other", status: "assigned", destinationType: "clinic", destinationAreaId: "areaA", clinicDocId: "clinicX" },
  ];
  const plan = planClinicAccess({ clinic, medReps, selectedRepUids: [], doctors: [], addressesByDoctor: {}, selectedDoctorIds: [], orders });
  assert.equal(plan.repRemovals[0].losingOrders.length, 1);
});

test("the clinic limit is respected before anything is written", () => {
  const full = rep("full", ["areaA"], Array.from({ length: MAX_ASSIGNED_CLINICS }, (_, i) => `c${i}`));
  const plan = planClinicAccess({ clinic, medReps: approvedMedReps([full]), selectedRepUids: ["full"], doctors: [], addressesByDoctor: {}, selectedDoctorIds: [] });
  assert.match(plan.blocked.join(" "), /maximum of 200 clinics/);
});

test("the dialog starts from who reaches the clinic now, including an inactive doctor still linked", () => {
  const medReps = approvedMedReps([rep("r", ["areaA"], ["clinicX"]), rep("n", ["areaA"], [])]);
  const doctors = [doctor("d1"), doctor("off", false)];
  const sel = currentSelections(clinic, medReps, { d1: [link("clinicX")], off: [link("clinicX")] }, doctors);
  assert.deepEqual(sel, { repUids: ["r"], doctorIds: ["d1", "off"] });
});

test("wiring: writes only through the existing transactional services; the page shows reach and offers Manage access", () => {
  const svc = read("src/services/clinicAccessService.js");
  assert.match(svc, /import \{ updateMedRepTerritory \} from "\.\/userService";/);
  assert.match(svc, /import \{ addDoctorAddress, setDoctorAddressActive \} from "\.\/doctorAddressService";/);
  assert.equal(/\b(setDoc|updateDoc|addDoc|writeBatch|runTransaction)\(|firebase\/firestore/.test(svc), false, "no direct Firestore writes");
  const pure = read("src/services/clinicAccess.js");
  assert.equal(/firebase/.test(pure), false);
  const page = read("src/pages/admin/Clinics.jsx");
  assert.match(page, /<ReachChip reach=\{reachOf\(clinic\)\} \/>/);
  assert.match(page, /onClick=\{\(e\) => openManageAccess\(clinic, e\.currentTarget\)\}/);
  assert.match(page, /<ManageAccessModal/);
  // Registration links only after the clinic exists, and only with a pin; a failed link never undoes it.
  assert.match(page, /const clinicRef = await addClinic\(\{/);
  assert.match(page, /if \(wantsLinks && pinned && clinicRef\?\.id\) \{[\s\S]*results = await applyClinicAccess\(clinicRef\.id, plan\);/);
  assert.match(page, /has been registered, but \$\{failed\.length\} link/);
  assert.match(read("src/pages/admin/ClinicAccess.jsx"), /A clinic appears for ordering only when a Med Rep and a doctor are both linked to it\./);
});
