import test from "node:test";
import assert from "node:assert/strict";
import { extensionAnchor, extensionPrivacyManifest, createStandaloneReporter, EXTENSION_PRODUCER } from "../src/standalone.mjs";
import { createRecordingRing } from "../src/ring.mjs";
import { startMainTelemetry, createTelemetryClient } from "../src/telemetry-main.mjs";
import { memoryBackend, createBundleStore, extensionLocalSink, syncToIntake } from "../src/storage.mjs";
import { createRouter, privacyVerdict, reviewedPayload, createDraft, setUserText, bundleSink } from "../src/deps.mjs";
import { fakeWindow, settle, meta, fullSnapshot, incremental } from "./helpers.mjs";

test("anchors strip query and fragment and stamp the extension producer", () => {
  const anchor = extensionAnchor({ url: "https://app.example/checkout?token=sekrit#frag", bbox: [1, 2, 3, 4] });
  assert.equal(anchor.producer, EXTENSION_PRODUCER);
  assert.equal(anchor.artifactId, "https://app.example/checkout");
  assert.equal(anchor.url, "https://app.example/checkout");
  assert.deepEqual(anchor.bbox, [1, 2, 3, 4]);
});

test("manifest passes a representative standalone bundle and fails closed on new fields", () => {
  const manifest = extensionPrivacyManifest();
  const draft = createDraft("bug", extensionAnchor({ url: "https://app.example/checkout", bbox: [0, 0, 10, 10], mediaTimeMs: 1200 }), { context: { mode: "extension-standalone", extensionVersion: "0.1.0" } });
  setUserText(draft, "the cart emptied itself");
  draft.evidence.push({ kind: "replay", label: "Session replay", digest: "abc", snippet: "s", contentType: "application/json", size: 10, sizeProvided: true, transport: "sidecar-json", uploadApproved: true });
  const payload = reviewedPayload(draft);
  assert.deepEqual(privacyVerdict(payload, manifest), { ok: true, violations: [] });
  const verdict = privacyVerdict({ ...payload, surprise: "field" }, manifest);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.violations[0].path, "surprise");
});

test("full standalone flow: draft -> auto telemetry -> replay -> review -> submit -> local sidecars -> sync", async () => {
  const win = fakeWindow();
  const mainTelemetry = startMainTelemetry({ window: win });
  const client = createTelemetryClient({ window: win });
  const ring = createRecordingRing({});
  ring.push(meta(0)); ring.push(fullSnapshot(1)); ring.push(incremental(2)); ring.push(incremental(3));
  const store = createBundleStore(memoryBackend());
  const router = createRouter({ sinks: [extensionLocalSink(store)] });
  const reporter = createStandaloneReporter({ ring, telemetryClient: client, router, url: "https://app.example/checkout?step=2", extensionVersion: "0.1.0", clipId: "clip-t" });

  reporter.choose("bug");
  await settle(); await settle();
  assert.deepEqual(reporter.state.draft.evidence.map((item) => item.kind), ["network", "console", "error"]);
  await reporter.capture("ext-replay");
  const replayItems = reporter.state.draft.evidence.filter((item) => item.kind === "replay");
  assert.equal(replayItems.length, 1);
  reporter.setText("the cart emptied itself");
  const review = reporter.review();
  assert.equal(review.verdict.ok, true);
  reporter.toggleUpload(replayItems[0].digest, true);
  const receipt = await reporter.submit();
  assert.equal(receipt.sink, "ext-local");
  assert.equal(reporter.state.evidenceResults.length, 1);
  assert.equal(reporter.state.evidenceResults[0].status, "uploaded");

  const record = await store.get(receipt.ref);
  assert.equal(record.bundle.reviewed, true);
  assert.equal(record.bundle.anchor.url, "https://app.example/checkout");
  assert.equal(record.sidecars.length, 1);
  assert.equal(record.sidecars[0].payload.clipId, "clip-t");

  const remote = bundleSink();
  const results = await syncToIntake(store, remote);
  assert.deepEqual(results.map((result) => result.status), ["synced"]);
  assert.equal(remote.bundles.length, 1);
  assert.equal(remote.blobs.size, 1);
  const again = await syncToIntake(store, remote);
  assert.deepEqual(again.map((result) => result.status), ["already-synced"]);

  client.stop(); mainTelemetry.stop();
});
