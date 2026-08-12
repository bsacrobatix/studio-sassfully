import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateQARequest } from "../story-bridge/embedded-qa-driver.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const serverPath = `${root}story-bridge/stdio-server.mjs`;
const code = "abcdefghijklmnopqrstuvwxyzABCDEF12";

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

function startBridge(port, extraArgs = []) {
  const child = spawn(process.execPath, [serverPath, "--port", String(port), "--pairing-code", code, ...extraArgs], { stdio: ["pipe", "pipe", "pipe"] });
  const state = { child, stderr: "", stdout: "" };
  child.stderr.on("data", (chunk) => { state.stderr += chunk; });
  child.stdout.on("data", (chunk) => { state.stdout += chunk; });
  state.untilStderr = (pattern, timeoutMs = 5000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (pattern.test(state.stderr)) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`stderr never matched ${pattern}:\n${state.stderr}`));
      setTimeout(poll, 25);
    };
    poll();
  });
  return state;
}

// Minimal raw WebSocket client handshake — enough to observe accept/reject.
function dialBridge(port, pairingCode, path = "/bridge") {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("connect", () => socket.write(`GET ${path}${pairingCode ? `?code=${pairingCode}` : ""} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    socket.once("data", (chunk) => resolve({ socket, status: Number(chunk.toString("utf8").split(" ")[1]) }));
    socket.on("error", reject);
  });
}

function wsClientSend(socket, body) {
  const bytes = Buffer.from(JSON.stringify(body)); const mask = crypto.randomBytes(4);
  const header = bytes.length < 126
    ? Buffer.from([0x81, 0x80 | bytes.length])
    : Buffer.from([0x81, 0x80 | 126, bytes.length >> 8, bytes.length & 255]);
  const payload = Buffer.from(bytes);
  for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  socket.write(Buffer.concat([header, mask, payload]));
}
function nextWsMessage(socket) {
  return new Promise((resolve) => socket.once("data", (chunk) => {
    let length = chunk[1] & 127; let offset = 2;
    if (length === 126) { length = chunk.readUInt16BE(offset); offset += 2; }
    resolve(JSON.parse(chunk.subarray(offset, offset + length).toString("utf8")));
  }));
}
function nextMcp(state, started = state.stdout.length) {
  return new Promise((resolve, reject) => { const tick = () => { const line = state.stdout.slice(started).trim().split("\n").at(-1); if (line) return resolve(JSON.parse(line)); setTimeout(tick, 10); }; setTimeout(() => reject(new Error("MCP reply timed out")), 3000); tick(); });
}
const embeddedRequest = (id, arguments_) => `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "embedded_demo", arguments: arguments_ } })}\n`;

test("embedded QA contract is loopback-only and raw CDP stays scoped to a named QA session", () => {
  assert.equal(validateQARequest({ action: "qa_start", url: "http://127.0.0.1:8932/", mode: "headless" }), null);
  assert.equal(validateQARequest({ action: "qa_start", url: "https://example.com/", mode: "headless" }), "qa_start.url must be an absolute loopback http(s) URL");
  assert.equal(validateQARequest({ action: "qa_action", qaSessionId: "qa-1", operation: "screenshot" }), null);
  assert.match(validateQARequest({ action: "qa_action", qaSessionId: "qa-1", operation: "evaluate" }), /operation must be/);
  assert.equal(validateQARequest({ action: "qa_cdp", qaSessionId: "qa-1", method: "Runtime.evaluate", params: { expression: "document.title" } }), null);
  assert.match(validateQARequest({ action: "qa_cdp", method: "Runtime.evaluate" }), /qaSessionId/);
});

test("stdio bridge reports an occupied loopback port instead of failing its MCP handshake silently", async () => {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  const child = spawn(process.execPath, [serverPath, "--port", String(port), "--pairing-code", code], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [exitCode] = await once(child, "exit");
  await new Promise((resolve) => listener.close(resolve));
  assert.equal(exitCode, 1);
  assert.match(stderr, new RegExp(`could not listen on 127\\.0\\.0\\.1:${port}: EADDRINUSE`));
});

test("stdio bridge prints ONE combined <port>.<code> pairing token on startup", async () => {
  const port = await freePort();
  const bridge = startBridge(port);
  try {
    await bridge.untilStderr(new RegExp(`Sassfully Story pairing token: ${port}\\.${code}`));
  } finally { bridge.child.kill(); await once(bridge.child, "exit"); }
});

test("extension can reconnect after a clean close; every handshake outcome is logged", async () => {
  const port = await freePort();
  const bridge = startBridge(port);
  try {
    await bridge.untilStderr(/listening on ws:/);

    const wrong = await dialBridge(port, "wrongwrongwrongwrongwrongwrong12");
    assert.equal(wrong.status, 403, "a bad code is refused");
    await bridge.untilStderr(/rejected handshake from [^\n]*: pairing code mismatch/);
    wrong.socket.destroy();

    const first = await dialBridge(port, code);
    assert.equal(first.status, 101, "first pairing succeeds");
    await bridge.untilStderr(/accepted bridge connection/);

    const concurrent = await dialBridge(port, code);
    assert.equal(concurrent.status, 403, "a concurrent second connection is refused");
    await bridge.untilStderr(/rejected handshake from [^\n]*: another bridge connection is already active/);
    concurrent.socket.destroy();

    first.socket.destroy();
    await bridge.untilStderr(/bridge connection from [^\n]* closed/);

    const second = await dialBridge(port, code);
    assert.equal(second.status, 101, "the slot is NOT burned: reconnect after close succeeds");
    second.socket.destroy();
  } finally { bridge.child.kill(); await once(bridge.child, "exit"); }
});

test("embedded MCP lifecycle proposes, validates, updates, and pushes to a resident page without navigation", async () => {
  const port = await freePort(); const bridge = startBridge(port, ["--allow-embedded-demo"]);
  try {
    await bridge.untilStderr(/listening on ws:/);
    const page = await dialBridge(port, null, "/embedded-demo"); assert.equal(page.status, 101);
    wsClientSend(page.socket, { type: "embedded-demo:hello", sessionId: "embedded-page-1", url: "http://127.0.0.1:7894/?demo=1" });
    await nextWsMessage(page.socket);
    let start = bridge.stdout.length;
    bridge.child.stdin.write(embeddedRequest(1, { action: "propose", script: { steps: [{ caption: "draft" }] } }));
    const proposed = JSON.parse((await nextMcp(bridge, start)).result.content[0].text); assert.equal(proposed.revision, 1);
    start = bridge.stdout.length;
    bridge.child.stdin.write(embeddedRequest(2, { action: "validate", sessionId: "embedded-page-1", draftId: proposed.draftId, revision: 1 }));
    const validation = await nextWsMessage(page.socket); assert.equal(validation.type, "embedded-demo:validate");
    wsClientSend(page.socket, { type: "result", id: validation.id, ok: true, result: { ok: true, drift: [], errors: [] } });
    await nextMcp(bridge, start);
    start = bridge.stdout.length;
    bridge.child.stdin.write(embeddedRequest(3, { action: "update", draftId: proposed.draftId, revision: 1, script: { steps: [{ caption: "revised" }] } }));
    const updated = JSON.parse((await nextMcp(bridge, start)).result.content[0].text); assert.equal(updated.revision, 2);
    start = bridge.stdout.length;
    bridge.child.stdin.write(embeddedRequest(4, { action: "validate", sessionId: "embedded-page-1", draftId: proposed.draftId, revision: 2 }));
    const revalidation = await nextWsMessage(page.socket); wsClientSend(page.socket, { type: "result", id: revalidation.id, ok: true, result: { ok: true, drift: [], errors: [] } }); await nextMcp(bridge, start);
    start = bridge.stdout.length;
    bridge.child.stdin.write(embeddedRequest(5, { action: "evidence_start", sessionId: "embedded-page-1", permission: true }));
    const evidenceStart = await nextWsMessage(page.socket); assert.deepEqual({ type: evidenceStart.type, action: evidenceStart.action, permission: evidenceStart.permission }, { type: "embedded-demo:evidence", action: "start", permission: true });
    wsClientSend(page.socket, { type: "result", id: evidenceStart.id, ok: true, result: { active: true } });
    assert.equal(JSON.parse((await nextMcp(bridge, start)).result.content[0].text).active, true);
    start = bridge.stdout.length;
    bridge.child.stdin.write(embeddedRequest(6, { action: "push", sessionId: "embedded-page-1", draftId: proposed.draftId, revision: 2 }));
    const push = await nextWsMessage(page.socket); assert.equal(push.type, "embedded-demo:run"); assert.equal(push.script.steps[0].caption, "revised");
    wsClientSend(page.socket, { type: "result", id: push.id, ok: true, result: { demo: { completed: true, media: { stage: [{ status: "mounted" }], narration: [{ status: "blocked", mode: "fallback" }] } }, drift: [] } });
    const pushed = JSON.parse((await nextMcp(bridge, start)).result.content[0].text); assert.equal(pushed.revision, 2);
    assert.equal(pushed.demo.media.stage[0].status, "mounted");
    start = bridge.stdout.length;
    bridge.child.stdin.write(embeddedRequest(7, { action: "evidence_stop", sessionId: "embedded-page-1" }));
    const evidenceStop = await nextWsMessage(page.socket); wsClientSend(page.socket, { type: "result", id: evidenceStop.id, ok: true, result: { active: false, stampCount: 3 } }); await nextMcp(bridge, start);
    start = bridge.stdout.length;
    bridge.child.stdin.write(embeddedRequest(8, { action: "evidence_export", sessionId: "embedded-page-1" }));
    const evidenceExport = await nextWsMessage(page.socket); wsClientSend(page.socket, { type: "result", id: evidenceExport.id, ok: true, result: { format: "sassfully/feedback-evidence-export/v1", capability: "redacted in-page evidence; full Chrome HAR remains extension/CDP-only", items: [{ kind: "network", transport: "sidecar-json" }, { kind: "demo-execution", transport: "sidecar-json", payload: { entries: [{ type: "stage", status: "mounted" }] } }] } });
    const artifact = JSON.parse((await nextMcp(bridge, start)).result.content[0].text); assert.equal(artifact.format, "sassfully/feedback-evidence-export/v1"); assert.match(artifact.capability, /extension\/CDP-only/); assert.equal(artifact.items.at(-1).kind, "demo-execution");
    page.socket.destroy();
  } finally { bridge.child.kill(); await once(bridge.child, "exit"); }
});
