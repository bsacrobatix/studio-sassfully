import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// .mcp.json launches mcp-relay.mjs directly out of the installed
// content-addressed directory (see docs/codex-embedded-demo-tour.md and
// ~/.local/share/sassfully/embedded-demo-mcp/<sha>/story-bridge/). If the
// installer's file list omits it, a fresh install produces a directory the
// configured MCP server command cannot actually run -- exactly the defect
// this regression guard catches.
const scriptPath = fileURLToPath(new URL("../scripts/install-embedded-demo-mcp.mjs", import.meta.url));

test("installer stages mcp-relay.mjs -- the file .mcp.json actually launches -- alongside the stdio server", async () => {
  const prefix = await mkdtemp(join(tmpdir(), "sassfully-embedded-demo-install-test-"));
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, "--prefix", prefix], { encoding: "utf8" });
    const target = stdout.trim();
    const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
    assert.ok(manifest.files.includes("story-bridge/mcp-relay.mjs"), "manifest must list mcp-relay.mjs");
    await readFile(join(target, "story-bridge/mcp-relay.mjs"), "utf8"); // throws ENOENT if not staged
    const storyBridgeFiles = (await readdir(join(target, "story-bridge"))).sort();
    assert.deepEqual(storyBridgeFiles, ["embedded-demo-drafts.mjs", "embedded-qa-driver.mjs", "mcp-relay.mjs", "stdio-server.mjs"]);
  } finally {
    await rm(prefix, { recursive: true, force: true });
  }
});
