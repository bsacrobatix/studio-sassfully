import test from "node:test";
import assert from "node:assert/strict";
import { createPrivacyManifest, createReviewSession, createReviewedComment, addReviewedComment, reorderComments, approveSessionSummary, submitReviewSession, appendReviewReceipt } from "../src/index.mjs";
const manifest = createPrivacyManifest({ fields: { title: "user_provided", summary: "user_provided", verdict: "public" } });
const bundle = (key) => ({ reviewed: true, idempotencyKey: key, kind: "content_comment", anchor: { producer: "host", artifactId: "opaque" }, userText: "note" });
const subject = { specId: "opaque-spec", specRevision: "r1", artifactId: "opaque-artifact", artifactKind: "opaque-kind" };

test("review groups independent stable comments at one pinned revision and submits once", async () => {
  const session = createReviewSession({ subject, reviewer: "reviewer", title: "Review", summary: "Looks good", verdict: "approve" });
  addReviewedComment(session, bundle("a"), { commentId: "comment-a" }); addReviewedComment(session, bundle("b"), { commentId: "comment-b" });
  reorderComments(session, ["comment-b", "comment-a"]);
  assert.deepEqual(session.comments.map((item) => [item.commentId, item.sequence]), [["comment-b", 0], ["comment-a", 1]]);
  approveSessionSummary(session, manifest); let calls = 0;
  const router = { submit: async (payload) => { calls++; assert.deepEqual(payload.commentIds, ["comment-b", "comment-a"]); return { ref: payload.idempotencyKey }; } };
  const receipt = await submitReviewSession(session, router, { currentRevision: "r1" });
  assert.equal(receipt.phase, "submitted"); assert.equal((await submitReviewSession(session, router)).receiptId, receipt.receiptId); assert.equal(calls, 1);
});
test("rejects cross-revision, stale targets, and unknown summary context", async () => {
  const session = createReviewSession({ subject, summary: "x", verdict: "approve", context: { unknown: "x" } });
  const wrong = createReviewedComment({ reviewId: session.sessionId, subject: { ...subject, specRevision: "r2" }, bundle: bundle("a") });
  assert.throws(() => addReviewedComment(session, wrong), /cross-revision/);
  addReviewedComment(session, bundle("a"));
  assert.throws(() => approveSessionSummary(session, manifest), /fails closed/);
  session.context = undefined; approveSessionSummary(session, manifest);
  await assert.rejects(() => submitReviewSession(session, { submit: async () => ({}) }, { currentRevision: "r2" }), /stale target/);
});
test("processing and resolution are append-only idempotent receipts", () => {
  const session = createReviewSession({ subject });
  const first = appendReviewReceipt(session, { phase: "processing", detail: "queued", idempotencyKey: "p1" });
  assert.equal(appendReviewReceipt(session, { phase: "processing", detail: "queued", idempotencyKey: "p1" }), first);
  appendReviewReceipt(session, { phase: "resolved", detail: "done", idempotencyKey: "r1" });
  assert.deepEqual(session.receipts.map((item) => item.phase), ["processing", "resolved"]);
});
