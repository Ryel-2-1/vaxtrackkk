import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  capReadIds,
  loadReadIds,
  MAX_READ_IDS,
  saveReadIds,
  unsyncedReadIds,
  withReadIds,
} from "../src/services/notificationReadState.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path) => readFileSync(join(here, "..", path), "utf8");

test("notification read choices survive refresh and stay private to each role, user, and project", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const read = withReadIds([], ["alert-1", "alert-2", "alert-1"]);
  assert.deepEqual(read, ["alert-1", "alert-2"]);
  saveReadIds("staging", "dispatcher", "user-a", read, storage);
  assert.deepEqual(loadReadIds("staging", "dispatcher", "user-a", storage), read);
  assert.deepEqual(loadReadIds("production", "dispatcher", "user-a", storage), []);
  assert.deepEqual(loadReadIds("staging", "dispatcher", "user-b", storage), []);
  assert.deepEqual(loadReadIds("staging", "salesrep", "user-a", storage), []);
  values.set([...values.keys()][0], "not json");
  assert.deepEqual(loadReadIds("staging", "dispatcher", "user-a", storage), []);
});

test("Med Rep bell uses the same live order alerts as the page; Dispatcher keeps personal read state", () => {
  const shell = source("src/pages/salesRep/SalesRepShell.jsx");
  const page = source("src/pages/salesRep/SalesRepAlerts.jsx");
  const dispatcher = source("src/pages/dispatcher/DispatcherLayout.jsx");
  assert.match(shell, /subscribeSalesRepOrders\(uid,/);
  assert.match(shell, /orders\.map\(deriveSalesRepOrderAlert\)/);
  assert.match(page, /raw\.map\(deriveSalesRepOrderAlert\)/);
  assert.match(shell, /navigate\(`\/sales-rep\/alerts\?tab=/);
  assert.match(page, /linkedParams\.get\("reference"\)/);
  assert.doesNotMatch(shell, /const notifications = \[\]/);
  // Both bells keep personal read state through the same synced hook.
  assert.match(dispatcher, /useNotificationReadState\("dispatcher"\)/);
  assert.match(shell, /useNotificationReadState\("salesrep"\)/);
  assert.doesNotMatch(dispatcher, /notification\.read \?/);
});

test("read state follows the user across devices: cached here, shared in Firestore, bounded", () => {
  const hook = source("src/components/useNotificationReadState.js");
  // Starts from this browser's cache, merges the shared copy as it arrives…
  assert.match(hook, /useState\(\(\) => loadReadIds\(projectId, role, uid\)\)/);
  assert.match(hook, /subscribeReadIds\(\s*uid,/);
  assert.match(hook, /setReadIds\(\(current\) => withReadIds\(current, ids\)\)/);
  // …and writes back only what the shared copy lacks, after a short settle.
  assert.match(hook, /if \(remote === null \|\| unsyncedReadIds\(readIds, remote\)\.length === 0\) return undefined;/);
  assert.match(hook, /saveReadIdsRemote\(uid, readIds\)/);
  const store = source("src/services/notificationReadStore.js");
  assert.match(store, /doc\(db, "notificationReadStates", uid\)/);
  assert.match(store, /setDoc\(readStateRef\(uid\), \{ ids: capReadIds\(ids\), updatedAt: serverTimestamp\(\) \}\)/);
  // Bounded to the most recent ids, matching the rule's limit.
  assert.equal(MAX_READ_IDS, 500);
  const many = Array.from({ length: 520 }, (_, i) => `n${i}`);
  assert.deepEqual(capReadIds(many), many.slice(-500));
  assert.equal(withReadIds(many.slice(0, 500), ["new"]).at(-1), "new");
  assert.deepEqual(unsyncedReadIds(["a", "b", "c"], ["a", "c"]), ["b"]);
  assert.match(source("firestore.rules"), /request\.resource\.data\.ids\.size\(\) <= 500/);
});

test("Admin Mark Read and the bell use the same read flag", () => {
  const page = source("src/pages/admin/Alerts.jsx");
  const bell = source("src/components/admin/AdminAlertsBell.jsx");
  assert.match(page, /const unreadAlerts = alerts\.filter\(\(alert\) => !alert\.read\);/);
  assert.match(page, /Promise\.allSettled\(unread\.map\(\(a\) => markAlertRead\(a\.id\)\)\)/);
  assert.match(page, /disabled=\{markingAll \|\| loading \|\| Boolean\(loadError\) \|\| unreadAlerts\.length === 0\}/);
  assert.match(bell, /rows\.filter\(\(alert\) => alert\.read !== true\)\.length/);
  assert.doesNotMatch(bell, /subscribeDeliveryExceptions/);
});
