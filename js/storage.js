'use strict';

const DB_NAME = 'horizon-survey';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('This browser has no IndexedDB, so sessions cannot be saved.')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('keyframes')) {
        const s = db.createObjectStore('keyframes', { keyPath: ['sessionId', 'index'] });
        s.createIndex('bySession', 'sessionId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, stores, mode) {
  return db.transaction(stores, mode);
}

function wrap(request) {
  return new Promise((res, rej) => {
    request.onsuccess = () => res(request.result);
    request.onerror = () => rej(request.error);
  });
}

export async function saveSession(record) {
  const db = await open();
  const t = tx(db, ['sessions'], 'readwrite');
  await wrap(t.objectStore('sessions').put(record));
  return new Promise(res => { t.oncomplete = () => res(true); });
}

export async function loadSession(id) {
  const db = await open();
  return wrap(tx(db, ['sessions'], 'readonly').objectStore('sessions').get(id));
}

export async function listSessions() {
  const db = await open();
  const all = await wrap(tx(db, ['sessions'], 'readonly').objectStore('sessions').getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteSession(id) {
  const db = await open();
  const t = tx(db, ['sessions', 'keyframes'], 'readwrite');
  t.objectStore('sessions').delete(id);
  const idx = t.objectStore('keyframes').index('bySession');
  const cursorReq = idx.openCursor(IDBKeyRange.only(id));
  cursorReq.onsuccess = () => {
    const c = cursorReq.result;
    if (c) { c.delete(); c.continue(); }
  };
  return new Promise(res => { t.oncomplete = () => res(true); });
}

export async function putKeyframeThumb(sessionId, index, blob) {
  const db = await open();
  const t = tx(db, ['keyframes'], 'readwrite');
  t.objectStore('keyframes').put({ sessionId, index, blob });
  // Reject on failure instead of hanging. Resolving only on `oncomplete` meant
  // an aborted transaction never settled either way, so a browser that would
  // not store the blob produced no error, no thumbnails, and no explanation —
  // which is exactly what an iPad did on 2026-08-15.
  return new Promise((res, rej) => {
    t.oncomplete = () => res(true);
    t.onerror = () => rej(t.error || new Error('keyframe store failed'));
    t.onabort = () => rej(t.error || new Error('keyframe store aborted'));
  });
}

export async function getKeyframeThumbs(sessionId) {
  const db = await open();
  const idx = tx(db, ['keyframes'], 'readonly').objectStore('keyframes').index('bySession');
  const all = await wrap(idx.getAll(IDBKeyRange.only(sessionId)));
  return all.sort((a, b) => a.index - b.index);
}

export async function estimateUsage() {
  if (navigator.storage && navigator.storage.estimate) {
    const e = await navigator.storage.estimate();
    return { usage: e.usage || 0, quota: e.quota || 0 };
  }
  return null;
}

export async function requestPersistence() {
  if (navigator.storage && navigator.storage.persist) {
    try { return await navigator.storage.persist(); } catch (_) { return false; }
  }
  return false;
}
