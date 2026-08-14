import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddedQADriver, validateQARequest } from "../story-bridge/embedded-qa-driver.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0)); };
  queueMicrotask(() => child.stderr.emit("data", "DevTools listening on ws://127.0.0.1:9222/devtools/browser/fake"));
  return child;
}

function fakeCDP() {
  const calls = [];
  const cdp = {
    calls,
    events: [],
    async call(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Target.createTarget") return { targetId: "page-target" };
      if (method === "Target.attachToTarget") return { sessionId: "page-session" };
      if (method === "Runtime.evaluate" && /sassfully-demo-audio/.test(params.expression ?? "")) return { result: { value: { x: 40, y: 24 } } };
      if (method === "Page.captureScreenshot") {
        cdp.events.push(
          { sessionId: "page-session", method: "Network.requestWillBeSent", params: { requestId: "r1", request: { method: "GET", url: "http://127.0.0.1:8932/health", headers: {} } } },
          { sessionId: "page-session", method: "Network.responseReceived", params: { requestId: "r1", response: { status: 200, statusText: "OK", headers: {}, mimeType: "application/json", encodedDataLength: 2 } } },
          { sessionId: "page-session", method: "Network.loadingFinished", params: { requestId: "r1" } },
        );
        return { data: Buffer.from("png-test-bytes").toString("base64") };
      }
      if (method === "Network.getResponseBody") return { body: "{}", base64Encoded: false };
      return { result: { value: true } };
    },
    close() { cdp.closed = true; },
  };
  return cdp;
}

test("QA screenshot temporarily removes Kitsoki chrome and preserves exported evidence after qa_stop", async () => {
  const cdp = fakeCDP();
  const root = await mkdtemp(join(tmpdir(), "sassfully-qa-driver-test-"));
  let directories = 0;
  const driver = createEmbeddedQADriver({
    beforeScreenshot: async () => {},
    runtime: {
      chrome: "fake-chrome",
      spawn: () => fakeChild(),
      mkdtemp: async () => {
        const directory = join(root, directories++ === 0 ? "profile" : "evidence");
        await mkdir(directory);
        return directory;
      },
      tmpdir: () => root,
      json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fake" }),
      createCDP: async () => cdp,
    },
  });

  const started = await driver.start({ url: "http://127.0.0.1:8932/" });
  await driver.captureStart(started.qaSessionId);
  const screenshot = await driver.action({ qaSessionId: started.qaSessionId, operation: "screenshot" });
  const rawScreenshot = await driver.cdp({ qaSessionId: started.qaSessionId, method: "Page.captureScreenshot", params: { format: "png" } });
  const evidence = await driver.captureExport(started.qaSessionId);
  const har = await driver.harExport(started.qaSessionId);
  const stopped = await driver.stop(started.qaSessionId);

  assert.equal(screenshot.chrome, "suppressed");
  assert.equal(rawScreenshot.chrome, "suppressed");
  assert.deepEqual(await readFile(screenshot.screenshotPath), Buffer.from("png-test-bytes"));
  assert.deepEqual(evidence.screenshotPaths, [screenshot.screenshotPath]);
  assert.match(await readFile(evidence.evidencePath, "utf8"), /sassfully\/qa-evidence\/v1/);
  assert.match(await readFile(har.harPath, "utf8"), /"status": 200/);
  await assert.rejects(access(join(root, "profile")));
  await access(stopped.evidenceDir);
  await access(screenshot.screenshotPath);
  await access(evidence.evidencePath);
  await access(har.harPath);
  assert.equal(cdp.closed, true);

  const capture = cdp.calls.filter(({ method }) => method === "Page.captureScreenshot");
  assert.equal(capture.length, 2);
  for (const item of capture) {
    const screenshotIndex = cdp.calls.indexOf(item);
    assert.match(cdp.calls[screenshotIndex - 1].params.expression, /data-kitsoki-chrome/);
    assert.match(cdp.calls[screenshotIndex + 1].params.expression, /insertBefore/);
  }
});

test("QA start privately marks its owned page for the test-only audio lane", async () => {
  const cdp = fakeCDP();
  const root = await mkdtemp(join(tmpdir(), "sassfully-qa-audio-test-"));
  let directories = 0;
  const driver = createEmbeddedQADriver({ runtime: {
    chrome: "fake-chrome", spawn: () => fakeChild(),
    mkdtemp: async () => { const directory = join(root, directories++ === 0 ? "profile" : "evidence"); await mkdir(directory); return directory; },
    tmpdir: () => root, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fake" }), createCDP: async () => cdp,
  } });
  const started = await driver.start({ url: "http://127.0.0.1:8932/?demo=1" });
  assert.match(started.url, /[?&]__sassfully_qa_audio_test=1/);
  assert.deepEqual(driver.requireTestAudioMode(started.qaSessionId), { qaSessionId: started.qaSessionId, mode: "qa-cdp", url: started.url });
  await driver.stop(started.qaSessionId);
});

test("QA test audio activation clicks only the visible fixed control through owned CDP input", async () => {
  const cdp = fakeCDP(); const root = await mkdtemp(join(tmpdir(), "sassfully-qa-audio-activation-")); let directories = 0;
  const driver = createEmbeddedQADriver({ runtime: {
    chrome: "fake-chrome", spawn: () => fakeChild(),
    mkdtemp: async () => { const directory = join(root, directories++ === 0 ? "profile" : "evidence"); await mkdir(directory); return directory; },
    tmpdir: () => root, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fake" }), createCDP: async () => cdp,
  } });
  const started = await driver.start({ url: "http://127.0.0.1:8932/" });
  const receipt = await driver.activateTestAudio(started.qaSessionId);
  assert.deepEqual(receipt.activation, { source: "qa-cdp-input", selector: '[data-testid="sassfully-demo-audio"]', x: 40, y: 24 });
  const input = cdp.calls.filter(({ method }) => method === "Input.dispatchMouseEvent");
  assert.deepEqual(input.map(({ params }) => params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  await driver.stop(started.qaSessionId);
});

// --- --allow-origin / --auth-bearer-env: staging targeting -----------------

function fakeCDPWithFetch() {
  const calls = [];
  const listeners = new Map();
  const cdp = {
    calls,
    events: [],
    on(method, sessionId, handler) { listeners.set(`${method} ${sessionId}`, handler); },
    trigger(method, sessionId, params) { listeners.get(`${method} ${sessionId}`)?.(params); },
    async call(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Target.createTarget") return { targetId: "page-target" };
      if (method === "Target.attachToTarget") return { sessionId: "page-session" };
      return { result: { value: true } };
    },
    close() { cdp.closed = true; },
  };
  return cdp;
}

function fakeDriverRuntime(cdp, root, directories) {
  return {
    chrome: "fake-chrome",
    spawn: () => fakeChild(),
    mkdtemp: async () => { const directory = join(root, directories.n++ === 0 ? "profile" : "evidence"); await mkdir(directory); return directory; },
    tmpdir: () => root,
    json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fake" }),
    createCDP: async () => cdp,
  };
}

test("RED: qa_start refuses a non-loopback URL exactly as before when no --allow-origin is configured", () => {
  assert.equal(
    validateQARequest({ action: "qa_start", url: "https://staging.kitsoki.dev/", mode: "headless" }),
    "qa_start.url must be an absolute loopback http(s) URL",
  );
  // No `{ allowedOrigins }` option at all -- the exact call shape used before
  // this feature existed -- must still refuse identically.
  assert.equal(
    validateQARequest({ action: "qa_start", url: "https://example.com/" }),
    "qa_start.url must be an absolute loopback http(s) URL",
  );
});

test("GREEN: qa_start accepts a URL on an explicitly allowlisted origin, and still refuses everything else", () => {
  const allowedOrigins = new Set(["https://staging.kitsoki.dev"]);
  assert.equal(validateQARequest({ action: "qa_start", url: "https://staging.kitsoki.dev/tour", mode: "headless" }, { allowedOrigins }), null);
  assert.equal(validateQARequest({ action: "qa_start", url: "http://127.0.0.1:8932/" }, { allowedOrigins }), null, "loopback stays admitted alongside the allowlist");
  assert.match(
    validateQARequest({ action: "qa_start", url: "https://not-allowlisted.example.com/" }, { allowedOrigins }),
    /explicitly allowlisted origin/,
  );
  assert.match(
    validateQARequest({ action: "qa_start", url: "https://staging.kitsoki.dev.evil.example.com/" }, { allowedOrigins }),
    /explicitly allowlisted origin/,
    "a lookalike host must not match by prefix",
  );
});

test("qa_start against an allowlisted remote origin attaches the named-env bearer only to same-origin requests, never third parties", async () => {
  process.env.SASSFULLY_TEST_BEARER = "s3cr3t-staging-token";
  try {
    const cdp = fakeCDPWithFetch();
    const root = await mkdtemp(join(tmpdir(), "sassfully-qa-allowlist-"));
    const directories = { n: 0 };
    const driver = createEmbeddedQADriver({
      allowedOrigins: new Set(["https://staging.kitsoki.dev"]),
      authBearerEnv: "SASSFULLY_TEST_BEARER",
      runtime: fakeDriverRuntime(cdp, root, directories),
    });
    const started = await driver.start({ url: "https://staging.kitsoki.dev/tour" });
    assert.equal(started.origin, "https://staging.kitsoki.dev");
    assert.equal(started.authBearer, "attached");
    assert.ok(cdp.calls.some((c) => c.method === "Fetch.enable"), "Fetch interception is armed before navigation");
    assert.ok(cdp.calls.some((c) => c.method === "Page.navigate" && c.params.url === started.url), "navigation happens AFTER interception is armed, not before");

    cdp.trigger("Fetch.requestPaused", "page-session", { requestId: "req-doc", request: { url: "https://staging.kitsoki.dev/tour", headers: { "User-Agent": "x" } } });
    cdp.trigger("Fetch.requestPaused", "page-session", { requestId: "req-cdn", request: { url: "https://cdn.example.com/font.woff2", headers: {} } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const same = cdp.calls.find((c) => c.method === "Fetch.continueRequest" && c.params.requestId === "req-doc");
    assert.ok(same);
    assert.equal(same.params.headers.find((h) => h.name === "Authorization")?.value, "Bearer s3cr3t-staging-token");

    const thirdParty = cdp.calls.find((c) => c.method === "Fetch.continueRequest" && c.params.requestId === "req-cdn");
    assert.ok(thirdParty);
    assert.equal(thirdParty.params.headers.some((h) => h.name === "Authorization"), false, "the bearer must never leak to a third-party subresource origin");

    await driver.stop(started.qaSessionId);
  } finally { delete process.env.SASSFULLY_TEST_BEARER; }
});

test("qa_start against an allowlisted origin refuses cleanly when the named bearer env var is unset", async () => {
  delete process.env.SASSFULLY_TEST_BEARER_MISSING;
  const cdp = fakeCDPWithFetch();
  const root = await mkdtemp(join(tmpdir(), "sassfully-qa-missing-bearer-"));
  const directories = { n: 0 };
  const driver = createEmbeddedQADriver({
    allowedOrigins: new Set(["https://staging.kitsoki.dev"]),
    authBearerEnv: "SASSFULLY_TEST_BEARER_MISSING",
    runtime: fakeDriverRuntime(cdp, root, directories),
  });
  await assert.rejects(
    driver.start({ url: "https://staging.kitsoki.dev/tour" }),
    /requires env var SASSFULLY_TEST_BEARER_MISSING/,
  );
});

test("qa_start against a loopback URL never reads the bearer env var, even when --auth-bearer-env is configured", async () => {
  process.env.SASSFULLY_TEST_BEARER_UNUSED = "should-never-be-read";
  try {
    const cdp = fakeCDP();
    const root = await mkdtemp(join(tmpdir(), "sassfully-qa-loopback-no-bearer-"));
    let directories = 0;
    const driver = createEmbeddedQADriver({
      allowedOrigins: new Set(["https://staging.kitsoki.dev"]),
      authBearerEnv: "SASSFULLY_TEST_BEARER_UNUSED",
      runtime: {
        chrome: "fake-chrome", spawn: () => fakeChild(),
        mkdtemp: async () => { const directory = join(root, directories++ === 0 ? "profile" : "evidence"); await mkdir(directory); return directory; },
        tmpdir: () => root, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fake" }), createCDP: async () => cdp,
      },
    });
    const started = await driver.start({ url: "http://127.0.0.1:8932/" });
    assert.equal(started.origin, undefined);
    assert.equal(cdp.calls.some((c) => c.method === "Fetch.enable"), false);
    await driver.stop(started.qaSessionId);
  } finally { delete process.env.SASSFULLY_TEST_BEARER_UNUSED; }
});

test("HAR/evidence export redacts the Authorization header by name, not by pattern-matching its value", async () => {
  const cdp = fakeCDP();
  const root = await mkdtemp(join(tmpdir(), "sassfully-qa-redact-"));
  let directories = 0;
  const driver = createEmbeddedQADriver({ runtime: {
    chrome: "fake-chrome", spawn: () => fakeChild(),
    mkdtemp: async () => { const directory = join(root, directories++ === 0 ? "profile" : "evidence"); await mkdir(directory); return directory; },
    tmpdir: () => root, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fake" }), createCDP: async () => cdp,
  } });
  const started = await driver.start({ url: "http://127.0.0.1:8932/" });
  await driver.captureStart(started.qaSessionId);
  // Push a request/response pair carrying a real bearer credential, in the
  // shape captureExport actually reads (event.params.request/response).
  cdp.events.push(
    { sessionId: "page-session", method: "Network.requestWillBeSent", params: { requestId: "req-auth", request: { method: "GET", url: "https://staging.kitsoki.dev/rpc", headers: { Authorization: "Bearer s3cr3t-staging-token", Cookie: "session=abc123" } } } },
    { sessionId: "page-session", method: "Network.responseReceived", params: { requestId: "req-auth", response: { status: 200, statusText: "OK", headers: { "Set-Cookie": "session=abc123; Path=/" }, mimeType: "application/json", encodedDataLength: 2 } } },
    { sessionId: "page-session", method: "Network.loadingFinished", params: { requestId: "req-auth" } },
  );
  const evidence = await driver.captureExport(started.qaSessionId);
  const har = await driver.harExport(started.qaSessionId);
  const raw = JSON.stringify(evidence) + JSON.stringify(har);
  assert.doesNotMatch(raw, /s3cr3t-staging-token/, "the bearer value must not appear anywhere in exported evidence");
  assert.doesNotMatch(raw, /abc123/, "the cookie value must not appear anywhere in exported evidence");
  const entry = har.log.entries.find((e) => e.request.url === "https://staging.kitsoki.dev/rpc");
  assert.equal(entry.request.headers.find((h) => h.name === "Authorization").value, "[REDACTED]");
  assert.equal(entry.request.headers.find((h) => h.name === "Cookie").value, "[REDACTED]");
  assert.equal(entry.response.headers.find((h) => h.name === "Set-Cookie").value, "[REDACTED]");
  await driver.stop(started.qaSessionId);
});
