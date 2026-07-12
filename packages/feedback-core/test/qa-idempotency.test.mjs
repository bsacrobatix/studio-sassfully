// qa-idempotency.test.mjs — qa-feedback-idempotency's gate suite:
// deterministic proof of req-idempotent-submission. Run by
// scripts/qa/feedback-idempotency.sh (the qa-target's `gate` command).
import test from "node:test";
import assert from "node:assert/strict";

import {
  createPrivacyManifest,
  createDraft, setUserText, beginReview, approveReview,
  localJsonlSink, createRouter,
  idempotencyKey,
} from "../src/index.mjs";

const MANIFEST = createPrivacyManifest({
  fields: { "kind": "public", "anchor.producer": "public", "anchor.artifactId": "public", "anchor.ref": "low", "userText": "user_provided" },
});

function reviewedBundle(text = "double-click me") {
  const draft = createDraft("issue_request", { producer: "portal", artifactId: "node-9", ref: "row-1" });
  setUserText(draft, text);
  beginReview(draft, MANIFEST);
  return approveReview(draft, MANIFEST);
}

test("the key is stable: same reviewed content, same key; different content, different key", () => {
  assert.equal(reviewedBundle().idempotencyKey, reviewedBundle().idempotencyKey);
  assert.notEqual(reviewedBundle("a").idempotencyKey, reviewedBundle("b").idempotencyKey);
  const b = reviewedBundle();
  assert.equal(b.idempotencyKey, idempotencyKey(b), "key derives from the bundle itself, reproducibly");
});

test("duplicate click: submitting the same bundle twice yields one sink item, same ref", async () => {
  const sink = localJsonlSink();
  const router = createRouter({ sinks: [sink] });
  const bundle = reviewedBundle();
  const r1 = await router.submit(bundle);
  const r2 = await router.submit(bundle);
  assert.equal(r1.ref, r2.ref);
  assert.equal(r2.deduped, true);
  assert.equal(sink.lines.length, 1, "one JSONL note, not two");
});

test("network-failure retry: a sink that fails once does not leave a settled key; retry lands exactly one item", async () => {
  let failures = 1;
  const flaky = {
    id: "flaky", lines: [],
    async submit(bundle) {
      if (failures-- > 0) throw new Error("ECONNRESET");
      this.lines.push(JSON.stringify(bundle));
      return { ref: bundle.idempotencyKey };
    },
  };
  const router = createRouter({ sinks: [flaky] });
  const bundle = reviewedBundle("retry me");
  await assert.rejects(() => router.submit(bundle), /ECONNRESET/);
  const receipt = await router.submit(bundle);
  assert.equal(receipt.deduped, false);
  assert.equal(flaky.lines.length, 1);
  const again = await router.submit(bundle);
  assert.equal(again.deduped, true);
  assert.equal(flaky.lines.length, 1);
});
