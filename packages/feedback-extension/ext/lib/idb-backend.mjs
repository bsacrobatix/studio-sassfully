// IndexedDB implementation of storage.mjs's backend contract. Sidecar
// payloads run to megabytes, past chrome.storage.local's comfort zone; IDB
// stores structured values natively. Shared by the background worker
// (draft stash) and extension pages (bundle store).
const DB_NAME = "sassfully-ext";
const STORES = ["records", "drafts"];

export function idbBackend({ store = "records" } = {}) {
  if (!STORES.includes(store)) throw new TypeError(`idb: unknown store ${store}`);
  const open = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { for (const name of STORES) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const run = async (mode, operation) => {
    const database = await open();
    try {
      return await new Promise((resolve, reject) => {
        const request = operation(database.transaction(store, mode).objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
  };
  return {
    get: (key) => run("readonly", (os) => os.get(key)),
    put: (key, value) => run("readwrite", (os) => os.put(value, key)),
    delete: (key) => run("readwrite", (os) => os.delete(key)),
    list: () => run("readonly", (os) => os.getAllKeys()),
  };
}
