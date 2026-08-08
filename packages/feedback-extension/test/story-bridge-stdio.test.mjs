import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  const child = spawn(process.execPath, [serverPath, "--port", String(port), "--pairing-code", code, ...extraArgs], { stdio: ["ignore", "pipe", "pipe"] });
  const state = { child, stderr: "" };
  child.stderr.on("data", (chunk) => { state.stderr += chunk; });
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
function dialBridge(port, pairingCode) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("connect", () => socket.write(`GET /bridge?code=${pairingCode} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    socket.once("data", (chunk) => resolve({ socket, status: Number(chunk.toString("utf8").split(" ")[1]) }));
    socket.on("error", reject);
  });
}

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
