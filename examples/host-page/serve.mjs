#!/usr/bin/env node
// Tiny static server for the example host page: serves the repo root so the
// page can import packages/feedback-core/src/*.mjs as native ES modules with
// a correct MIME type (python -m http.server serves .mjs as text/plain on
// some installs, which browsers refuse for modules). Used by the real-mode
// demo capture's target.launch (stories/demo-packet/fixtures/capture-widget).
//
//   node examples/host-page/serve.mjs [port]
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.argv[2] || 7893);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".css": "text/css",
};

http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/") p = "/examples/host-page/index.html";
    const file = path.join(root, p);
    if (!file.startsWith(root)) throw new Error("outside root");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`host-page: http://127.0.0.1:${port}/`));
