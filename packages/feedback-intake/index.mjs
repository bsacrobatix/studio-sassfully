import http from "node:http";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KINDS } from "../feedback-core/src/kinds.mjs";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_USER_TEXT = 8 * 1024;
const MAX_LABEL = 500;
const MAX_ID = 500;
const MAX_DEDUPE = 10_000;

function monthFile(dataDir, now = new Date()) {
  return path.join(dataDir, `feedback-${now.toISOString().slice(0, 7)}.jsonl`);
}
function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
function stringWithin(value, max) { return typeof value === "string" && value.length > 0 && value.length <= max; }
function validationError(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return "body must be a JSON object";
  if (bundle.reviewed !== true) return "reviewed must be true";
  if (!KINDS.includes(bundle.kind)) return "kind is not allowed";
  if (!bundle.anchor || !stringWithin(bundle.anchor.producer, MAX_ID) || !stringWithin(bundle.anchor.artifactId, MAX_ID)) return "anchor producer and artifactId are required strings";
  if (!stringWithin(bundle.idempotencyKey, MAX_ID)) return "idempotencyKey is required";
  if (typeof bundle.userText !== "string" || bundle.userText.length > MAX_USER_TEXT) return "userText must be a string within the size limit";
  if (bundle.anchor.label !== undefined && (!stringWithin(bundle.anchor.label, MAX_LABEL))) return "anchor label exceeds the size limit";
  if (Array.isArray(bundle.evidence) && bundle.evidence.some((item) => item?.label !== undefined && !stringWithin(item.label, MAX_LABEL))) return "evidence label exceeds the size limit";
  return null;
}
async function readJsonBody(req) {
  const length = Number(req.headers["content-length"] || 0);
  if (length > MAX_BODY_BYTES) { const error = new Error("body too large"); error.status = 413; throw error; }
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) { const error = new Error("body too large"); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { const error = new Error("malformed JSON"); error.status = 400; throw error; }
}

class TokenBuckets {
  constructor({ minuteLimit = 10, dayLimit = 100, now = () => Date.now() } = {}) { this.minuteLimit = minuteLimit; this.dayLimit = dayLimit; this.now = now; this.byIp = new Map(); }
  take(ip) {
    const now = this.now(); const day = new Date(now).toISOString().slice(0, 10);
    const entry = this.byIp.get(ip) ?? { minuteStarted: now, minute: 0, day, daily: 0 };
    if (now - entry.minuteStarted >= 60_000) { entry.minuteStarted = now; entry.minute = 0; }
    if (entry.day !== day) { entry.day = day; entry.daily = 0; }
    if (entry.minute >= this.minuteLimit || entry.daily >= this.dayLimit) return false;
    entry.minute += 1; entry.daily += 1; this.byIp.set(ip, entry); return true;
  }
}

/** Append-only review persistence.  The in-memory indexes are deliberately
 * rebuilt solely from JSONL events so a restart has no hidden state. */
export class ReviewStore {
  constructor({ dataDir, now = () => Date.now() }) { this.dataDir = dataDir; this.now = now; this.reviews = new Map(); this.keys = new Map(); }
  async load() {
    let files = [];
    try { files = (await readdir(this.dataDir)).filter((name) => /^feedback-\d{4}-\d{2}\.jsonl$/.test(name)); } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const name of files.sort()) for (const line of (await readFile(path.join(this.dataDir, name), "utf8")).split("\n")) if (line) this.apply(JSON.parse(line));
    return this;
  }
  apply(event) {
    if (!event?.type?.startsWith("review.")) return;
    if (event.idempotencyKey && this.keys.has(event.idempotencyKey)) return;
    if (event.type === "review.create") this.reviews.set(event.review.sessionId, { ...event.review, comments: [], commentIds: [], receipts: [] });
    const review = this.reviews.get(event.reviewId);
    if (event.type === "review.comment" && review && !review.commentIds.includes(event.comment.commentId)) { review.comments.push(event.comment); review.commentIds.push(event.comment.commentId); }
    if (event.type === "review.finalize" && review) { Object.assign(review, event.review, { state: "submitted" }); }
    if (event.type === "review.receipt" && review && !review.receipts.some((item) => item.idempotencyKey === event.receipt.idempotencyKey)) { review.receipts.push(event.receipt); review.state = event.receipt.phase === "resolved" ? "resolved" : event.receipt.phase === "processing" ? "processing" : review.state; }
    if (event.idempotencyKey) this.keys.set(event.idempotencyKey, event.receipt ?? { ref: event.reviewId ?? event.review?.sessionId, deduped: true });
  }
  async append(event) {
    if (event.idempotencyKey && this.keys.has(event.idempotencyKey)) return { ...this.keys.get(event.idempotencyKey), deduped: true };
    const receivedAt = new Date(this.now()).toISOString();
    await appendFile(monthFile(this.dataDir, new Date(receivedAt)), `${JSON.stringify({ ...event, receivedAt })}\n`, "utf8");
    this.apply(event);
    return event.receipt ?? { ref: event.reviewId ?? event.review?.sessionId };
  }
  create(review) { if (!review?.sessionId || !review?.subject?.specId || !review?.subject?.specRevision) throw new Error("review requires sessionId and pinned subject revision"); return this.append({ type: "review.create", review, idempotencyKey: review.idempotencyKey ?? `review-create-${review.sessionId}` }); }
  addComment(reviewId, comment) { const review = this.reviews.get(reviewId); if (!review) throw new Error("review not found"); if (review.state !== "open" && review.state !== "in_review") throw new Error("review is immutable after submission"); if (!comment?.commentId || !comment?.bundle?.reviewed) throw new Error("reviewed comment required"); if (comment.subjectRevision !== review.subject.specRevision) throw new Error("cross-revision comment rejected"); return this.append({ type: "review.comment", reviewId, comment, idempotencyKey: comment.bundle.idempotencyKey }); }
  finalize(reviewId, review, idempotencyKey) { const saved = this.reviews.get(reviewId); if (!saved) throw new Error("review not found"); if (!saved.comments.length) throw new Error("review needs a comment"); if (!review?.summaryReview?.approved) throw new Error("review summary approval required"); return this.append({ type: "review.finalize", reviewId, review, idempotencyKey: idempotencyKey ?? review.idempotencyKey ?? `review-finalize-${reviewId}` }); }
  receipt(reviewId, receipt) { if (!this.reviews.has(reviewId)) throw new Error("review not found"); if (!receipt?.phase || !receipt?.idempotencyKey) throw new Error("receipt phase and idempotencyKey required"); return this.append({ type: "review.receipt", reviewId, receipt, idempotencyKey: receipt.idempotencyKey }); }
  list(specId, specRevision) { return [...this.reviews.values()].filter((review) => review.subject.specId === specId && (!specRevision || review.subject.specRevision === specRevision)); }
}

/** Build a standalone server. IPs exist only in the in-memory rate limiter. */
export async function createIntakeServer({ dataDir, rateLimits, now } = {}) {
  if (!dataDir) throw new TypeError("feedback-intake: dataDir is required");
  await mkdir(dataDir, { recursive: true });
  const reviewStore = await new ReviewStore({ dataDir, now: now ?? (() => Date.now()) }).load();
  const seen = new Map();
  const remember = (key, receipt) => { seen.set(key, receipt); if (seen.size > MAX_DEDUPE) seen.delete(seen.keys().next().value); };
  try {
    for (const line of (await readFile(monthFile(dataDir), "utf8")).split("\n")) {
      if (!line) continue;
      const item = JSON.parse(line);
      if (item.idempotencyKey) remember(item.idempotencyKey, { ref: item.idempotencyKey, deduped: true });
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const buckets = new TokenBuckets({ ...rateLimits, now });
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/api/feedback/health") return json(res, 200, { ok: true });
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/reviews") return json(res, 200, { reviews: reviewStore.list(url.searchParams.get("specId"), url.searchParams.get("specRevision")) });
    const match = url.pathname.match(/^\/api\/reviews\/([^/]+)(?:\/(comments|finalize|receipts))?$/);
    if (req.method === "GET" && match && !match[2]) { const review = reviewStore.reviews.get(decodeURIComponent(match[1])); return review ? json(res, 200, review) : json(res, 404, { error: "review not found" }); }
    if (req.method === "POST" && (url.pathname === "/api/reviews" || match)) {
      if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
      try {
        const body = await readJsonBody(req); let receipt;
        if (url.pathname === "/api/reviews") receipt = await reviewStore.create(body);
        else if (match[2] === "comments") receipt = await reviewStore.addComment(decodeURIComponent(match[1]), body);
        else if (match[2] === "finalize") receipt = await reviewStore.finalize(decodeURIComponent(match[1]), body, req.headers["idempotency-key"]);
        else if (match[2] === "receipts") receipt = await reviewStore.receipt(decodeURIComponent(match[1]), body);
        else return json(res, 404, { error: "not found" });
        return json(res, receipt.deduped ? 200 : 201, receipt);
      } catch (error) { return json(res, /not found/.test(error.message) ? 404 : 422, { error: error.message }); }
    }
    if (req.method !== "POST" || url.pathname !== "/api/feedback") return json(res, 404, { error: "not found" });
    if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
    try {
      const bundle = await readJsonBody(req);
      const invalid = validationError(bundle);
      if (invalid) return json(res, 422, { error: invalid });
      if (seen.has(bundle.idempotencyKey)) return json(res, 200, seen.get(bundle.idempotencyKey));
      if (!buckets.take(req.socket.remoteAddress || "unknown")) return json(res, 429, { error: "rate limit exceeded" });
      const receivedAt = new Date(now ? now() : Date.now()).toISOString();
      await appendFile(monthFile(dataDir, new Date(receivedAt)), `${JSON.stringify({ ...bundle, receivedAt })}\n`, "utf8");
      const receipt = { ref: bundle.idempotencyKey };
      remember(bundle.idempotencyKey, receipt);
      return json(res, 201, receipt);
    } catch (error) { return json(res, error.status || 500, { error: error.message === "malformed JSON" || error.message === "body too large" ? error.message : "internal error" }); }
  });
  return server;
}

async function main() {
  const dataDir = process.env.FEEDBACK_INTAKE_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
  const port = Number(process.env.FEEDBACK_INTAKE_PORT || 8787);
  const server = await createIntakeServer({ dataDir });
  server.listen(port, () => console.log(`feedback-intake listening on ${port}`));
}
const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && (path.resolve(process.argv[1]) === thisFile || path.resolve(process.argv[1]) === path.dirname(thisFile))) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
