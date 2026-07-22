// storage.mjs — req-local-first-sink: the local store is the sink of record;
// pushing stored bundles to a remote intake is a separate, explicit sync
// action through the existing httpSink contract (bundle receipt first, then
// per-item sidecars — sinks.mjs semantics unchanged). The backend interface
// is tiny so tests use memory and the extension shell plugs in IndexedDB.

/** Backend contract: async get/put/delete/list over structured values. */
export function memoryBackend() {
  const map = new Map();
  return {
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : undefined; },
    async put(key, value) { map.set(key, structuredClone(value)); },
    async delete(key) { map.delete(key); },
    async list() { return [...map.keys()]; },
  };
}

export function createBundleStore(backend) {
  if (!backend) throw new TypeError("store: backend is required");
  return {
    async saveBundle(bundle) {
      const key = bundle.idempotencyKey;
      if (!key) throw new TypeError("store: bundle needs an idempotencyKey");
      const existing = (await backend.get(key)) ?? { sidecars: [] };
      await backend.put(key, { ...existing, bundle });
      return { ref: key };
    },
    async saveSidecar(bundle, item) {
      const key = bundle.idempotencyKey;
      const record = await backend.get(key);
      if (!record?.bundle) throw new Error("store: bundle must be saved before sidecars");
      const sidecars = (record.sidecars ?? []).filter((sidecar) => sidecar.digest !== item.digest);
      sidecars.push({ digest: item.digest, ...(item.contentType === undefined ? {} : { contentType: item.contentType }), ...(item.transport === undefined ? {} : { transport: item.transport }), size: item.size, payload: item.payload });
      await backend.put(key, { ...record, sidecars });
      return { digest: item.digest, status: "uploaded" };
    },
    async get(key) { return backend.get(key); },
    async list() { const keys = await backend.list(); return Promise.all(keys.map((key) => backend.get(key))); },
    async delete(key) { return backend.delete(key); },
    async markSynced(key, sync) {
      const record = await backend.get(key);
      if (!record) throw new Error(`store: unknown bundle ${key}`);
      await backend.put(key, { ...record, synced: sync });
    },
  };
}

/** The router-facing local sink of record. */
export function extensionLocalSink(store) {
  return {
    id: "ext-local",
    async submit(bundle) { return store.saveBundle(bundle); },
    async uploadEvidence(bundle, item) { return store.saveSidecar(bundle, item); },
  };
}

/**
 * Explicit push of stored bundles through a remote sink (httpSink against a
 * configured intake). Bundle-first per record; a record only marks synced
 * when its bundle and every stored sidecar landed, so partial failures retry.
 */
export async function syncToIntake(store, sink) {
  const results = [];
  for (const record of await store.list()) {
    if (!record?.bundle) continue;
    const key = record.bundle.idempotencyKey;
    if (record.synced) { results.push({ key, status: "already-synced", ref: record.synced.ref }); continue; }
    try {
      const receipt = await sink.submit(record.bundle);
      const evidence = [];
      for (const sidecar of record.sidecars ?? []) {
        try { evidence.push(await sink.uploadEvidence(record.bundle, sidecar)); }
        catch (error) { evidence.push({ digest: sidecar.digest, status: "failed", evidenceError: error?.message ?? String(error) }); }
      }
      const failed = evidence.filter((result) => result.status === "failed");
      if (!failed.length) await store.markSynced(key, { ref: receipt.ref, sink: sink.id });
      results.push({ key, status: failed.length ? "partial" : "synced", ref: receipt.ref, evidence });
    } catch (error) {
      results.push({ key, status: "failed", error: error?.message ?? String(error) });
    }
  }
  return results;
}
