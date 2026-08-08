import test from "node:test";
import assert from "node:assert/strict";
import { createReplayFixtureEnvelope, extractReplayControls } from "../src/replay-fixture.mjs";

const record = { bundle: { reviewed: true, idempotencyKey: "fb-captured", anchor: { producer: "sassfully-ext", artifactId: "https://www.linkedin.com/jobs/search-results/" }, evidence: [{ kind: "replay", digest: "r1", uploadApproved: true }] }, sidecars: [{ digest: "r1", payload: { events: [{ timestamp: 42, data: { node: { tagName: "input", attributes: { "aria-label": "City, state, or zip code", value: "United States", token: "secret" }, childNodes: [] } } }] } }] };

test("replay fixture exports only reviewed replay payloads, redacts sensitive values, and preserves control timing", () => {
  const fixture = createReplayFixtureEnvelope([record]);
  assert.equal(fixture.entries[0].replay.length, 1);
  const node = fixture.entries[0].replay[0].payload.events[0].data.node;
  assert.equal(node.attributes.value, "[redacted]");
  assert.equal(node.attributes.token, "[redacted]");
  assert.deepEqual(extractReplayControls(fixture), [{ label: "City, state, or zip code", timestamp: 42 }]);
});

test("replay fixture refuses a manifest without every reviewed replay sidecar", () => {
  assert.throws(() => createReplayFixtureEnvelope([{ ...record, sidecars: [] }]), /missing approved replay sidecar/);
});
