#!/usr/bin/env node
// Send one demo script through the story-bridge MCP server, without hand-rolled
// fifo plumbing.
//
//   node scripts/demo-send.mjs <script.json>                 # print the JSON-RPC lines to send
//   node scripts/demo-send.mjs <script.json> --exec          # spawn the bridge and run the demo
//   node scripts/demo-send.mjs --stop --exec                 # send demo_stop instead
//
// Exec-mode options:
//   --port <n>            bridge WebSocket port (default 8931; see RUNBOOK troubleshooting
//                         for port collisions)
//   --pairing-code <c>    supply the pairing code (the part of the token after the
//                         first dot) instead of letting the server mint one
//   --wait <seconds>      keep retrying while no tab is paired (default 180)
//
// IMPORTANT: pairing tokens (`<port>.<code>`) are per server INSTANCE. In
// --exec mode this script spawns a fresh bridge, so the extension popup must be
// (re-)paired against the token this instance prints on stderr before the demo
// can play — unless you pass --pairing-code (and --port) to reuse an existing
// pairing, in which case the already-paired extension reconnects on its own.
// The script retries while it sees "No user-paired Chrome tab", so the flow is:
// run it, read the token off stderr, pair the popup, and the queued demo starts.
// Print mode (no --exec) is for piping into an ALREADY-RUNNING bridge's stdin —
// only useful if you own that process's stdin.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { validateStoryCommand } from "../ext/story-bridge-policy.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const VALUE_FLAGS = ["--port", "--pairing-code", "--wait"];
const scriptPath = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1]));

const die = (message) => { process.stderr.write(`demo-send: ${message}\n`); process.exit(1); };

let command;
if (flag("--stop")) {
  command = { action: "demo_stop" };
} else {
  if (!scriptPath) die("usage: node scripts/demo-send.mjs <script.json> [--exec] [--port N] [--pairing-code CODE] [--wait SECONDS] | --stop --exec");
  let script;
  try { script = JSON.parse(readFileSync(path.resolve(scriptPath), "utf8")); } catch (error) { die(`could not read ${scriptPath}: ${error.message}`); }
  command = { action: "demo_run", script };
}

// Fail fast with the same validation the bridge and the extension apply.
const check = validateStoryCommand(command);
if (!check.ok) die(`script is invalid before sending: ${check.error}`);

const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
const call = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "linkedin_story", arguments: command } });

if (!flag("--exec")) {
  process.stderr.write("Send these two lines to the story bridge MCP server's stdin (or re-run with --exec to spawn one):\n");
  process.stdout.write(`${initialize}\n${call}\n`);
  process.exit(0);
}

const waitSeconds = Number(value("--wait") ?? 180);
const serverArgs = [path.join(packageRoot, "story-bridge", "stdio-server.mjs")];
if (value("--port")) serverArgs.push("--port", value("--port"));
if (value("--pairing-code")) serverArgs.push("--pairing-code", value("--pairing-code"));

const server = spawn(process.execPath, serverArgs, { stdio: ["pipe", "pipe", "inherit"] });
server.on("exit", (code) => { if (code !== 0) process.exit(code ?? 1); });
const deadline = Date.now() + waitSeconds * 1000;
let requestId = 1;

const send = (method, params) => {
  requestId += 1;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
  return requestId;
};

server.stdin.write(`${initialize}\n`);
let inFlight = 2; // the id used by the pre-serialized `call` line
server.stdin.write(`${call}\n`);
requestId = 2;

readline.createInterface({ input: server.stdout, crlfDelay: Infinity }).on("line", (line) => {
  let response; try { response = JSON.parse(line); } catch { return; }
  if (response.id !== inFlight) return;
  const text = response.result?.content?.[0]?.text ?? JSON.stringify(response.result ?? response.error ?? {});
  if (response.result?.isError) {
    if (/No user-paired Chrome tab/.test(text) && Date.now() < deadline) {
      process.stderr.write("demo-send: no paired tab yet — pair the popup with the token above; retrying in 2s…\n");
      setTimeout(() => { inFlight = send("tools/call", { name: "linkedin_story", arguments: command }); }, 2000);
      return;
    }
    process.stderr.write(`demo-send: bridge error: ${text}\n`);
    server.kill();
    process.exit(1);
  }
  process.stdout.write(`demo-send: ${command.action} ok: ${text}\n`);
  server.kill();
  process.exit(0);
});
