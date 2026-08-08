// Builds the pinned, browser-native module tree consumed by Kitsoki's generic
// application container. It is intentionally a module tree, not a local npm
// dependency: every import remains relative and the checked-in manifest makes
// the vendored revision inspectable and reproducible.
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const packageRoot = new URL("../", import.meta.url);
const projectRoot = new URL("../../../", import.meta.url);
const out = new URL("dist/kitsoki-embed/", packageRoot);
const source = (pkg, path = "") => new URL(`packages/${pkg}/${path}`, projectRoot);
const copy = async (pkg, path = "src") => cp(source(pkg, path), new URL(`${pkg}/${path}`, out), { recursive: true });

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const [pkg, path] of [["feedback-core", "src"], ["demo-player", "src"], ["feedback-vue", "src/browser-capture.mjs"], ["demo-stage", "src"], ["demo-stage", "vendor"], ["demo-stage", "assets"]]) await copy(pkg, path);
const files = [];
async function walk(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const full = join(dir, entry.name); if (entry.isDirectory()) await walk(full); else files.push(full.slice(new URL(out).pathname.length)); } }
await walk(new URL(out).pathname);
files.sort();
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot.pathname, encoding: "utf8" }).trim();
const digest = createHash("sha256").update(files.join("\n")).digest("hex");
await writeFile(new URL("manifest.json", out), JSON.stringify({ schema: "sassfully/kitsoki-embed/v1", source_revision: revision, files, file_list_sha256: digest }, null, 2) + "\n");
