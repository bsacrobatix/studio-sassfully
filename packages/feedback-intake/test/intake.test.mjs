import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createIntakeServer } from "../index.mjs";

const bundle = (key = "fb-test") => ({ reviewed: true, kind: "content_comment", anchor: { producer: "host", artifactId: "artifact", label: "A label" }, userText: "Please improve this.", evidence: [], idempotencyKey: key });
async function start(options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "feedback-intake-"));
  const server = await createIntakeServer({ dataDir, ...options });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  return { dataDir, url: `http://127.0.0.1:${port}/api/feedback`, async close() { await new Promise((resolve) => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); } };
}
async function post(url, body, headers = { "content-type": "application/json" }) { return fetch(url, { method: "POST", headers, body }); }

test("accepts a reviewed bundle and writes a server-stamped JSONL line", async (t) => {
  const intake = await start(); t.after(() => intake.close());
  const response = await post(intake.url, JSON.stringify(bundle()));
  assert.equal(response.status, 201); assert.deepEqual(await response.json(), { ref: "fb-test" });
  const files = await readFile(path.join(intake.dataDir, `feedback-${new Date().toISOString().slice(0, 7)}.jsonl`), "utf8");
  assert.equal(JSON.parse(files).receivedAt !== undefined, true);
});
test("dedupes an idempotency key", async (t) => {
  const intake = await start(); t.after(() => intake.close());
  assert.equal((await post(intake.url, JSON.stringify(bundle("fb-dup")))).status, 201);
  const duplicate = await post(intake.url, JSON.stringify(bundle("fb-dup")));
  assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).deduped, undefined);
});
test("rejects oversized bodies", async (t) => {
  const intake = await start(); t.after(() => intake.close());
  const response = await post(intake.url, "x".repeat(32 * 1024 + 1));
  assert.equal(response.status, 413);
});
test("rate limits a source IP", async (t) => {
  const intake = await start({ rateLimits: { minuteLimit: 2, dayLimit: 100 } }); t.after(() => intake.close());
  assert.equal((await post(intake.url, JSON.stringify(bundle("fb-one")))).status, 201);
  assert.equal((await post(intake.url, JSON.stringify(bundle("fb-two")))).status, 201);
  assert.equal((await post(intake.url, JSON.stringify(bundle("fb-three")))).status, 429);
});
test("rejects malformed JSON", async (t) => {
  const intake = await start(); t.after(() => intake.close());
  const response = await post(intake.url, "{not JSON");
  assert.equal(response.status, 400);
});

test("evidence is bundle-first, validated, deduped, capped, and stored outside JSONL", async (t) => {
  const intake = await start(); t.after(() => intake.close());
  const evidenceUrl = intake.url.replace(/\/api\/feedback$/, "/api/feedback/evidence");
  const envelope = { $schema: "sassfully/feedback-sidecar-envelope/v1", version: 1, bundleFirst: true, idempotencyKey: "fb-sidecar", digest: "e63ce1834313a807", contentType: "application/json", size: 17, payload: { redacted: true } };
  assert.equal((await post(evidenceUrl, JSON.stringify(envelope))).status, 409);
  await post(intake.url, JSON.stringify(bundle("fb-sidecar")));
  assert.equal((await post(evidenceUrl, JSON.stringify(envelope))).status, 201);
  assert.equal((await post(evidenceUrl, JSON.stringify(envelope))).status, 200);
  assert.equal(await readFile(path.join(intake.dataDir, "evidence", "fb-sidecar", "e63ce1834313a807.json"), "utf8"), JSON.stringify({ redacted: true }));
  assert.equal((await post(evidenceUrl, JSON.stringify({ ...envelope, digest: "../../escape" }))).status, 422);
  assert.equal((await post(evidenceUrl, "x".repeat(2 * 1024 * 1024 + 1))).status, 413);
});

test("rejects a syntactically valid but non-canonical evidence digest without storing it", async (t) => {
  const intake = await start(); t.after(() => intake.close());
  const evidenceUrl = intake.url.replace(/\/api\/feedback$/, "/api/feedback/evidence");
  await post(intake.url, JSON.stringify(bundle("fb-digest-mismatch")));
  const response = await post(evidenceUrl, JSON.stringify({ $schema: "sassfully/feedback-sidecar-envelope/v1", version: 1, bundleFirst: true, idempotencyKey: "fb-digest-mismatch", digest: "0123456789abcdef", size: 17, payload: { redacted: true } }));
  assert.equal(response.status, 422);
  assert.deepEqual(await readdir(path.join(intake.dataDir, "evidence")).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error)), []);
});

test("concurrent bundle and evidence retries are atomic and deduped", async (t) => {
  const intake = await start({ rateLimits: { minuteLimit: 100, dayLimit: 100 } }); t.after(() => intake.close());
  const key = "fb-concurrent", evidenceUrl = intake.url.replace(/\/api\/feedback$/, "/api/feedback/evidence");
  const bundleResponses = await Promise.all(Array.from({ length: 8 }, () => post(intake.url, JSON.stringify(bundle(key)))));
  assert.deepEqual(bundleResponses.map((response) => response.status).sort(), [200, 200, 200, 200, 200, 200, 200, 201]);
  const ledger = await readFile(path.join(intake.dataDir, `feedback-${new Date().toISOString().slice(0, 7)}.jsonl`), "utf8");
  assert.equal(ledger.trim().split("\n").length, 1);
  const envelope = { $schema: "sassfully/feedback-sidecar-envelope/v1", version: 1, bundleFirst: true, idempotencyKey: key, digest: "e63ce1834313a807", contentType: "application/json", size: 17, payload: { redacted: true } };
  const evidenceResponses = await Promise.all(Array.from({ length: 8 }, () => post(evidenceUrl, JSON.stringify(envelope))));
  assert.deepEqual(evidenceResponses.map((response) => response.status).sort(), [200, 200, 200, 200, 200, 200, 200, 201]);
  assert.deepEqual(await readdir(path.join(intake.dataDir, "evidence", key)), ["e63ce1834313a807.json"]);
});

test("bundle lookup rebuilds from older monthly ledger for a sidecar retry", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "feedback-intake-rollover-"));
  const old = "2026-06"; await (await import("node:fs/promises")).writeFile(path.join(dataDir, `feedback-${old}.jsonl`), `${JSON.stringify(bundle("fb-old"))}\n`);
  const server = await createIntakeServer({ dataDir }); await new Promise((resolve) => server.listen(0, resolve)); t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const evidenceUrl = `http://127.0.0.1:${server.address().port}/api/feedback/evidence`;
  const response = await post(evidenceUrl, JSON.stringify({ $schema: "sassfully/feedback-sidecar-envelope/v1", version: 1, bundleFirst: true, idempotencyKey: "fb-old", digest: "08f44b07b5901a25", size: 2, payload: {} }));
  assert.equal(response.status, 201);
});
