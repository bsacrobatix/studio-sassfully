import { contentDigest } from "./idempotency.mjs";
import { privacyVerdict } from "./privacy.mjs";

const REVIEW_STATES = new Set(["open", "in_review", "submitted", "processing", "resolved", "closed"]);

function required(name, value) {
  if (typeof value !== "string" || !value) throw new TypeError(`review-session: ${name} is required`);
  return value;
}

/** A producer-owned target.  Sassfully never interprets its opaque IDs. */
export function createSubjectRevision({ specId, specRevision, artifactId, artifactKind, artifactRevision, producer } = {}) {
  const subject = { specId: required("specId", specId), specRevision: required("specRevision", specRevision) };
  for (const [key, value] of Object.entries({ artifactId, artifactKind, artifactRevision, producer })) if (value !== undefined) subject[key] = required(key, value);
  return Object.freeze(subject);
}

// Compatibility name for the first, artifact-only review-session slice.
export function createArtifactRevision({ producer, artifactId, revision }) {
  return Object.freeze({ producer: required("producer", producer), artifactId: required("artifactId", artifactId), revision: required("revision", revision) });
}

function subjectFor(input) {
  if (input.specId) return createSubjectRevision(input);
  // A legacy artifact is made into a stable generic subject without assigning
  // meaning to either identifier.
  return createSubjectRevision({ specId: input.artifactId, specRevision: input.revision, artifactId: input.artifactId, artifactRevision: input.revision, producer: input.producer });
}

function reviewPayload({ title, summary, verdict, context }) {
  return { title, summary, verdict, ...(context === undefined ? {} : { context }) };
}

export function createReviewSession({ subject, artifact, sessionId, reviewer, title = "", summary = "", verdict = "pending", idempotencyKey, context } = {}) {
  const pinnedSubject = subjectFor(subject ?? artifact ?? {});
  const id = sessionId ?? `review-${contentDigest({ pinnedSubject, reviewer: reviewer ?? "" })}`;
  return {
    type: "review_session",
    sessionId: required("sessionId", id),
    idempotencyKey: idempotencyKey ?? `review-${contentDigest({ id, pinnedSubject })}`,
    state: "open",
    subject: pinnedSubject,
    // Retained for old consumers; new code should use subject.
    artifact: artifact ? createArtifactRevision(artifact) : undefined,
    reviewer: reviewer ?? null,
    title, summary, verdict, context,
    comments: [], commentIds: [], receipts: [],
    summaryReview: null,
  };
}

function assertEditable(session) {
  if (!REVIEW_STATES.has(session?.state)) throw new TypeError("review-session: session required");
  if (session.state !== "open" && session.state !== "in_review") throw new Error("review-session: session is immutable after submission");
}

function sameSubject(a, b) { return a.specId === b.specId && a.specRevision === b.specRevision; }

/** Turn an individually privacy-reviewed feedback bundle into an immutable comment record. */
export function createReviewedComment({ commentId, reviewId, sequence, subject, bundle, replyTo, requestedDisposition } = {}) {
  if (!bundle?.reviewed || !bundle.idempotencyKey) throw new Error("review-session: only reviewed comments may be added");
  const pinnedSubject = subjectFor(subject ?? {});
  const record = {
    type: "review_comment", commentId: required("commentId", commentId ?? bundle.idempotencyKey),
    reviewId: required("reviewId", reviewId), sequence: Number.isInteger(sequence) && sequence >= 0 ? sequence : 0,
    subjectRevision: pinnedSubject.specRevision, subject: pinnedSubject,
    bundle: Object.freeze({ ...bundle }), ...(replyTo ? { replyTo: required("replyTo", replyTo) } : {}),
    ...(requestedDisposition ? { requestedDisposition: String(requestedDisposition) } : {}),
  };
  return Object.freeze(record);
}

export function addReviewedComment(session, bundleOrComment, options = {}) {
  assertEditable(session);
  const comment = bundleOrComment?.type === "review_comment"
    ? bundleOrComment
    : createReviewedComment({ reviewId: session.sessionId, subject: session.subject, sequence: session.comments.length, bundle: bundleOrComment, ...options });
  if (comment.reviewId !== session.sessionId) throw new Error("review-session: comment belongs to another review");
  if (!sameSubject(session.subject, comment.subject) || comment.subjectRevision !== session.subject.specRevision) throw new Error("review-session: cross-revision comments are rejected");
  if (session.commentIds.includes(comment.commentId)) return session; // comment-level idempotency
  session.comments.push(comment);
  session.commentIds.push(comment.commentId);
  session.comments.forEach((item, index) => { if (item.sequence !== index) session.comments[index] = Object.freeze({ ...item, sequence: index }); });
  return session;
}

export function removeComment(session, commentId) {
  assertEditable(session);
  const index = session.commentIds.indexOf(commentId);
  if (index >= 0) { session.commentIds.splice(index, 1); session.comments.splice(index, 1); session.comments.forEach((item, i) => { session.comments[i] = Object.freeze({ ...item, sequence: i }); }); }
  return session;
}

export function reorderComments(session, commentIds) {
  assertEditable(session);
  if (!Array.isArray(commentIds) || commentIds.length !== session.commentIds.length || new Set(commentIds).size !== commentIds.length || commentIds.some((id) => !session.commentIds.includes(id))) throw new Error("review-session: reorder must contain every comment ID exactly once");
  const byId = new Map(session.comments.map((c) => [c.commentId, c]));
  session.commentIds.splice(0, session.commentIds.length, ...commentIds);
  session.comments.splice(0, session.comments.length, ...commentIds.map((id, sequence) => Object.freeze({ ...byId.get(id), sequence })));
  return session;
}

export function setCommentDisposition(session, id, disposition) {
  assertEditable(session);
  const comment = session.comments.find((item) => item.commentId === id || item.bundle.idempotencyKey === id);
  if (!comment) throw new Error("review-session: comment is not in session");
  const index = session.comments.indexOf(comment);
  session.comments[index] = Object.freeze({ ...comment, requestedDisposition: String(disposition) });
  return session;
}

export function reviewSessionSummary(session, manifest) {
  assertEditable(session);
  session.state = "in_review";
  const payload = reviewPayload(session);
  const verdict = privacyVerdict(payload, manifest);
  session.summaryReview = Object.freeze({ payload: Object.freeze(payload), verdict, approved: false });
  return session.summaryReview;
}

export function approveSessionSummary(session, manifest) {
  const reviewed = reviewSessionSummary(session, manifest);
  if (!reviewed.verdict.ok) throw new Error("review-session: summary privacy fails closed");
  session.summaryReview = Object.freeze({ ...reviewed, approved: true });
  return session.summaryReview;
}

export async function submitReviewSession(session, router, { currentRevision, manifest } = {}) {
  if (session.state === "submitted" || session.state === "processing" || session.state === "resolved") return session.receipt;
  assertEditable(session);
  if (!session.comments.length) throw new Error("review-session: at least one reviewed comment is required");
  if (currentRevision && currentRevision !== session.subject.specRevision) throw new Error("review-session: stale target requires explicit rebase confirmation");
  if (manifest) approveSessionSummary(session, manifest);
  if (!session.summaryReview?.approved) throw new Error("review-session: reviewed summary approval is required");
  const payload = Object.freeze({ reviewed: true, kind: "review_session", sessionId: session.sessionId, subject: session.subject, reviewer: session.reviewer, title: session.title, summary: session.summary, verdict: session.verdict, commentIds: Object.freeze([...session.commentIds]), comments: Object.freeze([...session.comments]), idempotencyKey: session.idempotencyKey });
  const sinkReceipt = await router.submit(payload);
  session.state = "submitted";
  session.receipt = Object.freeze({ type: "review_receipt", receiptId: `receipt-${contentDigest({ session: session.sessionId, sinkReceipt })}`, reviewId: session.sessionId, phase: "submitted", idempotencyKey: session.idempotencyKey, sinkReceipt });
  session.receipts.push(session.receipt);
  return session.receipt;
}

export function appendReviewReceipt(session, { receiptId, phase, detail, idempotencyKey } = {}) {
  if (!["submitted", "processing", "resolved"].includes(phase)) throw new Error("review-session: receipt phase is invalid");
  const receipt = Object.freeze({ type: "review_receipt", receiptId: receiptId ?? `receipt-${contentDigest({ session: session.sessionId, phase, detail })}`, reviewId: session.sessionId, phase, ...(detail === undefined ? {} : { detail }), idempotencyKey: idempotencyKey ?? `receipt-${contentDigest({ session: session.sessionId, phase, detail })}` });
  if (session.receipts.some((item) => item.idempotencyKey === receipt.idempotencyKey)) return session.receipts.find((item) => item.idempotencyKey === receipt.idempotencyKey);
  session.receipts.push(receipt);
  if (phase === "processing") session.state = "processing";
  if (phase === "resolved") session.state = "resolved";
  return receipt;
}

export function closeReviewSession(session) { if (session.state !== "resolved" && session.state !== "open") throw new Error("review-session: only open or resolved sessions may close"); session.state = "closed"; return session; }
