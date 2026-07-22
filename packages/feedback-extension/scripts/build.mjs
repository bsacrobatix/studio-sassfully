// Assembles the unpacked MV3 extension at dist/ with plain copies — no
// bundler, per repo convention (see tour-player's build). Sibling sources are
// vendored preserving their package-relative shape so their own relative
// imports keep resolving; the ONLY rewritten file is deps.mjs, whose sibling
// paths ("../../<pkg>/src/…") become vendored paths ("./<pkg>/src/…").
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const dist = new URL("dist/", root);
const url = (...parts) => new URL(parts.join("/"), root);

await rm(dist, { recursive: true, force: true });
await mkdir(new URL("content/core/", dist), { recursive: true });

await cp(url("ext"), dist, { recursive: true });
await cp(url("vendor"), new URL("vendor/", dist), { recursive: true });

for (const file of await readdir(url("src"))) {
  if (file === "deps.mjs") continue;
  await cp(url("src", file), new URL(`content/core/${file}`, dist));
}
const deps = await readFile(url("src", "deps.mjs"), "utf8");
await writeFile(new URL("content/core/deps.mjs", dist), deps.replaceAll('"../../', '"./'));

await mkdir(new URL("content/core/feedback-core/src/", dist), { recursive: true });
for (const file of await readdir(url("..", "feedback-core", "src"))) {
  await cp(url("..", "feedback-core", "src", file), new URL(`content/core/feedback-core/src/${file}`, dist));
}
await mkdir(new URL("content/core/feedback-vue/src/", dist), { recursive: true });
for (const file of ["controller.mjs", "browser-capture.mjs"]) {
  await cp(url("..", "feedback-vue", "src", file), new URL(`content/core/feedback-vue/src/${file}`, dist));
}

console.log("feedback-extension build: dist/ (load unpacked in chrome://extensions)");
