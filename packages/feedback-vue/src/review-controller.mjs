import { createReviewSession, addReviewedComment, removeComment, reorderComments, reviewSessionSummary, approveSessionSummary, submitReviewSession } from "../../feedback-core/src/index.mjs";

// DOM-free review-session controller: raw editor text remains here (local
// drafts) until the caller supplies an individually approved bundle.
export function createReviewSessionController({ subject, reviewer, manifest, router, sessionId } = {}) {
  const state = { session: createReviewSession({ subject, reviewer, sessionId }), drafts: new Map(), receipt: null, error: null };
  const notify = () => state.onChange?.({ ...state });
  return {
    state,
    subscribe(listener) { state.onChange = listener; return () => { if (state.onChange === listener) state.onChange = null; }; },
    addDraft(id, draft) { state.drafts.set(id, draft); notify(); },
    discardDraft(id) { state.drafts.delete(id); notify(); },
    appendReviewed(bundle, options = {}) { addReviewedComment(state.session, bundle, options); state.drafts.delete(options.commentId ?? bundle.idempotencyKey); notify(); return state.session; },
    remove(commentId) { removeComment(state.session, commentId); notify(); },
    reorder(commentIds) { reorderComments(state.session, commentIds); notify(); },
    reviewSummary(values = {}) { Object.assign(state.session, values); const result = reviewSessionSummary(state.session, manifest); notify(); return result; },
    async submit(values = {}, currentRevision) { Object.assign(state.session, values); try { approveSessionSummary(state.session, manifest); state.receipt = await submitReviewSession(state.session, router, { currentRevision }); notify(); return state.receipt; } catch (error) { state.error = error; notify(); throw error; } },
  };
}
