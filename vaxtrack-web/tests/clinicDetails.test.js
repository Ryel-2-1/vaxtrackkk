import test from "node:test";
import assert from "node:assert/strict";
import { clinicDetailsDraft, clinicDetailsPatch, limitClinicPhone } from "../src/services/clinicDetails.js";

test("editing an older record saves only changed details", () => {
  const stored = clinicDetailsDraft({
    name: "Corner Clinic",
    phone: "+63 917 000 0000",
    latitude: 14.2,
    locationVerified: true,
  });
  assert.equal(stored.location, "");
  assert.equal(stored.areaId, "");
  const result = clinicDetailsPatch({
    ...stored,
    deliveryNotes: "  Ask for the receiving desk. ",
    latitude: 0,
    locationVerified: false,
  }, stored);
  assert.deepEqual(result, {
    patch: { deliveryNotes: "Ask for the receiving desk." },
    errors: {},
  });
});

test("new edit values are validated and normalized before saving", () => {
  const stored = clinicDetailsDraft({ email: "old@example.test" });
  const result = clinicDetailsPatch({
    ...stored,
    clinicId: " aac-030 ",
    contact: "Dr.   Maria Santos",
    phone: limitClinicPhone("0917-123-4567abc8"),
    email: "",
    areaId: "area-central",
    status: "pending",
  }, stored);
  assert.deepEqual(result, {
    patch: {
      clinicId: "AAC-030",
      contact: "Dr. Maria Santos",
      phone: "09171234567",
      email: "",
      areaId: "area-central",
      status: "pending",
    },
    errors: {},
  });
});

test("a submitted details edit rejects invalid fields and preserves the validation messages", () => {
  const stored = clinicDetailsDraft({
    name: "Corner Clinic",
    location: "1 Sample St.",
  });
  const { patch, errors } = clinicDetailsPatch({
    ...stored,
    name: " ",
    clinicId: "a--b",
    contact: "--",
    phone: "091712345678",
    email: "missing-domain@",
    location: " ",
    areaId: "another/path",
    status: "__proto__",
  }, stored);
  assert.deepEqual(patch, {});
  assert.deepEqual(Object.keys(errors).sort(), ["areaId", "clinicId", "contact", "email", "location", "name", "phone", "status"]);
});
