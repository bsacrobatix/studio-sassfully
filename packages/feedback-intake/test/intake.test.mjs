import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
