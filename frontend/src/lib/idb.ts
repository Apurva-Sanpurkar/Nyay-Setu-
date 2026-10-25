import type { JournalStore } from "@nyaysetu/integrity";

/**
 * A minimal IndexedDB key-value store. Used for two things that must survive a
 * reload: the recording journal (F12) and this browser's device signing key
 * (F10). CryptoKey objects are structured-cloneable, so a non-extractable key
 * can be kept here without its private half ever being readable by script.
 */

const DB_NAME = "nyaysetu";
const STORE = "kv";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB is not available in this browser."));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export const idb = {
  get: <T = unknown>(key: string) => withStore<T | undefined>("readonly", (s) => s.get(key) as IDBRequest<T | undefined>),
  put: (key: string, value: unknown) => withStore("readwrite", (s) => s.put(value, key)),
  delete: (key: string) => withStore("readwrite", (s) => s.delete(key)),
  keys: () => withStore<IDBValidKey[]>("readonly", (s) => s.getAllKeys()),
};

/** The recording journal's storage, in IndexedDB. */
export const idbJournalStore: JournalStore = {
  async get(key) {
    const value = await idb.get<Uint8Array | string>(key);
    return value ?? null;
  },
  async put(key, value) {
    await idb.put(key, value);
  },
  async delete(key) {
    await idb.delete(key);
  },
  async keys(prefix) {
    return (await idb.keys()).map(String).filter((k) => k.startsWith(prefix)).sort();
  },
};
