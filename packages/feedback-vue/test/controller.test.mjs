import test from "node:test";
import assert from "node:assert/strict";
import { createPrivacyManifest, createRouter, bundleSink } from "../../feedback-core/src/index.mjs";
import { createFeedbackReporter } from "../src/controller.mjs";

const fields = { kind: "public", "anchor.producer": "public", "anchor.artifactId": "public", userText: "user_provided", "context.build": "low" };
test("controller flows draft to review to submit to receipt", async () => {
  const reporter = createFeedbackReporter({ anchorFor: () => ({ producer: "host", artifactId: "item" }), manifest: createPrivacyManifest({ fields }), router: createRouter({ sinks: [bundleSink()] }), context: { build: "v1" } });
  reporter.choose("content_comment"); reporter.setText("Please revise this.");
  assert.equal(reporter.review().verdict.ok, true);
  const receipt = await reporter.submit();
  assert.equal(reporter.state.phase, "receipt"); assert.ok(receipt.ref.startsWith("fb-"));
});
test("controller keeps submit blocked for an unclassified context field", async () => {
  const reporter = createFeedbackReporter({ anchorFor: () => ({ producer: "host", artifactId: "item" }), manifest: createPrivacyManifest({ fields }), router: createRouter({ sinks: [bundleSink()] }), context: { build: "v1", viewer: "unclassified" } });
  reporter.choose("bug"); reporter.setText("Broken");
  assert.equal(reporter.review().verdict.ok, false);
  await assert.rejects(() => reporter.submit(), /privacy review must pass/);
});
