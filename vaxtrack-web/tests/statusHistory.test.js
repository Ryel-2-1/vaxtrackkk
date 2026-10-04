import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// The web side of the order status history: it only ever READS events, and it
// says plainly when an order has none.

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(js|jsx)$/.test(name) ? [full] : [];
  });
}

test("the history service is a read-only, oldest-first subscription", () => {
  const svc = read("src/services/statusEventService.js");
  assert.match(svc, /collection\(db, "orders", orderId, "statusEvents"\), orderBy\("at", "asc"\)/);
  for (const w of ["setDoc", "updateDoc", "addDoc", "deleteDoc", "writeBatch", "runTransaction"]) {
    assert.equal(svc.includes(w), false, `must not use ${w}`);
  }
});

test("no web code writes a status event or firstDispatchedAt", () => {
  const root = new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  for (const file of sourceFiles(root)) {
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (/statusEvents/.test(code)) {
      assert.match(file.replace(/\\/g, "/"), /src\/services\/statusEventService\.js$/, `${file} must not touch statusEvents`);
    }
    if (/firstDispatchedAt/.test(code)) {
      // Read-only: the metrics module computes from it, and Analytics names it
      // in the modal that explains the figure. Nothing writes it.
      assert.match(
        file.replace(/\\/g, "/"),
        /src\/(services\/deliveryMetrics\.js|pages\/admin\/Analytics\.jsx)$/,
        `${file} must not touch firstDispatchedAt`
      );
      assert.equal(/\b(setDoc|updateDoc|addDoc)\b/.test(code), false, `${file} must not write orders`);
    }
  }
});

test("the Deliveries drawer shows the history, and is honest when there is none", () => {
  const page = read("src/pages/admin/Deliveries.jsx");
  assert.match(page, /<h3>Status history<\/h3>/);
  assert.match(page, /subscribeOrderStatusEvents\(\s*delivery\.uid,/);
  assert.match(page, /earlier ones were not\s*\n?\s*recorded and are not reconstructed/);
  assert.match(page, /Status history could not be loaded\./);
});
