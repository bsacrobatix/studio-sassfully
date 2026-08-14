import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDaemonArgs } from "../story-bridge/mcp-relay.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const relayPath = `${root}story-bridge/mcp-relay.mjs`;
const serverPath = `${root}story-bridge/stdio-server.mjs`;

// --- Pure unit coverage: exact forwarded argv, no process spawned ----------

test("RED (regression): buildDaemonArgs with none of the new flags is byte-identical to the pre-allowlist argv shape", () => {
  const daemonArgs = buildDaemonArgs({ serverPath, socketPath: "/tmp/x.sock", port: "8931", allowEmbeddedDemo: true });
  assert.deepEqual(daemonArgs, [serverPath, "--daemon-socket", "/tmp/x.sock", "--port", "8931", "--allow-embedded-demo"]);
});

test("RED (regression): buildDaemonArgs with no --allow-embedded-demo omits it too, unchanged", () => {
  const daemonArgs = buildDaemonArgs({ serverPath, socketPath: "/tmp/x.sock", port: "8931", allowEmbeddedDemo: false });
  assert.deepEqual(daemonArgs, [serverPath, "--daemon-socket", "/tmp/x.sock", "--port", "8931"]);
});

test("GREEN: buildDaemonArgs forwards repeatable --allow-origin, --auth-bearer-env, and both Keychain flags verbatim", () => {
  const daemonArgs = buildDaemonArgs({
    serverPath, socketPath: "/tmp/x.sock", port: "8931", allowEmbeddedDemo: true,
    allowOrigins: ["https://staging.kitsoki.dev", "https://other.example.com"],
    authBearerEnv: "KITSOKI_STAGING_SERVICE_TOKEN",
    authBearerKeychainService: "custom-service",
    authBearerKeychainAccount: "custom-account",
  });
  assert.deepEqual(daemonArgs, [
    serverPath, "--daemon-socket", "/tmp/x.sock", "--port", "8931", "--allow-embedded-demo",
    "--allow-origin", "https://staging.kitsoki.dev",
    "--allow-origin", "https://other.example.com",
    "--auth-bearer-env", "KITSOKI_STAGING_SERVICE_TOKEN",
    "--auth-bearer-keychain-service", "custom-service",
    "--auth-bearer-keychain-account", "custom-account",
  ]);
});

test("buildDaemonArgs omits --auth-bearer-env/Keychain flags entirely when unset, rather than forwarding empty strings", () => {
  const daemonArgs = buildDaemonArgs({ serverPath, socketPath: "/tmp/x.sock", port: "8931", allowEmbeddedDemo: false, allowOrigins: [] });
  assert.deepEqual(daemonArgs, [serverPath, "--daemon-socket", "/tmp/x.sock", "--port", "8931"]);
});

// --- End-to-end: the exact launch path .mcp.json uses -----------------------
// mcp-relay.mjs spawns its daemon DETACHED and unref'd (so it outlives the
// relay -- that's the whole point of multiplexing). A real spawn here must
// therefore hunt down and kill that daemon afterward via the socket path, or
// it leaks a background node process per test run.

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

function killDaemonForSocket(socketPath) {
  try {
    const pids = execFileSync("lsof", ["-t", socketPath], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    for (const pid of pids) { try { process.kill(Number(pid), "SIGTERM"); } catch { /* already gone */ } }
  } catch { /* lsof found nothing, or is unavailable -- nothing to clean up */ }
}

function startRelay(socketPath, port, extraArgs = []) {
  const child = spawn(process.execPath, [relayPath, "--socket", socketPath, "--port", String(port), ...extraArgs], { stdio: ["pipe", "pipe", "pipe"] });
  const state = { child, stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { state.stdout += chunk; });
  child.stderr.on("data", (chunk) => { state.stderr += chunk; });
  return state;
}
function nextMcp(state, started = state.stdout.length) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP reply timed out; stderr so far:\n${state.stderr}`)), 8000);
    const tick = () => {
      const line = state.stdout.slice(started).trim().split("\n").at(-1);
      if (line) { try { const parsed = JSON.parse(line); clearTimeout(timer); return resolve(parsed); } catch { /* incomplete line, keep polling */ } }
      setTimeout(tick, 10);
    };
    tick();
  });
}
const mcpLine = (id, method, params) => `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
const toolsListLine = (id) => `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" })}\n`;
const qaStartLine = (id, url) => mcpLine(id, "tools/call", { name: "embedded_demo", arguments: { action: "qa_start", url, mode: "headless" } });

test("end to end through mcp-relay.mjs itself (the exact path .mcp.json launches): no flags means loopback-only, unchanged", async () => {
  const socketPath = join(tmpdir(), `sassfully-relay-test-${process.pid}-${Date.now()}-a.sock`);
  const port = await freePort();
  const relay = startRelay(socketPath, port, ["--allow-embedded-demo"]);
  try {
    relay.child.stdin.write(qaStartLine(1, "https://staging.kitsoki.dev/"));
    const response = await nextMcp(relay);
    assert.equal(response.result.isError, true);
    assert.equal(response.result.content[0].text, "qa_start.url must be an absolute loopback http(s) URL");
  } finally {
    relay.child.kill();
    await Promise.race([once(relay.child, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
    killDaemonForSocket(socketPath);
    await rm(socketPath, { force: true });
  }
});

test("end to end through mcp-relay.mjs itself: --allow-origin and --auth-bearer-env reach the spawned daemon and are visible in tools/list", async () => {
  const socketPath = join(tmpdir(), `sassfully-relay-test-${process.pid}-${Date.now()}-b.sock`);
  const port = await freePort();
  const relay = startRelay(socketPath, port, ["--allow-embedded-demo", "--allow-origin", "https://staging.kitsoki.dev", "--auth-bearer-env", "SASSFULLY_RELAY_TEST_BEARER"]);
  try {
    relay.child.stdin.write(toolsListLine(1));
    const listed = await nextMcp(relay);
    const description = listed.result.tools.find((t) => t.name === "embedded_demo").description;
    assert.match(description, /staging\.kitsoki\.dev/, "the forwarded --allow-origin must reach the daemon and show up in its tool description");

    // The forwarded --auth-bearer-env also reaches the daemon: qa_start
    // against the allowlisted origin is ADMITTED (not refused for being a
    // disallowed origin) and fails only on the separate, later "no bearer
    // available" check -- proving both flags were forwarded, not just one.
    delete process.env.SASSFULLY_RELAY_TEST_BEARER;
    relay.child.stdin.write(qaStartLine(2, "https://staging.kitsoki.dev/tour"));
    const qaStart = await nextMcp(relay);
    assert.equal(qaStart.result.isError, true);
    assert.doesNotMatch(qaStart.result.content[0].text, /explicitly allowlisted origin/, "must not be refused as a disallowed origin");
    assert.match(qaStart.result.content[0].text, /requires env var SASSFULLY_RELAY_TEST_BEARER/);
  } finally {
    relay.child.kill();
    await Promise.race([once(relay.child, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
    killDaemonForSocket(socketPath);
    await rm(socketPath, { force: true });
  }
});
