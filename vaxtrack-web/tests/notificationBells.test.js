import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadReadIds,
  saveReadIds,
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
  assert.match(dispatcher, /loadReadIds\(projectId, "dispatcher", uid\)/);
  assert.match(dispatcher, /saveReadIds\(projectId, "dispatcher", uid, readNotifications\)/);
  assert.doesNotMatch(dispatcher, /notification\.read \?/);
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
