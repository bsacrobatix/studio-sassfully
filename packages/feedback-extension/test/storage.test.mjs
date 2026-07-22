import test from "node:test";
import assert from "node:assert/strict";
import { memoryBackend, createBundleStore, extensionLocalSink, syncToIntake } from "../src/storage.mjs";
import { exportBundles, exportStore } from "../src/export.mjs";

const bundle = (key) => ({ reviewed: true, kind: "bug", idempotencyKey: key, anchor: { producer: "sassfully-ext", artifactId: "a" }, userText: "t", evidence: [] });
const sidecar = (digest) => ({ digest, contentType: "application/json", transport: "sidecar-json", size: 2, payload: { d: digest } });

test("store: bundle before sidecar, sidecar dedupe by digest, markSynced", async () => {
  const store = createBundleStore(memoryBackend());
  await assert.rejects(() => store.saveSidecar(bundle("fb-1"), sidecar("d1")), /bundle must be saved/);
  await store.saveBundle(bundle("fb-1"));
  await store.saveSidecar(bundle("fb-1"), sidecar("d1"));
  await store.saveSidecar(bundle("fb-1"), sidecar("d1"));
  const record = await store.get("fb-1");
  assert.equal(record.sidecars.length, 1);
  await store.markSynced("fb-1", { ref: "fb-1", sink: "http" });
  assert.equal((await store.get("fb-1")).synced.ref, "fb-1");
  await assert.rejects(() => store.markSynced("fb-2", {}), /unknown bundle/);
});

test("sync: bundle failure and partial sidecar failure both leave the record retryable", async () => {
  const store = createBundleStore(memoryBackend());
  await store.saveBundle(bundle("fb-1"));
  await store.saveSidecar(bundle("fb-1"), sidecar("d1"));
  const flaky = {
    id: "http", submits: 0,
    async submit(b) { if (++this.submits === 1) throw new Error("503"); return { ref: b.idempotencyKey }; },
    uploads: 0,
    async uploadEvidence(_b, item) { if (++this.uploads === 1) throw new Error("evidence 500"); return { digest: item.digest, status: "uploaded" }; },
  };
  assert.deepEqual((await syncToIntake(store, flaky)).map((r) => r.status), ["failed"]);
  assert.deepEqual((await syncToIntake(store, flaky)).map((r) => r.status), ["partial"]);
  assert.equal((await store.get("fb-1")).synced, undefined);
  assert.deepEqual((await syncToIntake(store, flaky)).map((r) => r.status), ["synced"]);
  assert.equal((await store.get("fb-1")).synced.ref, "fb-1");
});

test("local sink writes through to the store", async () => {
  const store = createBundleStore(memoryBackend());
  const sink = extensionLocalSink(store);
  const receipt = await sink.submit(bundle("fb-9"));
  assert.equal(receipt.ref, "fb-9");
  await sink.uploadEvidence(bundle("fb-9"), sidecar("d9"));
  assert.equal((await store.get("fb-9")).sidecars[0].digest, "d9");
});

test("export: intake-shaped JSONL plus evidence/<key>/<digest>.json files", async () => {
  const store = createBundleStore(memoryBackend());
  await store.saveBundle(bundle("fb-1"));
  await store.saveSidecar(bundle("fb-1"), sidecar("d1"));
  await store.saveBundle(bundle("fb-2"));
  const out = await exportStore(store);
  const lines = out.jsonl.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((l) => l.idempotencyKey).sort(), ["fb-1", "fb-2"]);
  assert.deepEqual(out.sidecarFiles, [{ name: "evidence/fb-1/d1.json", body: JSON.stringify({ d: "d1" }) }]);
  assert.deepEqual(exportBundles([]), { jsonl: "", sidecarFiles: [] });
});
