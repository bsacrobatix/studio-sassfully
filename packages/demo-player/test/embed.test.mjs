import test from "node:test";
import assert from "node:assert/strict";
import { DEMO_MESSAGE_RESULT, DEMO_MESSAGE_RUN, DEMO_MESSAGE_STOP, createDemoController, installDemoEmbed } from "../src/embed.mjs";

const SCRIPT = { steps: [
  { id: "s1", narration: "hello", dwellMs: 0 },
  { id: "s2", action: { kind: "click", selector: "#go" }, dwellMs: 0 },
] };

function makeWindow() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener(type, fn) { if (type === "message") listeners.add(fn); },
    removeEventListener(type, fn) { listeners.delete(fn); },
    async emitMessage(event) { for (const fn of [...listeners]) await fn(event); },
  };
}

// A DOM double just rich enough for the overlay layer (closed shadow root,
// spotlight/caption/pulse elements) and target queries to work under node.
function fakeElement() {
  return {
    style: {}, children: [], className: "", textContent: "",
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {},
    appendChild(child) { this.children.push(child); },
    append(...nodes) { this.children.push(...nodes); },
    attachShadow() { return this; },
    remove() {},
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
    scrollIntoView() {},
  };
}

// Targets resolve through the anchor resolver (querySelectorAll); the default
// document answers every non-wildcard selector with one visible element.
const makeDocument = (querySelectorAll = (selector) => (selector === "*" ? [] : [fakeElement()])) =>
  ({ createElement: fakeElement, documentElement: fakeElement(), querySelector: () => fakeElement(), querySelectorAll });

function makeEmbed({ allowedOrigins } = {}) {
  const acted = [];
  const win = makeWindow();
  const embed = installDemoEmbed({
    window: win,
    document: makeDocument(),
    allowedOrigins,
    executeAction: async (action) => acted.push(action),
    speak: async () => {},
  });
  return { win, embed, acted };
}

// postMessage senders reply through event.source; this records the replies.
function messageFrom(origin, data) {
  const replies = [];
  return { origin, data, replies, source: { postMessage: (payload, targetOrigin) => replies.push({ payload, targetOrigin }) } };
}

test("the controller runs a script against injected deps and reports status", async () => {
  const events = [];
  const controller = createDemoController({
    document: makeDocument(),
    executeAction: async () => {},
    speak: async () => {},
    onStepEvent: (evt) => events.push(evt),
  });
  assert.deepEqual(controller.status(), { running: false, lastResult: null });
  const demo = await controller.run(SCRIPT);
  assert.equal(demo.completed, true);
  assert.deepEqual(demo.completedSteps, [
    { index: 0, id: "s1", ok: true, anchor: null, healed: null },
    { index: 1, id: "s2", ok: true, anchor: null, healed: null },
  ]);
  assert.deepEqual(controller.status(), { running: false, lastResult: demo });
  assert.deepEqual(events.map((evt) => evt.type), ["step", "narrate", "step", "step", "act", "step", "done"]);
  // Per-step lifecycle info flows through onStepEvent exactly like the
  // extension's rrweb stamps: start/end with id, index, anchor, healed.
  assert.deepEqual(events.filter((evt) => evt.type === "step"), [
    { type: "step", index: 0, id: "s1", phase: "start" },
    { type: "step", index: 0, id: "s1", phase: "end", ok: true, anchor: null, healed: null },
    { type: "step", index: 1, id: "s2", phase: "start" },
    { type: "step", index: 1, id: "s2", phase: "end", ok: true, anchor: null, healed: null },
  ]);
  await assert.rejects(() => controller.run({ steps: [] }), /non-empty steps array/);
});

test("structured anchors resolve, record the strategy, and surface healed notes to the host", async () => {
  const target = fakeElement();
  // No [data-testid="gone"] on the page; the css fallback matches: healed.
  const document = makeDocument((selector) => (selector === "#fallback" ? [target] : []));
  const events = [];
  const controller = createDemoController({
    document,
    executeAction: async () => {},
    speak: async () => {},
    onStepEvent: (evt) => events.push(evt),
  });
  const demo = await controller.run({ steps: [
    { id: "a1", spotlight: { testid: "gone", css: "#fallback" }, dwellMs: 0 },
  ] });
  assert.deepEqual(demo.completedSteps, [
    { index: 0, id: "a1", ok: true, anchor: "css", healed: [{ target: "spotlight", requested: "testid", matched: "css" }] },
  ]);
  assert.deepEqual(events.at(-2), {
    type: "step", index: 0, id: "a1", phase: "end", ok: true,
    anchor: "css", healed: [{ target: "spotlight", requested: "testid", matched: "css" }],
  });
});

test("a structured-anchor action acts on the resolved element (no CSS re-query)", async () => {
  const button = fakeElement();
  let clicked = 0;
  button.click = () => { clicked += 1; };
  const document = makeDocument((selector) => (selector === '[data-testid="go"]' ? [button] : []));
  const controller = createDemoController({ document, speak: async () => {} });
  const demo = await controller.run({ steps: [
    { id: "c1", action: { kind: "click", selector: { testid: "go" } }, dwellMs: 0 },
  ] });
  assert.equal(demo.completed, true);
  assert.equal(clicked, 1, "the default executor clicked the resolved element itself");
});

test("installDemoEmbed exposes window.__sassfullyDemo and uninstall removes it", async () => {
  const { win, embed } = makeEmbed();
  assert.deepEqual(Object.keys(win.__sassfullyDemo).sort(), ["run", "status", "stop"]);
  const demo = await win.__sassfullyDemo.run(SCRIPT);
  assert.equal(demo.completed, true);
  embed.uninstall();
  assert.equal("__sassfullyDemo" in win, false);
});

test("postMessage is disabled by default: no allowlist, no listener, no reply", async () => {
  const { win } = makeEmbed();
  assert.equal(win.listeners.size, 0, "no message listener without an allowlist");
  const msg = messageFrom("http://caller.test", { type: DEMO_MESSAGE_RUN, script: SCRIPT });
  await win.emitMessage(msg);
  assert.deepEqual(msg.replies, []);
});

test("postMessage from a non-allowlisted origin is ignored silently", async () => {
  const { win, acted } = makeEmbed({ allowedOrigins: ["http://ok.test"] });
  const msg = messageFrom("http://evil.test", { type: DEMO_MESSAGE_RUN, script: SCRIPT, requestId: "r1" });
  await win.emitMessage(msg);
  assert.deepEqual(msg.replies, [], "no reply oracle for probing origins");
  assert.deepEqual(acted, [], "no action ever executes for a rejected caller");
});

test("postMessage from an allowlisted origin runs the demo and replies to the sender origin", async () => {
  const { win, acted } = makeEmbed({ allowedOrigins: ["http://ok.test"] });
  const msg = messageFrom("http://ok.test", { type: DEMO_MESSAGE_RUN, script: SCRIPT, requestId: "r2" });
  await win.emitMessage(msg);
  assert.equal(msg.replies.length, 1);
  assert.equal(msg.replies[0].targetOrigin, "http://ok.test");
  const { payload } = msg.replies[0];
  assert.equal(payload.type, DEMO_MESSAGE_RESULT);
  assert.equal(payload.requestId, "r2");
  assert.equal(payload.ok, true);
  assert.equal(payload.demo.completed, true);
  assert.equal(acted.length, 1);

  const bad = messageFrom("http://ok.test", { type: DEMO_MESSAGE_RUN, script: { steps: [] }, requestId: "r3" });
  await win.emitMessage(bad);
  assert.equal(bad.replies[0].payload.ok, false);
  assert.match(bad.replies[0].payload.error, /non-empty steps array/);

  const stop = messageFrom("http://ok.test", { type: DEMO_MESSAGE_STOP, requestId: "r4" });
  await win.emitMessage(stop);
  assert.deepEqual(stop.replies[0].payload, { type: DEMO_MESSAGE_RESULT, requestId: "r4", ok: true, stopped: true });
});
