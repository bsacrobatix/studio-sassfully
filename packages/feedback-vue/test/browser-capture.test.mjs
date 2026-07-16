import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserEvidenceCapture } from "../src/browser-capture.mjs";

test("browser network capture is bounded and strips sensitive query and header values", async () => {
  const listeners = new Map();
  const win = {
    location: { href: "https://app.test/" },
    console: { error() {}, warn() {} },
    addEventListener(name, handler) { listeners.set(name, handler); },
    async fetch() { return { status: 500, headers: new Headers({ "set-cookie": "secret", "content-type": "application/json" }) }; },
  };
  const capture = createBrowserEvidenceCapture({ window: win });
  await win.fetch("/rpc?token=secret&safe=yes", { headers: { authorization: "Bearer secret" } });
  const network = await capture.providers.find((provider) => provider.id === "network").capture();
  const entry = network.payload.entries[0];
  assert.match(entry.request.url, /token=%5Bredacted%5D/);
  assert.equal(entry.request.headers[0].value, "[redacted]");
  assert.equal(entry.response.headers.find((header) => header.name === "set-cookie").value, "[redacted]");
  capture.dispose();
});

test("browser capture exposes host-sanitized screenshot and replay providers only when supplied", async () => {
  const win = { location: { href: "https://app.test/" }, console: { error() {}, warn() {} }, addEventListener() {} };
  const capture = createBrowserEvidenceCapture({ window: win, screenshot: () => ({ kind: "screenshot", label: "masked", payload: { image: "masked" } }), replay: () => ({ kind: "replay", label: "masked replay", payload: { events: [] } }) });
  assert.deepEqual(capture.providers.map((provider) => provider.id), ["network", "console", "error", "screenshot", "replay"]);
  assert.equal((await capture.providers[3].capture()).label, "masked");
});
