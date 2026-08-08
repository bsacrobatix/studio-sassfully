// Keeps the copy-script build honest under node --test: the dist import
// graph must resolve with the vendored sibling copies (no chrome APIs are
// touched by the modules imported here).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = (rel) => `${root}dist/${rel}`;

test("build assembles a coherent unpacked extension", async () => {
  execFileSync(process.execPath, [`${root}scripts/build.mjs`], { stdio: "pipe" });

  const manifest = JSON.parse(readFileSync(dist("manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.optional_host_permissions, ["https://www.linkedin.com/*"]);
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.deepEqual(manifest.web_accessible_resources[0].matches, ["https://www.linkedin.com/*"]);
  assert.ok(manifest.web_accessible_resources[0].resources.includes("story-bridge-policy.mjs"), "the injected content module's root policy import must remain LinkedIn-accessible");
  const expected = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_page,
    "content-loader.js",
    "main-world.js",
    "vendor/rrweb-record.iife.js",
    "content/main.mjs",
    "content/story-confirm.mjs",
    "story-bridge-policy.mjs",
    "story-receiver.mjs",
    "story-navigation.mjs",
    "story-timeout.mjs",
    "content/core/deps.mjs",
    "content/core/feedback-core/src/index.mjs",
    "content/core/feedback-vue/src/controller.mjs",
    "review/review.mjs",
    "popup/popup.mjs",
    "popup/story-bridge-view.mjs",
    "options/options.mjs",
    "lib/idb-backend.mjs",
  ];
  for (const file of expected) assert.ok(existsSync(dist(file)), `missing ${file}`);
  assert.ok(statSync(dist("vendor/rrweb-record.iife.js")).size > 10000, "vendored rrweb looks truncated");

  const deps = readFileSync(dist("content/core/deps.mjs"), "utf8");
  assert.ok(!deps.includes("../../"), "dist deps.mjs must not reach outside dist");

  // The chrome-free vendored import graph must resolve from inside dist.
  const core = await import(pathToFileURL(dist("content/core/index.mjs")));
  assert.equal(typeof core.createStandaloneReporter, "function");
  assert.equal(typeof core.createRecordingRing, "function");
  const standalone = await import(pathToFileURL(dist("content/core/standalone.mjs")));
  assert.equal(standalone.extensionPrivacyManifest().fields["anchor.url"], "high");
});
