// Persistence: one IndexedDB database so a reload, a locked phone, or a host
// crash does not lose the party.
//
//   kv       'session'      -> the current session record (mode, code, roster snapshot, pack title)
//            'clientId'     -> mirrored from localStorage for good measure
//   takes    `${session}|${lineId}` -> a Take with its Float32 samples
//   files    `${session}|${name}`   -> package files (host and solo), so the host can resume
//
// Only one session is kept at a time; starting a new one replaces it.

const DB_NAME = 'choicer-party';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('takes')) db.createObjectStore('takes');
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try { result = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  }));
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/* ---------------- identity ---------------- */

/**
 * Stable per-tab id: survives a reload of this tab (sessionStorage), so a
 * refreshed player keeps their part, but two tabs in one browser stay two
 * people (a host testing with a second tab, say). When a tab is gone for good,
 * the saved session record carries the id and `setClientId` restores it on
 * resume.
 */
const ID_KEY = 'choicer.clientId';
let cached = null;

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

export function clientId() {
  if (cached) return cached;
  let id = null;
  try { id = sessionStorage.getItem(ID_KEY); } catch { /* private mode */ }
  if (!id) {
    id = randomId();
    try { sessionStorage.setItem(ID_KEY, id); } catch { /* fine, in-memory then */ }
  }
  cached = id;
  return id;
}

export function setClientId(id) {
  if (!id) return clientId();
  cached = String(id);
  try { sessionStorage.setItem(ID_KEY, cached); } catch { /* ignore */ }
  return cached;
}

/* ---------------- session ---------------- */

// Session records are keyed by the client id that owns them, so two tabs in
// one browser (host + a test player) do not overwrite each other's record.
const MAX_AGE = 7 * 24 * 3600 * 1000;

async function allSessions() {
  const keys = await tx('kv', 'readonly', (s) => req(s.getAllKeys()));
  const vals = await tx('kv', 'readonly', (s) => req(s.getAll()));
  const out = [];
  keys.forEach((k, i) => { if (String(k).startsWith('session:') && vals[i]?.mode) out.push(vals[i]); });
  return out;
}

/** The session this tab should offer to resume: its own if it has one, else the most recent. */
export async function getSession(preferClientId = null) {
  try {
    const list = await allSessions();
    const fresh = list.filter((r) => Date.now() - (r.updatedAt || 0) < MAX_AGE);
    for (const stale of list.filter((r) => !fresh.includes(r))) clearSession(stale.key, stale.clientId);
    if (!fresh.length) return null;
    return fresh.find((r) => r.clientId === preferClientId) || fresh.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  } catch { return null; }
}

export async function putSession(record) {
  try { await tx('kv', 'readwrite', (s) => s.put({ ...record, updatedAt: Date.now() }, `session:${record.clientId || 'anon'}`)); } catch (e) { console.warn('session not saved', e); }
}

/** Forget one session: its record, takes and files. */
export async function clearSession(key, clientId = null) {
  try {
    if (clientId) await tx('kv', 'readwrite', (s) => s.delete(`session:${clientId}`));
    if (key) {
      for (const storeName of ['takes', 'files']) {
        const keys = await tx(storeName, 'readonly', (s) => req(s.getAllKeys()));
        const mine = keys.filter((k) => String(k).startsWith(`${key}|`));
        if (mine.length) await tx(storeName, 'readwrite', (s) => { for (const k of mine) s.delete(k); });
      }
    }
  } catch (e) { console.warn('session not cleared', e); }
}

export async function clearAll() {
  try {
    await tx('kv', 'readwrite', (s) => s.clear());
    await tx('takes', 'readwrite', (s) => s.clear());
    await tx('files', 'readwrite', (s) => s.clear());
  } catch (e) { console.warn('store not cleared', e); }
}

/* ---------------- takes ---------------- */

export async function putTake(session, lineId, take) {
  const rec = {
    lineId, samples: take.samples, sampleRate: take.sampleRate, offset: take.offset || 0, gain: take.gain ?? 1,
    by: take.by || '', byClientId: take.byClientId || '', lineDuration: take.lineDuration, tail: take.tail,
    recordedAt: take.recordedAt || Date.now(), remote: !!take.remote,
  };
  try { await tx('takes', 'readwrite', (s) => s.put(rec, `${session}|${lineId}`)); } catch (e) { console.warn('take not saved', e); }
}

export async function deleteTake(session, lineId) {
  try { await tx('takes', 'readwrite', (s) => s.delete(`${session}|${lineId}`)); } catch { /* ignore */ }
}

export async function getTakes(session) {
  try {
    const all = await tx('takes', 'readonly', (s) => req(s.getAll()));
    const keys = await tx('takes', 'readonly', (s) => req(s.getAllKeys()));
    const out = new Map();
    keys.forEach((k, i) => { if (String(k).startsWith(`${session}|`)) out.set(all[i].lineId, all[i]); });
    return out;
  } catch { return new Map(); }
}

/* ---------------- package files (host / solo) ---------------- */

export async function putFiles(session, files) {
  // files: [{ name, blob }]
  try {
    await tx('files', 'readwrite', (s) => { for (const f of files) s.put({ name: f.name, blob: f.blob }, `${session}|${f.name}`); });
  } catch (e) { console.warn('package not saved for resume', e); throw e; }
}

export async function getFiles(session) {
  try {
    const all = await tx('files', 'readonly', (s) => req(s.getAll()));
    const keys = await tx('files', 'readonly', (s) => req(s.getAllKeys()));
    const out = [];
    keys.forEach((k, i) => { if (String(k).startsWith(`${session}|`)) out.push(all[i]); });
    return out;
  } catch { return []; }
}

/** Rough size of what is stored, for the resume card. */
export async function estimate() {
  try {
    if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); return e.usage || 0; }
  } catch { /* ignore */ }
  return 0;
}
