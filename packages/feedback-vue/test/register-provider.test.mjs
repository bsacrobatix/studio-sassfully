import test from "node:test";
import assert from "node:assert/strict";
import { createFeedbackReporter } from "../src/controller.mjs";
import { createPrivacyManifest, createRouter, bundleSink } from "../../feedback-core/src/index.mjs";

const manifest = createPrivacyManifest({
  fields: {
    kind: "public", userText: "user_provided",
    "anchor.producer": "public", "anchor.artifactId": "low",
    "evidence.kind": "low", "evidence.label": "low", "evidence.digest": "low", "evidence.snippet": "low", "evidence.size": "low",
  },
});

test("registerProvider adds a late-arriving provider (extension bridge offer) usable by capture", async () => {
  const reporter = createFeedbackReporter({
    anchorFor: () => ({ producer: "acme-docs", artifactId: "doc-1" }),
    manifest,
    router: createRouter({ sinks: [bundleSink()] }),
  });
  assert.deepEqual(reporter.state.captureProviders, []);
  reporter.registerProvider({ id: "ext-replay", label: "Session replay", capture: () => [{ kind: "replay", label: "Session replay", payload: { events: [1] } }] });
  assert.deepEqual(reporter.state.captureProviders.map((p) => p.id), ["ext-replay"]);
  reporter.choose("bug");
  await reporter.capture("ext-replay");
  assert.deepEqual(reporter.state.draft.evidence.map((item) => item.kind), ["replay"]);
  assert.throws(() => reporter.registerProvider({ id: "bad" }), /capture provider/);
});
