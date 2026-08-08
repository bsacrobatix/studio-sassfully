import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const serverPath = `${root}story-bridge/stdio-server.mjs`;
const code = "abcdefghijklmnopqrstuvwxyzABCDEF12";

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
