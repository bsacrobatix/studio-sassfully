// Builds the pinned, browser-native module tree consumed by Kitsoki's generic
// application container. It is intentionally a module tree, not a local npm
// dependency: every import remains relative and the checked-in manifest makes
// the vendored revision inspectable and reproducible.
//
// CONVENTION — source_revision is the SOURCE commit, not "HEAD at emit time":
// this script's own output (dist/kitsoki-embed/) is committed into the same
// repo the source packages live in. That makes `git rev-parse HEAD` wrong by
// construction: at the moment this script runs, HEAD is (at best) the commit
// containing the source changes, and the emit itself lands in a LATER commit
// that doesn't exist yet. Auto-stamping HEAD, or worse "refreshing" the field
// after some later unrelated commit lands, chases a target that recedes by
// exactly one commit every time you chase it — it can never converge. See
// the incident this fixed: studio-sassfully commits e7c2662 and fb0f011,
// which each "refreshed" source_revision to the prior commit's own SHA,
// making the field wrong again the instant the refresh commit itself landed.
//
// So: no default, no HEAD fallback. The caller must name the exact source
// commit explicitly, and it is never touched again after that — a
// source_revision that looks "behind" the tree's own commit history is
// correct, not drift. Do not add automation that re-stamps it.
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = new URL("../", import.meta.url);
const projectRoot = new URL("../../../", import.meta.url);
// Output directory defaults to the real, committed dist/kitsoki-embed/, but
// can be overridden (3rd CLI arg or KITSOKI_EMBED_OUT_DIR) to a scratch
// directory. This exists so verification (e.g. this package's own test
// suite) can exercise the emitter for real without the side effect of
// overwriting the committed tree on every `npm test` — that side effect is
// exactly what made source_revision look like it was drifting on its own.
const outDirArg = process.argv[3] ?? process.env.KITSOKI_EMBED_OUT_DIR;
const out = outDirArg
  ? pathToFileURL(`${resolve(process.cwd(), outDirArg)}/`)
  : new URL("dist/kitsoki-embed/", packageRoot);
const source = (pkg, path = "") => new URL(`packages/${pkg}/${path}`, projectRoot);
const copy = async (pkg, path = "src") => cp(source(pkg, path), new URL(`${pkg}/${path}`, out), { recursive: true });

const requested = process.argv[2] ?? process.env.KITSOKI_EMBED_SOURCE_REVISION;
if (!requested) {
  console.error(
    "error: build-kitsoki-embed.mjs requires an explicit source revision.\n\n" +
    "Usage:\n" +
    "  node packages/feedback-core/scripts/build-kitsoki-embed.mjs <source-commit-sha>\n" +
    "  KITSOKI_EMBED_SOURCE_REVISION=<source-commit-sha> node packages/feedback-core/scripts/build-kitsoki-embed.mjs\n\n" +
    "There is deliberately no default and no `git rev-parse HEAD` fallback: dist/kitsoki-embed\n" +
    "is committed into this same repo, so \"HEAD at emit time\" is wrong by construction (it\n" +
    "predates the very commit that lands this emit, and goes stale the instant any later commit\n" +
    "lands, even an unrelated one). Pass the commit that actually contains the source packages\n" +
    "this tree is built from — normally the fix/feature commit you just made, one commit before\n" +
    "the emit commit you are about to create.",
  );
  process.exit(1);
}
let revision;
try {
  revision = execFileSync("git", ["rev-parse", "--verify", `${requested}^{commit}`], { cwd: projectRoot.pathname, encoding: "utf8" }).trim();
} catch {
  console.error(`error: "${requested}" does not resolve to a commit in this repo (git rev-parse --verify failed).`);
  process.exit(1);
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const [pkg, path] of [["feedback-core", "src"], ["demo-player", "src"], ["feedback-vue", "src/browser-capture.mjs"], ["demo-stage", "src"], ["demo-stage", "vendor"], ["demo-stage", "assets"]]) await copy(pkg, path);
const files = [];
async function walk(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const full = join(dir, entry.name); if (entry.isDirectory()) await walk(full); else files.push(full.slice(new URL(out).pathname.length)); } }
await walk(new URL(out).pathname);
files.sort();
const digest = createHash("sha256").update(files.join("\n")).digest("hex");
await writeFile(new URL("manifest.json", out), JSON.stringify({ schema: "sassfully/kitsoki-embed/v1", source_revision: revision, files, file_list_sha256: digest }, null, 2) + "\n");
console.log(`kitsoki-embed emitted: ${files.length} files, source_revision ${revision}`);
