import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initialsOf, profilePhotoUrlOf } from "../src/services/profileModel.js";

// Rider avatars (2026-11-15): the Rider app's profile photo when there is one,
// otherwise up to three initials — the same rule staff avatars use.

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const URL_ = "https://firebasestorage.googleapis.com/v0/b/x/o/profile_photos%2Fr1%2Fphoto.jpg?alt=media&token=t";

test("rider initials follow the staff rule: up to three letters", () => {
  assert.equal(initialsOf("Juan Dela Cruz"), "JDC");
  assert.equal(initialsOf("Maria Clara Santos Reyes"), "MCR");
  assert.equal(initialsOf("QA Rider"), "QR");
  assert.equal(initialsOf("rider"), "R");
  assert.equal(initialsOf(""), "?");
});

test("only an https photo URL is shown, versioned by its update time", () => {
  assert.equal(profilePhotoUrlOf({ photoUrl: URL_ }), URL_);
  assert.equal(profilePhotoUrlOf({ photoUrl: URL_, photoUpdatedAt: { toMillis: () => 123 } }), `${URL_}&v=123`);
  assert.equal(profilePhotoUrlOf({ photoUrl: "https://x/p.jpg", photoUpdatedAt: 5 }), "https://x/p.jpg?v=5");
  for (const bad of [undefined, null, "", "http://x/p.jpg", "javascript:alert(1)", "data:image/png;base64,AA", "https://x y", 42]) {
    assert.equal(profilePhotoUrlOf({ photoUrl: bad }), null, String(bad));
  }
  assert.equal(profilePhotoUrlOf(null), null);
});

test("RiderAvatar shows the photo, else initialsOf, and falls back if the photo fails", () => {
  const src = read("src/components/ui/RiderAvatar.jsx");
  assert.match(src, /import \{ initialsOf \} from "..\/..\/services\/profileModel";/);
  assert.match(src, /onError=\{\(\) => setFailedUrl\(photoUrl\)\}/);
  assert.match(src, /initialsOf\(name\)/);
  assert.match(src, /aria-hidden="true"/, "decorative: the rider's name is always shown beside it");
});

test("every rider avatar on Admin and Dispatcher pages uses RiderAvatar", () => {
  const pages = {
    "src/pages/admin/Riders.jsx": 2,
    "src/pages/admin/Deliveries.jsx": 2,
    "src/pages/dispatcher/DispatcherAssignRider.jsx": 1,
    "src/pages/dispatcher/DispatcherCargoLoading.jsx": 2,
  };
  for (const [page, count] of Object.entries(pages)) {
    const src = read(page);
    assert.equal((src.match(/<RiderAvatar /g) ?? []).length, count, page);
    assert.equal(/\.slice\(0, 2\)/.test(src), false, `${page}: no two-letter initials left`);
    assert.match(src, /profilePhotoUrlOf/, page);
  }
});
