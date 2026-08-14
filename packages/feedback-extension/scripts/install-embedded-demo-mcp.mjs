#!/usr/bin/env node
// Install the tiny, credential-free embedded-demo MCP server as a pinned local
// artifact. The installed tree deliberately contains only the stdio server and
// its two local dependencies: it is not a copy of a browser extension and it
// cannot acquire a paired tab, navigate, or evaluate page code.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(packageRoot, "../..");
const explicitPrefix = process.argv.indexOf("--prefix");
const prefix = explicitPrefix >= 0
  ? resolve(process.argv[explicitPrefix + 1] ?? "")
  : resolve(homedir(), ".local/share/sassfully/embedded-demo-mcp");
if (!prefix || prefix === resolve("/")) throw new Error("--prefix must name a concrete install directory");

const revision = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const files = [
  "story-bridge/stdio-server.mjs",
  "story-bridge/embedded-demo-drafts.mjs",
  "story-bridge/embedded-qa-driver.mjs",
  // mcp-relay.mjs is the process .mcp.json actually launches (it multiplexes
  // per-client stdio onto one local bridge daemon, spawning stdio-server.mjs
  // from its own directory). It was missing from this list even though the
  // multiplex daemon architecture requires it -- an install built from a
  // clean prefix produced a directory .mcp.json could not actually run.
  "story-bridge/mcp-relay.mjs",
  "ext/story-bridge-policy.mjs",
];
const digest = createHash("sha256");
for (const relative of files) {
  digest.update(relative); digest.update("\0");
  digest.update(await readFile(resolve(packageRoot, relative))); digest.update("\0");
}
const manifest = {
  schema: "sassfully/embedded-demo-mcp-install/v1",
  source_revision: revision,
  files,
  content_sha256: digest.digest("hex"),
};
const target = resolve(prefix, revision);
const manifestPath = resolve(target, "manifest.json");
try {
  const existing = JSON.parse(await readFile(manifestPath, "utf8"));
  if (JSON.stringify(existing) === JSON.stringify(manifest)) {
    process.stdout.write(`${target}\n`);
    process.exit(0);
  }
  throw new Error(`refusing to replace non-matching installed artifact at ${target}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const staging = resolve(prefix, `.install-${revision}-${process.pid}`);
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true, mode: 0o755 });
for (const relative of files) {
  const destination = resolve(staging, relative);
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await cp(resolve(packageRoot, relative), destination);
}
await writeFile(resolve(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
await mkdir(prefix, { recursive: true, mode: 0o755 });
await rename(staging, target);
process.stdout.write(`${target}\n`);
