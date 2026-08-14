#!/usr/bin/env node
// Local-only MCP transport for the deliberately narrow MV3 Story bridge.
// No browser-debugging port, network client, selector API, or result scraping
// is present here: Chrome remains the user-visible enforcement point.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import readline from "node:readline";
import { DEFAULT_BRIDGE_PORT, formatPairingToken, PAIRING_CODE_PATTERN, validateStoryCommand } from "../ext/story-bridge-policy.mjs";
import { createEmbeddedDemoDrafts } from "./embedded-demo-drafts.mjs";
import { createEmbeddedQADriver, validateQARequest } from "./embedded-qa-driver.mjs";

const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const values = (name) => args.reduce((found, arg, i) => (arg === name ? [...found, args[i + 1]] : found), []);
const port = Number(value("--port") ?? DEFAULT_BRIDGE_PORT);
const code = value("--pairing-code") ?? crypto.randomBytes(24).toString("base64url");
const allowEmbeddedDemo = args.includes("--allow-embedded-demo");
const daemonSocket = value("--daemon-socket");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("--port must be 1024-65535");
if (!PAIRING_CODE_PATTERN.test(code)) throw new Error("--pairing-code must be 24-128 base64url characters");

// --allow-origin is the whole opt-in: with none given, QA/demo targets stay
// loopback-only exactly as before. Each value must be a bare origin (scheme
// + host [+ port], no path) so an operator cannot accidentally allowlist a
// broader surface than intended.
const allowedOrigins = new Set(values("--allow-origin").map((raw) => {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`--allow-origin value is not a valid absolute URL: ${raw}`); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`--allow-origin must be http(s): ${raw}`);
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new Error(`--allow-origin must be a bare origin (scheme://host[:port]), not a URL with a path/query/hash: ${raw}`);
  return url.origin;
}));
// The credential travels as an env var NAME only -- never as an argv value,
// never logged, never printed. See embedded-qa-driver.mjs for where the
// named env var is actually read (once per qa_start against an allowlisted
// remote origin) and packages/feedback-extension/story-bridge/README.md /
// docs/embedded-demo-control.md for the operator-facing contract.
const authBearerEnv = value("--auth-bearer-env");
if (authBearerEnv != null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(authBearerEnv)) throw new Error("--auth-bearer-env must be a valid environment variable name");

let bridge = null;
// Embedded hosts use the same loopback server but a distinct, explicit
// session channel. This is not an automation backdoor: it accepts only a
// validated demo script and calls the page's resident demo API.
const embeddedSessions = new Map();
const embeddedSessionByPage = new Map();
const embeddedDrafts = createEmbeddedDemoDrafts({ validateScript: (script) => validateStoryCommand({ action: "demo_run", script }) });
const pending = new Map();
const QA_AUDIO_UNLOCK_TIMEOUT_MS = 10_000;
const QA_REPLAY_RUN_TIMEOUT_MS = 45_000;
const qaDriver = createEmbeddedQADriver({ narrate: async (text, qaSession) => {
  const session = embeddedSessionForQA(qaSession);
  if (!session) throw new Error("QA narration needs a bound embedded demo page with narration enabled");
  return callEmbeddedPage(session, "embedded-demo:qa-narrate", { text });
}, beforeScreenshot: async (qaSession) => {
  const session = embeddedSessionForQA(qaSession);
  if (session) await callEmbeddedPage(session, "embedded-demo:stop", {});
}, allowedOrigins, authBearerEnv });
function reply(id, result) { return { jsonrpc: "2.0", id, result }; }
function failure(id, message, code = -32602) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function websocketAccept(key) { return crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64"); }
function wsSend(socket, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  const header = bytes.length < 126 ? Buffer.from([0x81, bytes.length]) : Buffer.from([0x81, 126, bytes.length >> 8, bytes.length & 255]);
  socket.write(Buffer.concat([header, bytes]));
}
function embeddedPageIdentity(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    // A page served from an --allow-origin remote (e.g. staging) can bind an
    // embedded session identically to a loopback page. This is additive: with
    // no allowlist configured, `allowedOrigins` is empty and the boundary is
    // unchanged.
    if (!isLoopback && !allowedOrigins.has(url.origin)) return null;
    url.hash = "";
    // Only an MCP-owned QA browser receives this marker. Its application may
    // legitimately rewrite query state (for example `study=<id>`), which
    // cannot be allowed to detach the bound page. Preserve the marker as the
    // admission authority, but discard every application-owned query key.
    if (url.searchParams.get("__sassfully_qa_audio_test") === "1") {
      url.search = "__sassfully_qa_audio_test=1";
    }
    return url.href;
  } catch { return null; }
}
function embeddedSessionForQA(qaSession) {
  const identity = embeddedPageIdentity(qaSession?.url);
  const sessionId = identity && embeddedSessionByPage.get(identity);
  return sessionId ? embeddedSessions.get(sessionId) : null;
}
function removeEmbeddedSession(sessionId, expectedSocket = null) {
  const session = embeddedSessions.get(sessionId);
  if (!session || (expectedSocket && session.socket !== expectedSocket)) return;
  embeddedSessions.delete(sessionId);
  if (session.pageIdentity && embeddedSessionByPage.get(session.pageIdentity) === sessionId) embeddedSessionByPage.delete(session.pageIdentity);
}
function decodeFrames(state, chunk) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.length >= 2) {
    const first = state.buffer[0]; let length = state.buffer[1] & 127; const masked = Boolean(state.buffer[1] & 128); let offset = 2;
    if ((first & 15) !== 1 || !masked) { state.socket.destroy(); return; }
    if (length === 126) { if (state.buffer.length < 4) return; length = state.buffer.readUInt16BE(2); offset = 4; }
    if (length === 127 || state.buffer.length < offset + 4 + length) return;
    const mask = state.buffer.subarray(offset, offset + 4); offset += 4;
    const payload = Buffer.from(state.buffer.subarray(offset, offset + length));
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    state.buffer = state.buffer.subarray(offset + length);
    try { onBridgeMessage(state, JSON.parse(payload.toString("utf8"))); } catch { /* ignore malformed frames */ }
  }
}
function onBridgeMessage(state, message) {
  if (state.kind === "embedded") {
    if (message.type === "embedded-demo:hello" && typeof message.sessionId === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(message.sessionId)) {
      const pageIdentity = embeddedPageIdentity(message.url);
      if (!pageIdentity) return;
      // Vite/HMR can reinstall demo mode before the old WebSocket closes. The
      // current page identity has exactly one authority: a new hello replaces
      // its stale session, while close handlers cannot delete the replacement.
      const priorSessionId = embeddedSessionByPage.get(pageIdentity);
      if (priorSessionId && priorSessionId !== message.sessionId) removeEmbeddedSession(priorSessionId);
      removeEmbeddedSession(message.sessionId);
      embeddedSessions.set(message.sessionId, { id: message.sessionId, socket: state.socket, url: pageIdentity, pageIdentity, connectedAt: Date.now() });
      embeddedSessionByPage.set(pageIdentity, message.sessionId);
      return wsSend(state.socket, { type: "embedded-demo:ready", sessionId: message.sessionId });
    }
  }
  if (message.type === "result" && pending.has(message.id)) {
    const { resolve } = pending.get(message.id); pending.delete(message.id); resolve(message);
  }
}
// Every handshake outcome is logged with a reason: a burned pairing attempt
// must never be indistinguishable from "the extension never tried".
const log = (line) => process.stderr.write(`Sassfully Story bridge: ${line}\n`);
const server = net.createServer((socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  let head = Buffer.alloc(0); let upgraded = false;
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk) => {
    if (upgraded) return decodeFrames(socket._sassfully, chunk);
    head = Buffer.concat([head, chunk]); const marker = head.indexOf("\r\n\r\n"); if (marker < 0) return;
    const request = head.subarray(0, marker).toString("utf8"); const remainder = head.subarray(marker + 4);
    const [requestLine, ...lines] = request.split("\r\n"); const headers = Object.fromEntries(lines.map((line) => { const i = line.indexOf(":"); return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()]; }));
    const requestUrl = new URL(requestLine.split(" ")[1], "http://127.0.0.1");
    log(`handshake attempt from ${peer} for ${requestUrl.pathname}`);
    const reject = (reason) => { log(`rejected handshake from ${peer}: ${reason}`); socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); };
    if (requestUrl.pathname !== "/bridge" && requestUrl.pathname !== "/embedded-demo") return reject("unexpected path");
    if (requestUrl.pathname === "/bridge" && requestUrl.searchParams.get("code") !== code) return reject("pairing code mismatch");
    if (requestUrl.pathname === "/embedded-demo" && !allowEmbeddedDemo) return reject("embedded demo mode was not enabled on this local bridge");
    if (!headers["sec-websocket-key"]) return reject("not a WebSocket upgrade request");
    // A cleanly closed (or dead) previous connection frees the slot for the
    // extension to reconnect; only a concurrent second connection is refused.
    if (requestUrl.pathname === "/bridge" && bridge && !bridge.destroyed && !bridge.closed) return reject("another bridge connection is already active");
    if (requestUrl.pathname === "/bridge" && bridge) log("replacing a defunct bridge connection");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${websocketAccept(headers["sec-websocket-key"])}\r\n\r\n`);
    upgraded = true;
    socket._sassfully = { socket, buffer: Buffer.alloc(0), kind: requestUrl.pathname === "/bridge" ? "extension" : "embedded" };
    if (socket._sassfully.kind === "extension") bridge = socket;
    log(`accepted bridge connection from ${peer} (${socket._sassfully.kind})`);
    socket.on("close", () => {
      log(`${socket._sassfully.kind} bridge connection from ${peer} closed`);
      if (bridge === socket) bridge = null;
      for (const [sessionId, session] of embeddedSessions) if (session.socket === socket) removeEmbeddedSession(sessionId, socket);
    });
    if (remainder.length) decodeFrames(socket._sassfully, remainder);
  });
});
server.on("error", (error) => {
  process.stderr.write(`Sassfully Story bridge could not listen on 127.0.0.1:${port}: ${error.code ?? error.message}\n`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  log(`listening on ws://127.0.0.1:${port}`);
  process.stderr.write(`Sassfully Story pairing token: ${formatPairingToken({ port, code })}\n`);
});

const tools = [
  { name: "linkedin_story", description: "Autonomous control of the one loopback-paired Chrome tab. Pairing is the authorization; no per-action modal is shown.", inputSchema: { type: "object", properties: { action: { enum: ["navigate", "snapshot", "click", "fill", "press", "extract", "run_script", "demo_run", "demo_stop"] }, url: { type: "string" }, selector: { type: "string" }, target: { type: "string", description: "Accessible label for click when no selector is supplied" }, text: { type: "string" }, key: { type: "string" }, captureEvidence: { type: "boolean" }, steps: { type: "array" }, script: { type: "object" } }, required: ["action"], additionalProperties: false } },
  { name: "embedded_demo", description: `Local demoMode tour plus owned headed/headless Chromium QA. QA has typed controls, explicit raw CDP, and bounded console/network-body HAR evidence; all are restricted to the one loopback page launched by this MCP${allowedOrigins.size ? ` or an explicitly allowlisted remote origin (${[...allowedOrigins].join(", ")})` : ""} and cannot attach targets or navigate elsewhere. qa_test_narrated_replay is a test-only, two-run CDP audio path: qa_start must load __sassfully_qa_audio_test=1; normal tours still require a human click. Screenshots clear the presenter; narration is overlay-free.`, inputSchema: { type: "object", properties: { action: { enum: ["sessions", "propose", "validate", "update", "push", "run", "stop", "resume", "evidence_start", "evidence_stop", "evidence_export", "qa_start", "qa_action", "qa_cdp", "qa_events", "qa_capture_start", "qa_capture_export", "qa_har_export", "qa_test_narrated_replay", "qa_stop"] }, sessionId: { type: "string" }, draftId: { type: "string" }, revision: { type: "number" }, permission: { type: "boolean" }, script: { type: "object" }, url: { type: "string", description: "qa_start only: absolute loopback app URL, or a URL on an --allow-origin allowlisted remote origin" }, mode: { enum: ["headed", "headless"] }, qaSessionId: { type: "string" }, operation: { enum: ["snapshot", "click", "fill", "press", "screenshot"] }, selector: { type: "string" }, text: { type: "string" }, key: { type: "string" }, narration: { type: "string" }, method: { type: "string", description: "qa_cdp only: CDP command on the owned attached page session" }, params: { type: "object" }, since: { type: "integer", minimum: 0 }, runs: { type: "integer", enum: [2] } }, required: ["action"], additionalProperties: false } },
];
function callBridge(command) {
  const check = validateStoryCommand(command); if (!check.ok) return Promise.reject(new Error(check.error));
  if (!bridge) return Promise.reject(new Error("No user-paired Chrome tab is connected to the loopback bridge"));
  const id = crypto.randomUUID(); wsSend(bridge, { type: "command", id, command });
  return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error("Timed out waiting for the paired Chrome tab")); }, 120000); pending.set(id, { resolve: (result) => { clearTimeout(timer); result.ok ? resolve(result.result) : reject(new Error(result.error ?? "Chrome refused the request")); } }); });
}
function callEmbedded(args) {
  if (["qa_start", "qa_action", "qa_cdp", "qa_events", "qa_capture_start", "qa_capture_export", "qa_har_export", "qa_test_narrated_replay", "qa_stop"].includes(args.action)) {
    const error = validateQARequest(args, { allowedOrigins }); if (error) return Promise.reject(new Error(error));
    if (args.action === "qa_start") return qaDriver.start(args);
    if (args.action === "qa_action") return qaDriver.action(args);
    if (args.action === "qa_cdp") return qaDriver.cdp(args);
    if (args.action === "qa_events") return Promise.resolve(qaDriver.events(args.qaSessionId, args));
    if (args.action === "qa_capture_start") return qaDriver.captureStart(args.qaSessionId);
    if (args.action === "qa_capture_export") return qaDriver.captureExport(args.qaSessionId);
    if (args.action === "qa_har_export") return qaDriver.harExport(args.qaSessionId);
    if (args.action === "qa_test_narrated_replay") return qaTestNarratedReplay(args);
    return qaDriver.stop(args.qaSessionId);
  }
  if (args.action === "sessions") return Promise.resolve({ sessions: [...embeddedSessions.entries()].map(([sessionId, s]) => ({ sessionId, url: s.url, connectedAt: s.connectedAt })) });
  if (args.action === "propose") return Promise.resolve(embeddedDrafts.propose(args.script));
  if (args.action === "update") return Promise.resolve(embeddedDrafts.update(args));
  const session = embeddedSessions.get(args.sessionId);
  if (!session) return Promise.reject(new Error("No bound embedded demo session with that id"));
  if (args.action === "validate") {
    const draft = embeddedDrafts.get(args);
    return callEmbeddedPage(session, "embedded-demo:validate", { script: draft.script }).then((result) => embeddedDrafts.recordValidation({ draftId: draft.draftId, revision: draft.revision, sessionId: args.sessionId, result }));
  }
  if (args.action === "push") {
    const draft = embeddedDrafts.pushable(args);
    return callEmbeddedPage(session, "embedded-demo:run", { script: draft.script }).then((result) => ({ draftId: draft.draftId, revision: draft.revision, sessionId: args.sessionId, ...result }));
  }
  if (args.action === "resume") return callEmbeddedPage(session, "embedded-demo:resume", {}).then((result) => ({ sessionId: args.sessionId, ...result }));
  if (args.action === "run") {
    const check = validateStoryCommand({ action: "demo_run", script: args.script });
    if (!check.ok) return Promise.reject(new Error(check.error));
  } else if (args.action.startsWith("evidence_")) return callEmbeddedPage(session, "embedded-demo:evidence", { action: args.action.slice("evidence_".length), permission: args.permission === true });
  else if (args.action !== "stop") return Promise.reject(new Error("embedded_demo action is not supported"));
  return callEmbeddedPage(session, args.action === "run" ? "embedded-demo:run" : "embedded-demo:stop", { script: args.script }).then((result) => ({ sessionId: args.sessionId, ...result }));
}
async function qaTestNarratedReplay(args) {
  const session = embeddedSessions.get(args.sessionId);
  if (!session) throw new Error("qa_test_narrated_replay requires a bound embedded demo session");
  const qa = await qaDriver.activateTestAudio(args.qaSessionId);
  if (session.pageIdentity !== embeddedPageIdentity(qa.url)) throw new Error("qa_test_narrated_replay embedded session is not bound to this QA page");
  const diagnostics = { format: "sassfully/qa-narrated-replay-diagnostics/v1", qaSessionId: args.qaSessionId, sessionId: args.sessionId, page: session.url, phases: [] };
  const phaseCall = async (phase, type, payload, timeoutMs) => {
    const startedAt = new Date().toISOString(); const started = Date.now();
    try {
      const result = await callEmbeddedPage(session, type, payload, { phase, timeoutMs });
      diagnostics.phases.push({ phase, status: "completed", startedAt, durationMs: Date.now() - started });
      return result;
    } catch (error) {
      diagnostics.phases.push({ phase, status: "failed", startedAt, durationMs: Date.now() - started, error: error.message });
      throw new Error(`qa_test_narrated_replay ${phase} failed; diagnostics=${JSON.stringify(diagnostics)}`);
    }
  };
  const unlockResult = await phaseCall("audio_unlock", "embedded-demo:qa-audio-unlock", { qaSessionId: args.qaSessionId, embeddedSessionId: args.sessionId }, QA_AUDIO_UNLOCK_TIMEOUT_MS);
  const audioUnlock = unlockResult?.audioUnlock;
  if (audioUnlock?.unlocked !== true || audioUnlock?.source !== "qa-cdp") throw new Error("qa_test_narrated_replay did not receive a qa-cdp audio unlock receipt");
  const runs = [];
  for (let index = 0; index < args.runs; index += 1) {
    const result = await phaseCall(`run_${index + 1}`, "embedded-demo:run", { script: args.script }, QA_REPLAY_RUN_TIMEOUT_MS);
    const demo = result?.demo;
    const narration = demo?.media?.narration ?? [];
    const presentation = demo?.media?.presentation ?? [];
    const expectedNarration = args.script.steps.filter((step) => typeof step.narration === "string").length;
    const started = narration.filter((item) => item.status === "started").length;
    const ended = narration.filter((item) => item.status === "ended").length;
    if (demo?.completed !== true || started !== expectedNarration || ended !== expectedNarration) throw new Error(`qa_test_narrated_replay run ${index + 1} did not complete every narration (started ${started}/${expectedNarration}, ended ${ended}/${expectedNarration})`);
    if (presentation.filter((item) => item.kind === "spotlight" && item.status === "shown").length !== args.script.steps.filter((step) => step.spotlight).length) throw new Error(`qa_test_narrated_replay run ${index + 1} did not show every spotlight`);
    if (presentation.filter((item) => item.kind === "caption" && item.status === "shown").length !== args.script.steps.filter((step) => step.caption).length) throw new Error(`qa_test_narrated_replay run ${index + 1} did not show every caption`);
    runs.push({ index: index + 1, completedSteps: demo.completedSteps, narration: { expected: expectedNarration, started, ended }, presentation, completed: true });
  }
  return { qaSessionId: args.qaSessionId, sessionId: args.sessionId, testOnly: true, audioUnlock: { ...qa, page: audioUnlock }, runs, diagnostics };
}
function callEmbeddedPage(session, type, payload, { phase = type, timeoutMs = 120_000 } = {}) {
  if (!session?.socket || session.socket.destroyed || session.socket.closed) throw new Error(`embedded bridge phase ${phase} cannot send: bound session ${session?.id ?? "unknown"} is closed`);
  const id = crypto.randomUUID();
  try { wsSend(session.socket, { type, id, ...payload }); }
  catch (error) { throw new Error(`embedded bridge phase ${phase} could not send to ${session.id}: ${error.message}`); }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`embedded bridge phase ${phase} timed out after ${timeoutMs}ms waiting for session ${session.id} at ${session.url ?? "unknown"}`));
    }, timeoutMs);
    pending.set(id, { resolve: (result) => { clearTimeout(timer); result.ok ? resolve(result.result) : reject(new Error(result.error ?? "embedded page refused the script")); } });
  });
}
async function handleMcp(request) {
  if (request.method === "initialize") return reply(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "sassfully-linkedin-story", version: "0.1.0" } });
  if (request.method === "notifications/initialized") return null;
  if (request.method === "tools/list") return reply(request.id, { tools });
  if (request.method === "tools/call") {
    const name = request.params?.name;
    if (name !== "linkedin_story" && name !== "embedded_demo") return failure(request.id, "Unknown tool", -32601);
    try {
      const result = await (name === "embedded_demo" ? callEmbedded(request.params.arguments ?? {}) : callBridge(request.params.arguments ?? {}));
      return reply(request.id, { content: [{ type: "text", text: JSON.stringify(result) }] });
    } catch (error) { return reply(request.id, { isError: true, content: [{ type: "text", text: error.message }] }); }
  }
  if (request.id != null) return failure(request.id, "Method not found", -32601);
  return null;
}

function attachMcpLines(input, send) {
  readline.createInterface({ input, crlfDelay: Infinity }).on("line", async (line) => {
    let request; try { request = JSON.parse(line); } catch { return; }
    const response = await handleMcp(request);
    if (response) send(`${JSON.stringify(response)}\n`);
  });
}

if (daemonSocket) {
  // The daemon is intentionally local-only and owns the bridge port once.
  // MCP clients connect through their own stdio relay, never to this socket.
  if (process.platform !== "win32" && fs.existsSync(daemonSocket)) {
    process.stderr.write(`Sassfully Story bridge daemon socket already exists: ${daemonSocket}\n`);
    process.exit(1);
  }
  const mcpServer = net.createServer((socket) => attachMcpLines(socket, (line) => socket.write(line)));
  mcpServer.on("error", (error) => {
    process.stderr.write(`Sassfully Story bridge daemon could not listen on ${daemonSocket}: ${error.code ?? error.message}\n`);
    process.exit(1);
  });
  mcpServer.listen(daemonSocket, () => {
    if (process.platform !== "win32") fs.chmodSync(daemonSocket, 0o600);
    process.stderr.write(`Sassfully Story bridge daemon listening on ${daemonSocket}\n`);
  });
} else {
  attachMcpLines(process.stdin, (line) => process.stdout.write(line));
}
