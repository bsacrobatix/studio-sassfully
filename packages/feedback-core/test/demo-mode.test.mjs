// Demo mode is an explicit opt-in on mountReporter: absent the flag, the
// reporter must expose NOTHING demo-related; with it, window.__sassfullyDemo
// appears (and the postMessage channel stays off without an origin allowlist).
import test from "node:test";
import assert from "node:assert/strict";
import { mountReporter } from "../src/reporter.mjs";

function fakeElement() {
  return {
    style: {}, children: [], textContent: "",
    setAttribute() {},
    appendChild(child) { this.children.push(child); },
    append(...nodes) { this.children.push(...nodes); },
    addEventListener() {},
    remove() {},
  };
}

function makeDocument() {
  return { createElement: fakeElement, body: fakeElement(), defaultView: undefined };
}

function makeWindow() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener(type, fn) { if (type === "message") listeners.add(fn); },
    removeEventListener(type, fn) { listeners.delete(fn); },
  };
}

const baseOpts = () => ({ document: makeDocument(), anchorFor: () => ({}), manifest: {}, router: {} });

test("without demoMode the reporter exposes no demo surface at all", () => {
  const win = makeWindow();
  const api = mountReporter({ ...baseOpts(), window: win });
  assert.equal(api.demo, undefined, "no demo handle on the mount api");
  assert.equal("__sassfullyDemo" in win, false, "no page-level global");
  assert.equal(win.listeners.size, 0, "no message listener");
});

test("demoMode must be exactly true, not merely truthy", () => {
  const win = makeWindow();
  const api = mountReporter({ ...baseOpts(), window: win, demoMode: "yes" });
  assert.equal(api.demo, undefined);
  assert.equal("__sassfullyDemo" in win, false);
});

test("demoMode: true exposes window.__sassfullyDemo; postMessage stays off without demoOrigins", async () => {
  const win = makeWindow();
  const api = mountReporter({ ...baseOpts(), window: win, demoMode: true });
  const embed = await api.demo;
  assert.deepEqual(Object.keys(win.__sassfullyDemo).sort(), ["evidence", "resume", "run", "status", "stop", "unlockAudio"]);
  assert.deepEqual(win.__sassfullyDemo.status(), { running: false, lastResult: null, media: { narration: [], stage: [], audioUnlock: null } });
  assert.equal(win.listeners.size, 0, "default demoOrigins [] keeps the postMessage channel disabled");
  embed.uninstall();
  assert.equal("__sassfullyDemo" in win, false);
});
