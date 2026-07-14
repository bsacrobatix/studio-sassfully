// Framework-free controller. The bundle receipt is always obtained before any
// opt-in raw sidecars; failures are retained as non-throwing evidence results.
import { createDraft, attachEvidence, setEvidenceUpload, setUserText, beginReview, approveReview, submit, uploadEvidence } from "../../feedback-core/src/index.mjs";
export function createFeedbackReporter({ anchorFor, manifest, router, context } = {}) {
  if (typeof anchorFor !== "function") throw new TypeError("feedback-vue: anchorFor function is required");
  const state = { phase: "choose", kind: null, draft: null, review: null, receipt: null, evidenceResults: [], error: null };
  const notify = () => state.onChange?.({ ...state });
  const api = {
    state, subscribe(listener) { state.onChange = listener; return () => { if (state.onChange === listener) state.onChange = null; }; },
    choose(kind) { state.kind = kind; state.draft = createDraft(kind, anchorFor(kind), { context }); state.review = null; state.receipt = null; state.evidenceResults = []; state.error = null; state.phase = "draft"; notify(); },
    setText(text) { if (!state.draft) throw new Error("feedback-vue: choose a kind first"); setUserText(state.draft, text); notify(); },
    attach(item) { if (!state.draft) throw new Error("feedback-vue: choose a kind first"); const attached = attachEvidence(state.draft, item); notify(); return attached; },
    detach(digest) { if (!state.draft || state.draft.state === "reviewed" || state.draft.state === "submitted") throw new Error("feedback-vue: evidence cannot be detached after approval"); const i = state.draft.evidence.findIndex((item) => item.digest === digest); if (i < 0) throw new Error(`feedback-vue: unknown evidence ${digest}`); state.draft.evidence.splice(i, 1); notify(); },
    toggleUpload(digest, uploadApproved) { if (!state.draft) throw new Error("feedback-vue: choose a kind first"); const item = setEvidenceUpload(state.draft, digest, uploadApproved); notify(); return item; },
    review() { if (!state.draft) throw new Error("feedback-vue: choose a kind first"); state.review = beginReview(state.draft, manifest); state.phase = "review"; notify(); return state.review; },
    async submit() { if (!state.draft || !state.review?.verdict.ok) throw new Error("feedback-vue: privacy review must pass before submit"); try { if (state.draft.state !== "submitted") approveReview(state.draft, manifest); state.receipt = await submit(state.draft, router); state.evidenceResults = await uploadEvidence(state.draft, router); const failed = state.evidenceResults.filter((item) => item.status === "failed"); if (failed.length) state.receipt = { ...state.receipt, evidenceError: failed.map((item) => item.evidenceError).join("; ") }; state.phase = "receipt"; state.error = null; notify(); return state.receipt; } catch (error) { state.error = error; notify(); throw error; } },
    async retryEvidence() { if (!state.draft || state.draft.state !== "submitted") throw new Error("feedback-vue: bundle receipt required before evidence retry"); return api.submit(); },
  }; return api;
}
