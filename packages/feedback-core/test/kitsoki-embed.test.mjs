import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url);

// Exercises the real emitter end to end, but into a scratch directory: the
// committed packages/feedback-core/dist/kitsoki-embed/ is a checked-in
// artifact with its own pinned source_revision (see the convention note in
// scripts/build-kitsoki-embed.mjs), not something `npm test` should
// regenerate as a side effect. HEAD is a perfectly fine revision to pass
// HERE, since this run's output is thrown away — it is only unsound as the
// value baked into the real, committed manifest.
test("Kitsoki embed distribution is generated with a pinned manifest and complete relative-import closure", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "kitsoki-embed-test-"));
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root.pathname, encoding: "utf8" }).trim();
    execFileSync("node", ["scripts/build-kitsoki-embed.mjs", revision, outDir], { cwd: root.pathname });
    const manifest = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
    assert.equal(manifest.schema, "sassfully/kitsoki-embed/v1");
    assert.equal(manifest.source_revision, revision);
    assert.match(manifest.source_revision, /^[0-9a-f]{40}$/);
    assert.match(manifest.file_list_sha256, /^[0-9a-f]{64}$/);
    for (const path of ["feedback-core/src/reporter.mjs", "demo-player/src/embed.mjs", "feedback-vue/src/browser-capture.mjs", "demo-stage/vendor/slidey-stage/player.mjs"]) {
      assert.ok(manifest.files.includes(path), `manifest includes ${path}`);
      await readFile(join(outDir, path), "utf8");
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("build-kitsoki-embed.mjs refuses to run without an explicit source revision", () => {
  assert.throws(() => execFileSync("node", ["scripts/build-kitsoki-embed.mjs"], { cwd: root.pathname, stdio: "pipe" }));
});
