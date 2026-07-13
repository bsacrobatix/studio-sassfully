import test from "node:test";
import assert from "node:assert/strict";
import { createPrivacyManifest } from "../../feedback-core/src/index.mjs";
import { createReviewSessionController } from "../src/review-controller.mjs";
const manifest = createPrivacyManifest({ fields: { title: "user_provided", summary: "user_provided", verdict: "public" } });
test("controller holds raw drafts locally and only submits reviewed comments", async () => {
  const controller = createReviewSessionController({ subject: { specId: "s", specRevision: "1" }, manifest, router: { submit: async () => ({ ref: "ok" }) } });
  controller.addDraft("local", { raw: "never sent" });
  controller.appendReviewed({ reviewed: true, idempotencyKey: "comment" });
  assert.equal(controller.state.drafts.has("comment"), false); assert.equal(controller.state.drafts.get("local").raw, "never sent");
  await controller.submit({ title: "t", summary: "s", verdict: "approve" }, "1");
  assert.equal(controller.state.session.state, "submitted");
});
