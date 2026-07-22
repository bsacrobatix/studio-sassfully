import test from "node:test";
import assert from "node:assert/strict";
import { createRecordingRing, replayEvidenceItems } from "../src/ring.mjs";
import { contentDigest } from "../src/deps.mjs";
import { meta, fullSnapshot, incremental } from "./helpers.mjs";

test("evicts whole leading segments and never strands the tail without a checkpoint", () => {
  const ring = createRecordingRing({ maxEvents: 6 });
  ring.push(meta(0)); ring.push(fullSnapshot(1)); ring.push(incremental(2)); ring.push(incremental(3));
  ring.push(meta(10)); ring.push(fullSnapshot(11)); ring.push(incremental(12));
  const stats = ring.stats();
  assert.equal(stats.events, 3);
  assert.equal(stats.checkpoints, 1);
  const snapshot = ring.snapshot();
  assert.equal(snapshot.events[0].type, 4);
  assert.equal(snapshot.events[1].type, 2);
  assert.equal(snapshot.startTs, 10);
  assert.equal(snapshot.endTs, 12);
});

test("a single over-budget segment keeps its snapshot head under the hard cap", () => {
  const ring = createRecordingRing({ maxEvents: 4 });
  ring.push(meta(0)); ring.push(fullSnapshot(1));
  for (let i = 2; i < 10; i++) ring.push(incremental(i));
  const stats = ring.stats();
  assert.equal(stats.events, 4);
  const snapshot = ring.snapshot();
  assert.equal(snapshot.events[0].type, 4);
  assert.equal(snapshot.events[1].type, 2);
  assert.equal(snapshot.events[3].timestamp, 9);
});

test("byte budget evicts too, and clear resets", () => {
  const ring = createRecordingRing({ maxBytes: 400 });
  ring.push(fullSnapshot(0, "x".repeat(250)));
  ring.push(fullSnapshot(10, "y".repeat(250)));
  ring.push(incremental(11));
  assert.equal(ring.stats().checkpoints, 1);
  assert.ok(ring.stats().bytes <= 400);
  ring.clear();
  assert.deepEqual(ring.snapshot().events, []);
  assert.equal(ring.stats().events, 0);
});

test("trailing-window snapshot starts at the latest checkpoint at or before the window", () => {
  const ring = createRecordingRing({});
  ring.push(meta(0)); ring.push(fullSnapshot(1)); ring.push(incremental(50));
  ring.push(meta(100)); ring.push(fullSnapshot(101)); ring.push(incremental(150)); ring.push(incremental(200));
  const snapshot = ring.snapshot({ lastMs: 60 });
  assert.equal(snapshot.startTs, 100);
  assert.equal(snapshot.events[0].type, 4);
  assert.equal(snapshot.events[1].type, 2);
  assert.equal(snapshot.endTs, 200);
});

test("snapshots are frozen copies — the ring rolling on never mutates them", () => {
  const ring = createRecordingRing({ maxEvents: 3 });
  ring.push(fullSnapshot(0)); ring.push(incremental(1));
  const snapshot = ring.snapshot();
  ring.push(incremental(2)); ring.push(fullSnapshot(3)); ring.push(incremental(4));
  assert.equal(snapshot.events.length, 2);
  assert.ok(Object.isFrozen(snapshot));
});

test("chunking splits under the cap with stable per-chunk digests and shared clipId", () => {
  const ring = createRecordingRing({});
  ring.push(meta(0)); ring.push(fullSnapshot(1, "a".repeat(300)));
  for (let i = 2; i < 8; i++) ring.push(incremental(i, "b".repeat(300)));
  const snapshot = ring.snapshot();
  const items = replayEvidenceItems(snapshot, { maxChunkBytes: 800, clipId: "clip-1" });
  assert.ok(items.length > 1);
  assert.equal(items[0].payload.of, items.length);
  assert.deepEqual(items.map((item) => item.payload.chunk), items.map((_, i) => i + 1));
  for (const item of items) {
    assert.equal(item.kind, "replay");
    assert.equal(item.transport, "sidecar-json");
    assert.equal(item.payload.clipId, "clip-1");
    assert.ok(new TextEncoder().encode(JSON.stringify(item.payload.events)).byteLength <= 800);
  }
  const total = items.reduce((sum, item) => sum + item.payload.events.length, 0);
  assert.equal(total, snapshot.events.length);
  assert.equal(contentDigest(items[0].payload), contentDigest(replayEvidenceItems(snapshot, { maxChunkBytes: 800, clipId: "clip-1" })[0].payload));
});

test("empty snapshot yields no items; clipId is required", () => {
  assert.deepEqual(replayEvidenceItems({ events: [] }, { clipId: "c" }), []);
  assert.throws(() => replayEvidenceItems({ events: [meta(0)] }, {}), /clipId/);
});
