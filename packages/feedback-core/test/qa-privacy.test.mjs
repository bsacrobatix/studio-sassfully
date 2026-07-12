// qa-privacy.test.mjs — qa-feedback-privacy's gate suite: deterministic
// proof of req-privacy-fail-closed (an unclassified field blocks submit,
// with the reason listed) and req-raw-drafts-stay-local (no sink receives
// anything before review; sinks receive only the reviewed bundle).
// Run by scripts/qa/feedback-privacy.sh (the qa-target's `gate` command).
import test from "node:test";
import assert from "node:assert/strict";

import {
  createPrivacyManifest,
  createDraft, attachEvidence, setUserText, beginReview, approveReview, submit,
  createRouter,
} from "../src/index.mjs";

const CLASSIFIED = {
  "kind": "public",
  "anchor.producer": "public",
  "anchor.artifactId": "public",
  "anchor.ref": "low",
  "userText": "user_provided",
};

function spySink() {
  const calls = [];
  return { id: "spy", calls, async submit(bundle) { calls.push(bundle); return { ref: bundle.idempotencyKey }; } };
}

test("fail closed: a field with unknown sensitivity blocks submit and names itself", () => {
  const manifest = createPrivacyManifest({ fields: CLASSIFIED }); // anchor.extra.sessionId never classified
  const draft = createDraft("bug", { producer: "portal", artifactId: "n1", ref: "r", extra: { sessionId: "s-123" } });
  setUserText(draft, "text");
  const { verdict } = beginReview(draft, manifest);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.violations.some((v) => v.path === "anchor.extra.sessionId" && /unknown sensitivity/.test(v.reason)));
  assert.equal(draft.state, "blocked");
  assert.throws(() => approveReview(draft, manifest), /privacy fails closed/);
});

test("fail closed: a high-risk field without a host policy blocks; declaring the policy unblocks", () => {
  const fields = { ...CLASSIFIED, "anchor.url": "high" };
  const blocked = createPrivacyManifest({ fields });
  const draft = createDraft("bug", { producer: "portal", artifactId: "n1", url: "http://internal.host/secret-path" });
  setUserText(draft, "text");
  assert.equal(beginReview(draft, blocked).verdict.ok, false);

  const allowed = createPrivacyManifest({ fields, hostPolicies: { "anchor.url": "allow" } });
  assert.equal(beginReview(draft, allowed).verdict.ok, true);
  const bundle = approveReview(draft, allowed);
  assert.equal(bundle.reviewed, true);
});

test("raw drafts stay local: sink sees only the reviewed bundle, never raw payloads; nothing pre-review", async () => {
  const manifest = createPrivacyManifest({
    fields: { ...CLASSIFIED, "evidence.kind": "low", "evidence.label": "low", "evidence.digest": "public", "evidence.snippet": "user_provided" },
  });
  const sink = spySink();
  const router = createRouter({ sinks: [sink] });

  const draft = createDraft("bug", { producer: "portal", artifactId: "n1", ref: "r" });
  attachEvidence(draft, { kind: "network", label: "failed request", payload: { har: "GIANT-RAW-HAR-BLOB", cookie: "secret" }, snippet: "POST /rpc 500" });
  setUserText(draft, "it broke");

  await assert.rejects(() => submit(draft, router), /only a reviewed bundle/);
  assert.equal(sink.calls.length, 0, "no sink call may happen before review");

  beginReview(draft, manifest);
  approveReview(draft, manifest);
  await submit(draft, router);
  assert.equal(sink.calls.length, 1);
  const wire = JSON.stringify(sink.calls[0]);
  assert.ok(!wire.includes("GIANT-RAW-HAR-BLOB") && !wire.includes("secret"), "raw evidence payloads must never reach a sink");
  assert.ok(wire.includes("POST /rpc 500"), "the short reviewed snippet is what travels");
});
