import http from "node:http";
import { appendFile, mkdir, readFile } from "node:fs/promises";
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

/** Build a standalone server. IPs exist only in the in-memory rate limiter. */
export async function createIntakeServer({ dataDir, rateLimits, now } = {}) {
  if (!dataDir) throw new TypeError("feedback-intake: dataDir is required");
  await mkdir(dataDir, { recursive: true });
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
    if (req.method !== "POST" || req.url !== "/api/feedback") return json(res, 404, { error: "not found" });
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
