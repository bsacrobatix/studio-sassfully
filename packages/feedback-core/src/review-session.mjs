import { contentDigest } from "./idempotency.mjs";

export function createArtifactRevision({ producer, artifactId, revision }) {
  for (const [key, value] of Object.entries({ producer, artifactId, revision })) if (typeof value !== "string" || !value) throw new TypeError(`review-session: ${key} is required`);
  return Object.freeze({ producer, artifactId, revision });
}
export function createReviewSession({ artifact, sessionId, summary = "", verdict = "pending" }) {
  const address = createArtifactRevision(artifact);
  return { state: "open", sessionId: sessionId ?? `review-${contentDigest(address)}`, artifact: address, summary, verdict, comments: [], dispositions: {} };
}
export function addReviewedComment(session, bundle) {
  if (session.state !== "open") throw new Error("review-session: session is immutable after submission");
  if (!bundle?.reviewed || !bundle.idempotencyKey) throw new Error("review-session: only reviewed comments may be added");
  if (session.comments.some((item) => item.idempotencyKey === bundle.idempotencyKey)) return session;
  session.comments.push(Object.freeze({ ...bundle })); return session;
}
export function setCommentDisposition(session, idempotencyKey, disposition) {
  if (session.state !== "open") throw new Error("review-session: session is immutable after submission");
  if (!session.comments.some((item) => item.idempotencyKey === idempotencyKey)) throw new Error("review-session: comment is not in session");
  session.dispositions[idempotencyKey] = String(disposition); return session;
}
export async function submitReviewSession(session, router, { currentRevision } = {}) {
  if (session.state !== "open") { if (session.state === "submitted") return session.receipt; throw new Error("review-session: cannot submit"); }
  if (!session.comments.length) throw new Error("review-session: at least one reviewed comment is required");
  if (currentRevision && currentRevision !== session.artifact.revision) throw new Error("review-session: artifact revision is stale");
  const payload = Object.freeze({ reviewed: true, kind: "review_session", artifact: session.artifact, summary: session.summary, verdict: session.verdict, comments: Object.freeze([...session.comments]), dispositions: Object.freeze({ ...session.dispositions }) });
  const bundle = Object.freeze({ ...payload, idempotencyKey: `review-${contentDigest(payload)}` });
  const sinkReceipt = await router.submit(bundle);
  session.state = "submitted";
  session.receipt = Object.freeze({ sessionId: session.sessionId, artifact: session.artifact, idempotencyKey: bundle.idempotencyKey, sinkReceipt, submitted: true });
  return session.receipt;
}
