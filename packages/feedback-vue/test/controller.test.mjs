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

test("controller submits the bundle before approved sidecars and retries only failed evidence", async () => {
  const calls = []; let fail = true;
  const sink = { id: "evidence", async submit(bundle) { calls.push("bundle"); return { ref: bundle.idempotencyKey }; }, async uploadEvidence(_bundle, item) { calls.push(`sidecar:${item.digest}`); if (fail) { fail = false; throw new Error("temporary blob failure"); } return { digest: item.digest, status: "uploaded" }; } };
  const manifest = createPrivacyManifest({ fields: { ...fields, "evidence.kind": "low", "evidence.label": "low", "evidence.digest": "public", "evidence.snippet": "low", "evidence.size": "low", "evidence.uploadApproved": "public" } });
  const reporter = createFeedbackReporter({ anchorFor: () => ({ producer: "host", artifactId: "item" }), manifest, router: createRouter({ sinks: [sink] }), context: { build: "v1" } });
  reporter.choose("bug"); reporter.setText("broken"); reporter.attach({ kind: "trace", label: "trace", payload: { secret: "raw" } }); const digest = reporter.state.draft.evidence[0].digest; reporter.toggleUpload(digest, true); reporter.review();
  const receipt = await reporter.submit(); assert.match(receipt.evidenceError, /temporary/); assert.equal(calls[0], "bundle");
  await reporter.retryEvidence(); assert.equal(reporter.state.evidenceResults[0].status, "uploaded"); assert.equal(calls.filter((x) => x === "bundle").length, 1, "deduped bundle receipt still precedes retry");
});

test("controller captures host-provided evidence locally and keeps upload unchecked", async () => {
  const reporter = createFeedbackReporter({ anchorFor: () => ({ producer: "host", artifactId: "item" }), manifest: createPrivacyManifest({ fields }), router: createRouter({ sinks: [bundleSink()] }), captureProviders: [{ id: "screenshot", label: "Screenshot", async capture() { return { kind: "screenshot", label: "Current view", payload: { image: "local-only" }, contentType: "application/json" }; } }] });
  reporter.choose("bug");
  await reporter.capture("screenshot");
  assert.equal(reporter.state.draft.evidence.length, 1);
  assert.equal(reporter.state.draft.evidence[0].uploadApproved, false);
  assert.equal(reporter.state.captureProviders[0].label, "Screenshot");
});

test("controller keeps capture failures local and visible", async () => {
  const reporter = createFeedbackReporter({ anchorFor: () => ({ producer: "host", artifactId: "item" }), manifest: createPrivacyManifest({ fields }), router: createRouter({ sinks: [bundleSink()] }), captureProviders: [{ id: "broken", async capture() { throw new Error("capture unavailable"); } }] });
  reporter.choose("bug");
  assert.deepEqual(await reporter.capture("broken"), []);
  assert.match(reporter.state.captureError, /capture unavailable/);
});

test("controller auto-captures listed providers as soon as a draft exists", async () => {
  let calls = 0;
  const reporter = createFeedbackReporter({
    anchorFor: () => ({ producer: "host", artifactId: "item" }),
    manifest: createPrivacyManifest({ fields }),
    router: createRouter({ sinks: [bundleSink()] }),
    captureProviders: [{ id: "replay", label: "Replay", async capture() { calls += 1; return { kind: "replay", label: "Replay", payload: { events: [] }, contentType: "application/json" }; } }],
    autoCapture: ["replay", "unregistered-id"],
  });
  reporter.choose("bug");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.equal(reporter.state.draft.evidence.length, 1);
});

test("controller pre-approves upload for items from an autoApprove provider", async () => {
  const reporter = createFeedbackReporter({
    anchorFor: () => ({ producer: "host", artifactId: "item" }),
    manifest: createPrivacyManifest({ fields }),
    router: createRouter({ sinks: [bundleSink()] }),
    captureProviders: [{ id: "replay", autoApprove: true, async capture() { return { kind: "replay", label: "Replay", payload: { events: [] } }; } }],
  });
  reporter.choose("bug");
  await reporter.capture("replay");
  assert.equal(reporter.state.draft.evidence[0].uploadApproved, true);
});

test("controller leaves upload unapproved when a provider omits autoApprove", async () => {
  const reporter = createFeedbackReporter({
    anchorFor: () => ({ producer: "host", artifactId: "item" }),
    manifest: createPrivacyManifest({ fields }),
    router: createRouter({ sinks: [bundleSink()] }),
    captureProviders: [{ id: "screenshot", async capture() { return { kind: "screenshot", label: "s", payload: {} }; } }],
  });
  reporter.choose("bug");
  await reporter.capture("screenshot");
  assert.equal(reporter.state.draft.evidence[0].uploadApproved, false);
});

test("controller does not auto-capture providers absent from autoCapture", async () => {
  let calls = 0;
  const reporter = createFeedbackReporter({
    anchorFor: () => ({ producer: "host", artifactId: "item" }),
    manifest: createPrivacyManifest({ fields }),
    router: createRouter({ sinks: [bundleSink()] }),
    captureProviders: [{ id: "screenshot", async capture() { calls += 1; return { kind: "screenshot", label: "s", payload: {} }; } }],
  });
  reporter.choose("bug");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 0);
  assert.equal(reporter.state.draft.evidence.length, 0);
});
