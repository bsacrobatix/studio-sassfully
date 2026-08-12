import test from "node:test";
import assert from "node:assert/strict";
import { DEMO_MESSAGE_RESULT, DEMO_MESSAGE_RUN, DEMO_MESSAGE_STOP, bindEmbeddedDemoSession, createDemoController, createEdgeNarrator, installDemoEmbed, unlockDemoAudio } from "../src/embed.mjs";

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
  assert.deepEqual(controller.status(), { running: false, lastResult: null, media: { narration: [], stage: [], audioUnlock: null } });
  const demo = await controller.run(SCRIPT);
  assert.equal(demo.completed, true);
  assert.deepEqual(demo.completedSteps, [
    { index: 0, id: "s1", ok: true, anchor: null, healed: null },
    { index: 1, id: "s2", ok: true, anchor: null, healed: null },
  ]);
  assert.deepEqual(controller.status(), { running: false, lastResult: demo, media: { narration: [], stage: [], audioUnlock: null } });
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

test("embedded controller lazily mounts and plays a stage scene next to its target", async () => {
  const played = [];
  const layer = { stop() {}, destroy() {}, playScene: async (args) => played.push(args) };
  const controller = createDemoController({
    document: makeDocument(), speak: async () => {}, mountStageLayer: async () => layer,
  });
  await controller.run({ steps: [{ spotlight: "#panel", stage: { scene: { type: "stage" }, anchor: "target" }, dwellMs: 0 }] });
  assert.equal(played.length, 1);
  assert.equal(played[0].placement.mode, "anchor");
  controller.destroy();
});

test("persistent presenter remains mounted while the next step completes", async () => {
  const played = [];
  const layer = { stop() {}, destroy() {}, playScene: async (args) => played.push(args) };
  const controller = createDemoController({ document: makeDocument(), speak: async () => {}, mountStageLayer: async () => layer });
  const demo = await controller.run({ steps: [
    { stage: { scene: { type: "stage" }, persistent: true }, dwellMs: 0 },
    { caption: "still here", dwellMs: 0 },
  ] });
  assert.equal(demo.completed, true);
  assert.equal(played.length, 1);
});

test("run acknowledgment exposes persistent-stage mount telemetry", async () => {
  const layer = { stop() {}, destroy() {}, playScene: async () => {} };
  const controller = createDemoController({ document: makeDocument(), speak: async () => {}, mountStageLayer: async () => layer });
  const demo = await controller.run({ steps: [{ stage: { scene: { type: "stage" }, persistent: true, anchor: { mode: "dock", edge: "bottom-left", size: 0.3 } }, dwellMs: 0 }] });
  assert.equal(demo.media.stage[0].status, "mounted");
  assert.equal(controller.status().media.stage[0].status, "mounted");
});

test("a static local presenter flows through the resident stage adapter and receipt", async () => {
  const played = [];
  const layer = { stop() {}, destroy() {}, playScene: async (args) => played.push(args) };
  const controller = createDemoController({ document: makeDocument(), speak: async () => {}, mountStageLayer: async () => layer });
  const presenter = { id: "nova", src: "/packages/demo-stage/assets/nova-cutout.png", alt: "Nova" };
  const demo = await controller.run({ steps: [{ stage: { presenter, persistent: true, anchor: { mode: "dock", edge: "bottom-left", size: 0.3 } }, dwellMs: 0 }] });
  assert.deepEqual(played[0].presenter, presenter);
  assert.equal(played[0].scene, undefined);
  assert.equal(demo.media.stage[0].presenter, "nova");
});

test("assetBase rewrites a vendored presenter path without touching the script-declared src", async () => {
  const played = [];
  const layer = { stop() {}, destroy() {}, playScene: async (args) => played.push(args) };
  const presenter = { id: "nova", src: "/packages/demo-stage/assets/nova-cutout.png", alt: "Nova" };
  const controller = createDemoController({
    document: makeDocument(), speak: async () => {}, mountStageLayer: async () => layer,
    assetBase: "/vendor/sassfully/kitsoki-embed/v1",
  });
  await controller.run({ steps: [{ stage: { presenter, persistent: true, anchor: { mode: "dock", edge: "bottom-left", size: 0.3 } }, dwellMs: 0 }] });
  assert.equal(played[0].presenter.src, "/vendor/sassfully/kitsoki-embed/v1/demo-stage/assets/nova-cutout.png");
  assert.equal(presenter.src, "/packages/demo-stage/assets/nova-cutout.png", "the caller's script object is never mutated");
});

test("an invalid assetBase never escapes to a cross-origin or unbounded src", async () => {
  const played = [];
  const layer = { stop() {}, destroy() {}, playScene: async (args) => played.push(args) };
  const presenter = { id: "nova", src: "/packages/demo-stage/assets/nova-cutout.png", alt: "Nova" };
  const controller = createDemoController({
    document: makeDocument(), speak: async () => {}, mountStageLayer: async () => layer,
    assetBase: "https://evil.test",
  });
  await controller.run({ steps: [{ stage: { presenter, persistent: true, anchor: { mode: "dock", edge: "bottom-left", size: 0.3 } }, dwellMs: 0 }] });
  assert.equal(played[0].presenter.src, "/packages/demo-stage/assets/nova-cutout.png", "an invalid assetBase falls back to the untouched, already-validated src");
});

test("audio unlock performs only user-gesture media priming", async () => {
  let played = 0;
  class Context { constructor() { this.state = "suspended"; } async resume() { this.state = "running"; } }
  class Audio { async play() { played += 1; } pause() {} }
  const result = await unlockDemoAudio({ AudioContext: Context, Audio });
  assert.deepEqual(result, { attempted: true, audioContext: "running", silentAudio: "played", unlocked: true });
  assert.equal(played, 1);
});

test("edge narration reports a gesture block and never silently falls back to speech synthesis", async () => {
  const statuses = []; let fallbackCalls = 0;
  const narrator = createEdgeNarrator({ url: "http://127.0.0.1:4547/narration", window: { fetch: async () => { const error = new Error("play() requires a user gesture"); error.name = "NotAllowedError"; throw error; } }, fallback: async () => { fallbackCalls += 1; }, onStatus: (status) => statuses.push(status) });
  const result = await narrator("Pip speaks", { fallbackMs: 0 });
  assert.equal(result.status, "blocked_user_gesture");
  assert.equal(result.needs_audio_unlock, true);
  assert.equal(fallbackCalls, 0);
  assert.equal(statuses[0].status, "blocked_user_gesture");
});

test("embedded evidence composes redacted browser providers with demo stamps only after permission", async () => {
  const win = { location: { href: "http://host.test/" }, fetch: async () => ({ status: 200, headers: new Headers() }), addEventListener() {}, removeEventListener() {}, console: { warn() {}, error() {} } };
  const doc = makeDocument(); doc.defaultView = win;
  const controller = createDemoController({ document: doc, speak: async () => {} });
  assert.throws(() => controller.evidence.start(), /explicit permission/);
  assert.equal(controller.evidence.start({ permission: true }).active, true);
  await controller.run({ steps: [{ caption: "stamp", dwellMs: 0 }] });
  controller.evidence.stop();
  const artifact = controller.evidence.export();
  assert.equal(artifact.format, "sassfully/feedback-evidence-export/v1");
  assert.match(artifact.capability, /extension\/CDP-only/);
  assert.ok(artifact.items.some((item) => item.kind === "demo-execution"));
});


test("one installed API runs two distinct scripts without recreation or navigation", async () => {
  const { win, embed, acted } = makeEmbed();
  const first = await win.__sassfullyDemo.run({ steps: [{ caption: "first runtime script", dwellMs: 0 }] });
  const api = win.__sassfullyDemo;
  const second = await win.__sassfullyDemo.run({ steps: [{ action: { kind: "click", selector: "#go" }, dwellMs: 0 }] });
  assert.equal(first.completed, true);
  assert.equal(second.completed, true);
  assert.equal(win.__sassfullyDemo, api, "same public API remains installed");
  assert.equal(embed.controller.status().lastResult, second, "second script replaces status only, not the controller");
  assert.equal(acted.length, 1);
});

test("a bound local embedded session validates and runs an RPC-pushed script on the resident API", async () => {
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; this.listeners = new Map(); Socket.instance = this; }
    addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.closed = true; }
    async emit(type, payload) { for (const fn of this.listeners.get(type) ?? []) await fn(payload); }
  }
  const calls = [];
  const win = { WebSocket: Socket, crypto: { randomUUID: () => "embedded-session-1" }, location: { href: "http://127.0.0.1:7894/?demo=1" } };
  const api = { run: async (script) => { calls.push(script); return { completed: true, completedSteps: [{ healed: null }] }; }, stop() {} };
  const session = bindEmbeddedDemoSession({ window: win, api, bridge: { url: "ws://127.0.0.1:8931/embedded-demo" } });
  await Socket.instance.emit("open");
  assert.deepEqual(Socket.instance.sent[0], { type: "embedded-demo:hello", sessionId: "embedded-session-1", url: win.location.href });
  await Socket.instance.emit("message", { data: JSON.stringify({ type: "embedded-demo:run", id: "rpc-1", script: { steps: [{ caption: "pushed", dim: false }] } }) });
  assert.equal(calls.length, 1);
  assert.deepEqual(Socket.instance.sent.at(-1), { type: "result", id: "rpc-1", ok: true, result: { sessionId: "embedded-session-1", url: win.location.href, demo: { completed: true, completedSteps: [{ healed: null }] }, drift: [] } });
  session.close();
  assert.equal(Socket.instance.closed, true);
});

test("embedded session reconnects with the same id after a bridge restart and accepts a later push", async () => {
  class Socket {
    static OPEN = 1; static instances = [];
    constructor() { this.readyState = 1; this.sent = []; this.listeners = new Map(); Socket.instances.push(this); }
    addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.closed = true; }
    async emit(type, payload = {}) { for (const fn of this.listeners.get(type) ?? []) await fn(payload); }
  }
  const events = []; const calls = [];
  const win = { WebSocket: Socket, crypto: { randomUUID: () => "stable-page-session" }, location: { href: "http://127.0.0.1:7894/?demo=1" }, setTimeout: (fn) => { fn(); return 1; }, clearTimeout() {} };
  const api = { run: async (script) => { calls.push(script); return { completed: true, completedSteps: [] }; }, stop() {} };
  const session = bindEmbeddedDemoSession({ window: win, api, bridge: { url: "ws://127.0.0.1:8931/embedded-demo", retryMs: 0 }, onEvent: (event) => events.push(event) });
  await Socket.instances[0].emit("open");
  await Socket.instances[0].emit("close"); // server restart: no page navigation
  assert.equal(Socket.instances.length, 2);
  await Socket.instances[1].emit("open");
  assert.deepEqual(Socket.instances[1].sent[0], { type: "embedded-demo:hello", sessionId: "stable-page-session", url: win.location.href });
  await Socket.instances[1].emit("message", { data: JSON.stringify({ type: "embedded-demo:run", id: "after-restart", script: { steps: [{ caption: "still resident", dim: false }] } }) });
  assert.equal(calls.length, 1);
  assert.ok(events.some((event) => event.status === "reconnecting"));
  assert.deepEqual(session.status(), { sessionId: "stable-page-session", status: "bound", retries: 0 });
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
  assert.deepEqual(Object.keys(win.__sassfullyDemo).sort(), ["evidence", "narrate", "resume", "run", "status", "stop", "unlockAudio"]);
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
