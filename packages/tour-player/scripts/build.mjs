import { cp, mkdir, rm } from "node:fs/promises";

// The portable player has no bundler dependency.  Publishing a deterministic
// ESM artifact keeps the browser-facing contract explicit without fetching a
// build tool during a consumer's install.
await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
await mkdir(new URL("../dist", import.meta.url), { recursive: true });
await cp(new URL("../src/index.mjs", import.meta.url), new URL("../dist/tour-player.esm.mjs", import.meta.url));
console.log("tour-player build: dist/tour-player.esm.mjs");
