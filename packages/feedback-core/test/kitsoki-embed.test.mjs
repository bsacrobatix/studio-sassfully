import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);

test("Kitsoki embed distribution is generated with a pinned manifest and complete relative-import closure", async () => {
  execFileSync("node", ["scripts/build-kitsoki-embed.mjs"], { cwd: root.pathname });
  const manifest = JSON.parse(await readFile(new URL("dist/kitsoki-embed/manifest.json", root), "utf8"));
  assert.equal(manifest.schema, "sassfully/kitsoki-embed/v1");
  assert.match(manifest.source_revision, /^[0-9a-f]{40}$/);
  assert.match(manifest.file_list_sha256, /^[0-9a-f]{64}$/);
  for (const path of ["feedback-core/src/reporter.mjs", "demo-player/src/embed.mjs", "feedback-vue/src/browser-capture.mjs", "demo-stage/vendor/slidey-stage/player.mjs"]) {
    assert.ok(manifest.files.includes(path), `manifest includes ${path}`);
    await readFile(new URL(`dist/kitsoki-embed/${path}`, root), "utf8");
  }
});
