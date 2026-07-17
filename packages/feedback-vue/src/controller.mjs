// Framework-free controller. The bundle receipt is always obtained before any
// opt-in raw sidecars; failures are retained as non-throwing evidence results.
import { createDraft, attachEvidence, setEvidenceUpload, setUserText, beginReview, approveReview, submit, uploadEvidence } from "../../feedback-core/src/index.mjs";
export function createFeedbackReporter({ anchorFor, manifest, router, context, captureProviders = [], autoCapture = [] } = {}) {
  if (typeof anchorFor !== "function") throw new TypeError("feedback-vue: anchorFor function is required");
  const providers = new Map(captureProviders.map((provider) => [provider.id, provider]));
  for (const provider of providers.values()) if (!provider?.id || typeof provider.capture !== "function") throw new TypeError("feedback-vue: each capture provider needs an id and capture function");
  const state = { phase: "choose", kind: null, draft: null, review: null, receipt: null, evidenceResults: [], error: null, captureError: null, captureProviders: [...providers.values()].map(({ id, label, description }) => ({ id, label: label ?? id, description })) };
  const notify = () => state.onChange?.({ ...state });
  const api = {
    state, subscribe(listener) { state.onChange = listener; return () => { if (state.onChange === listener) state.onChange = null; }; },
    // Auto-capture runs fire-and-forget after the draft exists: each listed
    // provider (if registered) attaches as soon as it resolves, independently
    // notifying — a host marks providers "capture immediately" instead of
    // requiring a user click for cheap/already-buffered evidence (e.g. a
    // rolling session recording). Unknown ids are ignored, not an error, so a
    // host's autoCapture list can name optional providers.
    choose(kind) { state.kind = kind; state.draft = createDraft(kind, anchorFor(kind), { context }); state.review = null; state.receipt = null; state.evidenceResults = []; state.error = null; state.captureError = null; state.phase = "draft"; notify(); for (const id of autoCapture) if (providers.has(id)) api.capture(id); },
    setText(text) { if (!state.draft) throw new Error("feedback-vue: choose a kind first"); setUserText(state.draft, text); notify(); },
    attach(item) { if (!state.draft) throw new Error("feedback-vue: choose a kind first"); const attached = attachEvidence(state.draft, item); notify(); return attached; },
    detach(digest) { if (!state.draft || state.draft.state === "reviewed" || state.draft.state === "submitted") throw new Error("feedback-vue: evidence cannot be detached after approval"); const i = state.draft.evidence.findIndex((item) => item.digest === digest); if (i < 0) throw new Error(`feedback-vue: unknown evidence ${digest}`); state.draft.evidence.splice(i, 1); notify(); },
    toggleUpload(digest, uploadApproved) { if (!state.draft) throw new Error("feedback-vue: choose a kind first"); const item = setEvidenceUpload(state.draft, digest, uploadApproved); notify(); return item; },
    // A provider marked `autoApprove: true` pre-checks its own attached
    // items' upload approval (still visible, still uncheckable in review) —
    // for evidence the host already considers safe-by-policy to submit
    // without a per-item click (e.g. bounded, host-redacted captures).
    async capture(id) { if (!state.draft) throw new Error("feedback-vue: choose a kind first"); const provider = providers.get(id); if (!provider) throw new Error(`feedback-vue: unknown capture provider ${id}`); try { const captured = await provider.capture(); const items = Array.isArray(captured) ? captured : [captured]; for (const item of items) { if (!item) continue; attachEvidence(state.draft, item); if (provider.autoApprove) setEvidenceUpload(state.draft, state.draft.evidence[state.draft.evidence.length - 1].digest, true); } state.captureError = null; notify(); return items; } catch (error) { state.captureError = error instanceof Error ? error.message : String(error); notify(); return []; } },
    review() { if (!state.draft) throw new Error("feedback-vue: choose a kind first"); state.review = beginReview(state.draft, manifest); state.phase = "review"; notify(); return state.review; },
    async submit() { if (!state.draft || !state.review?.verdict.ok) throw new Error("feedback-vue: privacy review must pass before submit"); try { if (state.draft.state !== "submitted") approveReview(state.draft, manifest); state.receipt = await submit(state.draft, router); state.evidenceResults = await uploadEvidence(state.draft, router); const failed = state.evidenceResults.filter((item) => item.status === "failed"); if (failed.length) state.receipt = { ...state.receipt, evidenceError: failed.map((item) => item.evidenceError).join("; ") }; state.phase = "receipt"; state.error = null; notify(); return state.receipt; } catch (error) { state.error = error; notify(); throw error; } },
    async retryEvidence() { if (!state.draft || state.draft.state !== "submitted") throw new Error("feedback-vue: bundle receipt required before evidence retry"); return api.submit(); },
  }; return api;
}
