// unit.test.mjs — ts-feedback-core-unit's suite: proves
// req-capture-review-submit (plus the envelope/kind invariants the machine
// rides on). Recorded into pog/evidence/feedback-core-unit.json by
// scripts/record-unit-evidence.sh.
import test from "node:test";
import assert from "node:assert/strict";

import {
  KINDS, KIND_CONFIG,
  createAnchor, anchorDisplayFields,
  createPrivacyManifest,
  createDraft, attachEvidence, setUserText, beginReview, approveReview, submit,
  bundleSink, httpSink, createRouter,
} from "../src/index.mjs";

const MANIFEST = createPrivacyManifest({
  fields: {
    "kind": "public",
    "anchor.producer": "public",
    "anchor.artifactId": "public",
    "anchor.scope": "low",
    "anchor.step": "low",
    "anchor.ref": "low",
    "anchor.label": "low",
    "anchor.url": "low",
    "userText": "user_provided",
    "evidence.kind": "low",
    "evidence.label": "low",
    "evidence.digest": "public",
    "evidence.snippet": "user_provided",
  },
});

test("anchor envelope: producer-owned, shape-validated, frozen", () => {
  const a = createAnchor({ producer: "portal", artifactId: "node-42", scope: "catalog", step: "review", ref: "cs-9#op0", label: "Wire types", bbox: [1, 2, 3, 4], url: "http://localhost/x" });
  assert.equal(a.producer, "portal");
  assert.ok(Object.isFrozen(a));
  assert.throws(() => createAnchor({ artifactId: "x" }), /producer .* required/);
  assert.throws(() => createAnchor({ producer: "p", artifactId: "x", domText: "raw" }), /unknown field/);
  const fields = anchorDisplayFields(a);
  assert.ok(fields.some(([k, v]) => k === "ref" && v === "cs-9#op0"));
});

test("kinds: all nine present; config never forks the anchor/evidence model", () => {
  assert.deepEqual([...KINDS].sort(), ["ai_instruction", "approval", "bug", "content_comment", "copy_feedback", "design_feedback", "issue_request", "question", "rejection"]);
  for (const k of KINDS) {
    const cfg = KIND_CONFIG[k];
    assert.ok(cfg.label);
    assert.ok(!("anchorSchema" in cfg) && !("evidenceSchema" in cfg));
  }
});

test("capture -> review -> submit: the reviewed note is the artifact", async () => {
  const draft = createDraft("bug", { producer: "portal", artifactId: "node-42", ref: "row-3" });
  attachEvidence(draft, { kind: "console", label: "console error", payload: { raw: "TypeError: x is undefined at very/long/private/path.js:12" }, snippet: "TypeError: x is undefined" });
  setUserText(draft, "Clicking materialize throws");
  const { payload, verdict } = beginReview(draft, MANIFEST);
  assert.equal(verdict.ok, true);
  assert.ok(!JSON.stringify(payload).includes("very/long/private/path"), "raw payload must not appear in the review projection");
  const bundle = approveReview(draft, MANIFEST);
  assert.equal(bundle.reviewed, true);
  assert.match(bundle.idempotencyKey, /^fb-[0-9a-f]{16}$/);

  const sink = bundleSink();
  const router = createRouter({ sinks: [sink] });
  const receipt = await submit(draft, router);
  assert.equal(receipt.sink, "bundle");
  assert.equal(sink.bundles.length, 1);
  assert.equal(draft.state, "submitted");
});

test("submit refuses anything not reviewed", async () => {
  const draft = createDraft("approval", { producer: "portal", artifactId: "node-7" });
  const router = createRouter({ sinks: [bundleSink()] });
  await assert.rejects(() => submit(draft, router), /only a reviewed bundle/);
});

test("required fields per kind are enforced at approval", () => {
  const draft = createDraft("rejection", { producer: "portal", artifactId: "node-7" });
  beginReview(draft, MANIFEST);
  assert.throws(() => approveReview(draft, MANIFEST), /requires userText/);
});

test("context is reviewed and fails closed when a producer leaves it unclassified", () => {
  const draft = createDraft("bug", { producer: "portal", artifactId: "node-7" }, {
    context: { build: { version: "2026.07.12" } },
  });
  setUserText(draft, "It broke");
  const { payload, verdict } = beginReview(draft, MANIFEST);
  assert.deepEqual(payload.context, { build: { version: "2026.07.12" } });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.violations.some((v) => v.path === "context.build.version"));
  assert.throws(() => approveReview(draft, MANIFEST), /privacy fails closed/);
});

test("http sink posts the reviewed bundle and returns its intake receipt", async () => {
  const calls = [];
  const sink = httpSink({
    url: "https://feedback.example/api/feedback",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 201, json: async () => ({ ref: "receipt-1" }) };
    },
  });
  const receipt = await sink.submit({ reviewed: true, idempotencyKey: "fb-123" });
  assert.deepEqual(receipt, { ref: "receipt-1" });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), { reviewed: true, idempotencyKey: "fb-123" });
});

test("http sink exposes non-success responses for retry", async () => {
  const sink = httpSink({ url: "https://feedback.example/api/feedback", fetch: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(() => sink.submit({ reviewed: true }), /503/);
});

test("http sink rejects receipts without a string ref and refuses bad construction", async () => {
  const sink = httpSink({ url: "https://feedback.example/api/feedback", fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  await assert.rejects(() => sink.submit({ reviewed: true }), /string ref/);
  assert.throws(() => httpSink({}), TypeError);
  assert.throws(() => httpSink({ url: "https://x", fetch: null }), TypeError);
});
