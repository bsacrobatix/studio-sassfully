#!/usr/bin/env node
// One relay is launched per MCP client. The long-lived daemon owns the
// WebSocket bridge; relays only forward newline-delimited MCP JSON-RPC.
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Pure and exported so a test can assert the exact forwarded argv without
// spawning a real daemon process (this repo has no automated coverage of the
// daemon-spawn path otherwise, and a spawned daemon is detached + unref'd --
// deliberately outliving the relay -- so a test that exercises the real
// spawn must separately hunt down and kill that process or leak it).
// Forwarded verbatim to the daemon this relay spawns -- stdio-server.mjs
// owns validating them, so the relay itself neither parses nor rejects an
// origin/env-var-name shape. With none of these given, the result is
// byte-identical to before this existed. NOTE (existing daemon-multiplexing
// limitation, unchanged by this): the daemon is only ever spawned with the
// FIRST relay's flags -- a later relay against an already-running daemon
// just connects, exactly like --allow-embedded-demo already does today.
export function buildDaemonArgs({ serverPath, socketPath, port, allowEmbeddedDemo, allowOrigins = [], authBearerEnv, authBearerKeychainService, authBearerKeychainAccount }) {
  const daemonArgs = [serverPath, "--daemon-socket", socketPath, "--port", port];
  if (allowEmbeddedDemo) daemonArgs.push("--allow-embedded-demo");
  for (const origin of allowOrigins) daemonArgs.push("--allow-origin", origin);
  if (authBearerEnv) daemonArgs.push("--auth-bearer-env", authBearerEnv);
  if (authBearerKeychainService) daemonArgs.push("--auth-bearer-keychain-service", authBearerKeychainService);
  if (authBearerKeychainAccount) daemonArgs.push("--auth-bearer-keychain-account", authBearerKeychainAccount);
  return daemonArgs;
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
  const values = (name) => args.reduce((found, arg, i) => (arg === name ? [...found, args[i + 1]] : found), []);
  const socketPath = value("--socket") ?? "/tmp/sassfully-embedded-demo.sock";
  const port = value("--port") ?? "8931";
  const allowEmbeddedDemo = args.includes("--allow-embedded-demo");
  const allowOrigins = values("--allow-origin");
  const authBearerEnv = value("--auth-bearer-env");
  const authBearerKeychainService = value("--auth-bearer-keychain-service");
  const authBearerKeychainAccount = value("--auth-bearer-keychain-account");
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
    const daemonArgs = buildDaemonArgs({ serverPath, socketPath, port, allowEmbeddedDemo, allowOrigins, authBearerEnv, authBearerKeychainService, authBearerKeychainAccount });
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
}

// Only run the relay when this file is the process entry point -- so a test
// can `import { buildDaemonArgs }` without triggering a real stdin pipe /
// daemon spawn as a side effect of the import itself.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
