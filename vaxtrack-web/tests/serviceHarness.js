// Executes the REAL service modules against an in-memory Firestore stand-in.
//
// Every file in src/services is copied to a temp directory with only its two
// unresolvable import specifiers rewritten — `firebase/firestore` (the network
// SDK) and `../firebase` (which would initialise a real app from Vite-only
// `import.meta.env` vars). Sibling imports like `./deliveryService` keep
// working because the whole directory is copied together, so the code under
// test is the shipped code, not a transcription of it.
//
// The store models optimistic concurrency the way Firestore does: every
// document carries a version, a transaction records the versions it read, and
// a commit whose read set changed is retried. That is what makes the assignment
// race genuinely testable rather than asserted.
//
// No network, no emulator, no dependency.

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const servicesDir = join(here, "..", "src", "services");

/** Fresh in-memory store. Collections are plain maps of id -> {data, version}. */
export function createStore(seed = {}) {
  const store = { collections: {}, writes: [], transactionAttempts: 0 };
  for (const [name, docs] of Object.entries(seed)) {
    store.collections[name] = {};
    for (const [id, data] of Object.entries(docs)) {
      store.collections[name][id] = { data: { ...data }, version: 1 };
    }
  }
  return store;
}

export const SERVER_TIMESTAMP = "__SERVER_TIMESTAMP__";

function buildFirestoreStandIn() {
  return `
const S = () => globalThis.__vaxStore;
const A = () => globalThis.__vaxAuth;

const col = (name) => { const s = S(); if (!s.collections[name]) s.collections[name] = {}; return s.collections[name]; };
const snapOf = (name, id) => {
  const rec = col(name)[id];
  return {
    id,
    exists: () => !!rec,
    data: () => (rec ? { ...rec.data } : undefined),
    ref: { __col: name, __id: id },
  };
};

export const collection = (_db, name) => ({ __col: name, __isQuery: false });
export const doc = (_db, name, id) => ({ __col: name, __id: id });
export const query = (ref, ...clauses) => ({ ...ref, __isQuery: true, __clauses: clauses });
export const where = (field, op, value) => ({ __t: 'where', field, op, value });
export const orderBy = (...a) => ({ __t: 'orderBy', a });
export const serverTimestamp = () => "${SERVER_TIMESTAMP}";
export const GeoPoint = class { constructor(lat, lng) { this.latitude = lat; this.longitude = lng; } };

const matches = (data, clauses = []) => clauses
  .filter((c) => c && c.__t === 'where')
  .every((c) => (c.op === '==' ? data[c.field] === c.value : true));

const docsFor = (ref) => Object.entries(col(ref.__col))
  .filter(([, rec]) => matches(rec.data, ref.__clauses))
  .map(([id, rec]) => ({ id, data: () => ({ ...rec.data }), exists: () => true }));

export const getDoc = async (ref) => snapOf(ref.__col, ref.__id);
export const getDocs = async (ref) => { const docs = docsFor(ref); return { docs, empty: docs.length === 0, size: docs.length }; };

export const onSnapshot = (ref, next, _err) => {
  const cb = typeof next === 'function' ? next : next.next;
  const docs = docsFor(ref);
  cb({ docs, empty: docs.length === 0, metadata: { isFromCache: false, hasPendingWrites: false } });
  return () => {};
};

export const updateDoc = async (ref, data) => {
  const c = col(ref.__col); const rec = c[ref.__id];
  if (!rec) throw new Error('No document to update: ' + ref.__col + '/' + ref.__id);
  rec.data = { ...rec.data, ...data }; rec.version += 1;
  S().writes.push({ op: 'update', col: ref.__col, id: ref.__id, data });
};

export const addDoc = async (ref, data) => {
  const id = 'generated-' + (Object.keys(col(ref.__col)).length + 1);
  col(ref.__col)[id] = { data: { ...data }, version: 1 };
  S().writes.push({ op: 'add', col: ref.__col, id, data });
  return { id };
};

export const setDoc = async (ref, data) => {
  col(ref.__col)[ref.__id] = { data: { ...data }, version: 1 };
  S().writes.push({ op: 'set', col: ref.__col, id: ref.__id, data });
};

export const writeBatch = () => {
  const staged = [];
  return {
    update: (ref, data) => staged.push({ ref, data }),
    commit: async () => { for (const w of staged) await updateDoc(w.ref, w.data); },
  };
};

// Optimistic concurrency, as Firestore does it: the versions read during the
// attempt are recorded, and if any changed before commit the whole callback is
// re-run against fresh data.
export const runTransaction = async (_db, fn, opts = {}) => {
  const maxAttempts = opts.maxAttempts || 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    S().transactionAttempts += 1;
    const readVersions = [];
    const staged = [];
    const tx = {
      get: async (ref) => {
        const rec = col(ref.__col)[ref.__id];
        readVersions.push({ ref, version: rec ? rec.version : 0 });
        return snapOf(ref.__col, ref.__id);
      },
      update: (ref, data) => staged.push({ op: 'update', ref, data }),
      set: (ref, data) => staged.push({ op: 'set', ref, data }),
    };

    // A domain rejection must propagate immediately, never be retried.
    const result = await fn(tx);

    // Hook used by the race test to inject a competing committed write between
    // this attempt's reads and its commit.
    if (globalThis.__vaxBeforeCommit) {
      const hook = globalThis.__vaxBeforeCommit;
      globalThis.__vaxBeforeCommit = null;
      await hook();
    }

    const stale = readVersions.some(({ ref, version }) => {
      const rec = col(ref.__col)[ref.__id];
      return (rec ? rec.version : 0) !== version;
    });
    if (stale) continue; // retry with fresh reads

    for (const w of staged) {
      if (w.op === 'update') await updateDoc(w.ref, w.data);
      else await setDoc(w.ref, w.data);
    }
    return result;
  }
  throw new Error('Transaction failed after maximum attempts');
};
`;
}

/**
 * Copy src/services into a temp dir with the firebase specifiers redirected,
 * and return a loader for any service module by file name.
 */
export function createServiceLoader() {
  const tmp = mkdtempSync(join(tmpdir(), "vaxtrack-services-"));

  writeFileSync(join(tmp, "__firestore.mjs"), buildFirestoreStandIn());
  writeFileSync(
    join(tmp, "__firebase.mjs"),
    `export const db = { __mockDb: true };
export const auth = { get currentUser() { return globalThis.__vaxAuth ?? null; } };
`
  );

  const files = readdirSync(servicesDir).filter((f) => f.endsWith(".js"));
  let rewrittenCount = 0;
  for (const file of files) {
    const original = readFileSync(join(servicesDir, file), "utf8");
    const rewritten = original
      .replaceAll('"firebase/firestore"', '"./__firestore.mjs"')
      .replaceAll('"../firebase"', '"./__firebase.mjs"')
      // Sibling imports are written extensionless (`./orderLocation`), which
      // Vite resolves and bare Node does not. Adding the extension keeps the
      // real inter-service wiring intact inside the temp directory.
      .replace(/from "\.\/([A-Za-z0-9_-]+)"/g, 'from "./$1.js"');
    if (rewritten !== original) rewrittenCount += 1;
    writeFileSync(join(tmp, file), rewritten);
  }
  if (rewrittenCount === 0) {
    throw new Error("No service import was redirected — the harness is not testing the real modules.");
  }

  return {
    dir: tmp,
    /** Import a service by file name, e.g. "orderService.js". */
    load: (fileName) => import(pathToFileURL(join(tmp, fileName)).href),
  };
}

/** Install a store (and optional signed-in user) for the modules to see. */
export function installStore(store, authUser = null) {
  globalThis.__vaxStore = store;
  globalThis.__vaxAuth = authUser;
  globalThis.__vaxBeforeCommit = null;
  return store;
}

/** Schedule a competing committed write inside the next transaction attempt. */
export function injectCompetingWrite(fn) {
  globalThis.__vaxBeforeCommit = fn;
}
