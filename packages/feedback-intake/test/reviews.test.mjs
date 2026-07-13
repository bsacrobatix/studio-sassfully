import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os"; import path from "node:path";
import { ReviewStore } from "../index.mjs";
test("review JSONL reconstructs independent comments and receipts after restart", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "reviews-"));
  try {
    const review = { sessionId: "r", idempotencyKey: "create", state: "open", subject: { specId: "s", specRevision: "1" }, summaryReview: { approved: true } };
    const store = await new ReviewStore({ dataDir }).load(); await store.create(review);
    await store.addComment("r", { commentId: "c", subjectRevision: "1", bundle: { reviewed: true, idempotencyKey: "c-key" } });
    await store.finalize("r", review, "finish"); await store.receipt("r", { phase: "resolved", idempotencyKey: "done" });
    const restored = await new ReviewStore({ dataDir }).load(); assert.equal(restored.list("s", "1")[0].comments[0].commentId, "c"); assert.equal(restored.reviews.get("r").state, "resolved");
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
