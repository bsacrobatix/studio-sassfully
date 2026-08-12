#!/usr/bin/env node
// One relay is launched per MCP client. The long-lived daemon owns the
// WebSocket bridge; relays only forward newline-delimited MCP JSON-RPC.
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const socketPath = value("--socket") ?? "/tmp/sassfully-embedded-demo.sock";
const port = value("--port") ?? "8931";
const allowEmbeddedDemo = args.includes("--allow-embedded-demo");
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "stdio-server.mjs");

function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function ensureDaemon() {
  try { return await connect(); } catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
  }
  // A stale Unix socket has no listener. Exact-path removal is safe; a fresh
  // daemon never removes an existing socket, so competing relays converge.
  try { await fs.unlink(socketPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const daemonArgs = [serverPath, "--daemon-socket", socketPath, "--port", port];
  if (allowEmbeddedDemo) daemonArgs.push("--allow-embedded-demo");
  spawn(process.execPath, daemonArgs, { detached: true, stdio: "ignore" }).unref();
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(25);
    try { return await connect(); } catch (error) { lastError = error; }
  }
  throw new Error(`Sassfully Story bridge daemon did not become ready: ${lastError?.code ?? "unknown error"}`);
}

try {
  const socket = await ensureDaemon();
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  socket.on("error", (error) => { process.stderr.write(`Sassfully MCP relay lost its local daemon: ${error.message}\n`); process.exitCode = 1; });
  socket.on("close", () => process.stdin.unpipe(socket));
} catch (error) {
  process.stderr.write(`Sassfully MCP relay could not connect to its local daemon: ${error.message}\n`);
  process.exit(1);
}
