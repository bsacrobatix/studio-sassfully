// Capture -> review -> bundle-first sidecar submission. Raw evidence remains
// local until an individual reviewer approves that item's sidecar upload.
import { createAnchor } from "./anchor.mjs";
import { isKind, KIND_CONFIG } from "./kinds.mjs";
import { privacyVerdict } from "./privacy.mjs";
import { contentDigest, idempotencyKey } from "./idempotency.mjs";

export function createDraft(kind, anchorSpec, { draftId, context } = {}) {
  if (!isKind(kind)) throw new TypeError(`draft: unknown kind ${kind}`);
  const anchor = anchorSpec.producer ? createAnchor(anchorSpec) : anchorSpec;
  return { state: "draft", draftId: draftId ?? `draft-${contentDigest({ kind, anchor })}`, kind, anchor, evidence: [], userText: "", ...(context === undefined ? {} : { context }) };
}

/** Attach local-only raw evidence. Metadata is lean and reviewable; raw payload
 * is deliberately absent from reviewedPayload and sidecar upload is opt-in. */
export function attachEvidence(draft, { kind, label, payload, snippet, contentType, size, transport } = {}) {
  if (draft.state !== "draft" && draft.state !== "in_review" && draft.state !== "blocked") throw new Error(`evidence: cannot attach in state ${draft.state}`);
  const encodedSize = new TextEncoder().encode(JSON.stringify(payload ?? null)).byteLength;
  if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) throw new TypeError("evidence: size must be a non-negative integer");
  draft.evidence.push({ kind, label, payload, snippet: snippet ?? null, digest: contentDigest(payload), ...(contentType === undefined ? {} : { contentType }), size: size ?? encodedSize, sizeProvided: size !== undefined, ...(transport === undefined ? {} : { transport }), uploadApproved: false });
  return draft;
}

/** Toggle an individual raw upload decision before bundle approval. */
export function setEvidenceUpload(draft, digest, uploadApproved) {
  if (draft.state !== "draft" && draft.state !== "in_review" && draft.state !== "blocked") throw new Error(`evidence: cannot change upload approval in state ${draft.state}`);
  if (typeof uploadApproved !== "boolean") throw new TypeError("evidence: uploadApproved must be boolean");
  const item = draft.evidence.find((candidate) => candidate.digest === digest);
  if (!item) throw new Error(`evidence: unknown digest ${digest}`);
  item.uploadApproved = uploadApproved;
  return item;
}

export function setUserText(draft, text) { draft.userText = String(text); return draft; }

export function reviewedPayload(draft) {
  return {
    kind: draft.kind, anchor: { ...draft.anchor }, userText: draft.userText,
    evidence: draft.evidence.map(({ kind, label, digest, snippet, contentType, size, sizeProvided, transport, uploadApproved }) => ({ kind, label, digest, snippet, ...(contentType === undefined ? {} : { contentType }), ...(sizeProvided ? { size } : {}), ...(transport === undefined ? {} : { transport }), ...(uploadApproved ? { uploadApproved: true } : {}) })),
    ...(draft.context === undefined ? {} : { context: draft.context }),
  };
}

export function beginReview(draft, manifest) {
  draft.state = "in_review";
  const payload = reviewedPayload(draft); const verdict = privacyVerdict(payload, manifest);
  draft.lastVerdict = verdict; if (!verdict.ok) draft.state = "blocked";
  return { payload, verdict, kindConfig: KIND_CONFIG[draft.kind] };
}

export function approveReview(draft, manifest) {
  const required = KIND_CONFIG[draft.kind].requiredFields;
  if (required.includes("userText") && !draft.userText.trim()) throw new Error(`review: kind ${draft.kind} requires userText`);
  const payload = reviewedPayload(draft); const verdict = privacyVerdict(payload, manifest);
  if (!verdict.ok) { draft.state = "blocked"; throw new Error(`review: privacy fails closed — ${verdict.violations.map((v) => `${v.path}: ${v.reason}`).join("; ")}`); }
  draft.state = "reviewed";
  draft.reviewedBundle = Object.freeze({ ...payload, reviewed: true, idempotencyKey: idempotencyKey(payload) });
  return draft.reviewedBundle;
}

export async function submit(draft, router) {
  if ((draft.state !== "reviewed" && draft.state !== "submitted") || !draft.reviewedBundle?.reviewed) throw new Error(`submit: only a reviewed bundle may be submitted (state: ${draft.state})`);
  const receipt = await router.submit(draft.reviewedBundle); draft.state = "submitted"; draft.receipt = receipt; return receipt;
}

/** Raw sidecars may only leave after the successful bundle receipt. Each item
 * returns a result instead of throwing, allowing failed/skipped items to retry. */
export function sidecarItems(draft) {
  if (draft.state !== "submitted" || !draft.receipt) throw new Error("evidence: bundle submit must succeed before sidecars");
  return draft.evidence.filter((item) => item.uploadApproved);
}

export async function uploadEvidence(draft, router) {
  const items = sidecarItems(draft);
  const results = await Promise.all(items.map(async (item) => {
    try { return await router.uploadEvidence(draft.reviewedBundle, item); }
    catch (error) { return { digest: item.digest, status: "failed", evidenceError: error.message }; }
  }));
  draft.evidenceReceipt = results;
  return results;
}
