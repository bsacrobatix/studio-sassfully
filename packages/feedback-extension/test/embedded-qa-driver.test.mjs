import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundSnapshotDigest, createEmbeddedQADriver, resolveChromeExecutable, SNAPSHOT_FULL_MAX_CHARS, SNAPSHOT_LIMITS, validateQARequest } from "../story-bridge/embedded-qa-driver.mjs";

test("Chromium executable selection keeps an explicit operator override on every platform", () => {
  assert.equal(resolveChromeExecutable({ env: { SASSFULLY_CHROME_BIN: " /opt/owned-chrome " }, platform: "linux" }), "/opt/owned-chrome");
});

test("Chromium executable selection uses each platform's native default instead of a macOS bundle on Linux CI", () => {
  assert.equal(resolveChromeExecutable({ env: {}, platform: "darwin" }), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.equal(resolveChromeExecutable({ env: {}, platform: "linux" }), "google-chrome");
  assert.equal(resolveChromeExecutable({ env: { ProgramFiles: "C:\\Program Files" }, platform: "win32" }), "C:\\Program Files/Google/Chrome/Application/chrome.exe");
});

test("qa_start turns an unavailable Chromium executable into a bounded error and removes its disposable directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "sassfully-qa-launch-error-"));
  let directories = 0;
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = () => false;
  const driver = createEmbeddedQADriver({ runtime: {
    chrome: "missing-chrome",
    spawn: () => {
      queueMicrotask(() => child.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" })));
      return child;
    },
    mkdtemp: async () => {
      const directory = join(root, directories++ === 0 ? "profile" : "evidence");
      await mkdir(directory);
      return directory;
    },
    tmpdir: () => root,
  } });

  await assert.rejects(driver.start({ url: "http://127.0.0.1:8932/" }), /Chromium failed to launch \(ENOENT\)/);
  await assert.rejects(access(join(root, "profile")));
  await assert.rejects(access(join(root, "evidence")));
});

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

function fakeDriverRuntime(cdp, root, directories, overrides = {}) {
  return {
    chrome: "fake-chrome",
    spawn: () => fakeChild(),
    mkdtemp: async () => { const directory = join(root, directories.n++ === 0 ? "profile" : "evidence"); await mkdir(directory); return directory; },
    tmpdir: () => root,
    json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fake" }),
    createCDP: async () => cdp,
    // Every test that does not care about the Keychain fallback gets a
    // deterministic "no entry found" resolver -- never the real `security`
    // binary, per the rule that only a fake/injected resolver is used in
    // tests, never a real Keychain lookup.
    resolveKeychainSecret: async () => null,
    ...overrides,
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

// --- Local Network Access: real Chrome blocks a public-origin page's plain
// ws://127.0.0.1 connection with net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS
// (empirically confirmed: headless Chrome 151.0.7922.138, a page on
// https://example.com, a real ws-handshake server on 127.0.0.1 -- see
// bootstrap-tracking.md SASS-STAGING entry for the probe). The owned QA
// Chromium must launch with the feature disabled, but ONLY for a
// remote-origin session -- a loopback qa_start keeps today's exact args.

function launchArgsCapture() {
  const calls = [];
  return { calls, spawn: (bin, args, opts) => { calls.push({ bin, args, opts }); return fakeChild(); } };
}

test("RED (regression): a loopback qa_start launches Chromium with today's exact args -- no LocalNetworkAccessChecks flag", async () => {
  const cdp = fakeCDP();
  const root = await mkdtemp(join(tmpdir(), "sassfully-qa-lna-loopback-"));
  const directories = { n: 0 };
  const capture = launchArgsCapture();
  const driver = createEmbeddedQADriver({ runtime: fakeDriverRuntime(cdp, root, directories, capture) });
  const started = await driver.start({ url: "http://127.0.0.1:8932/" });
  assert.equal(capture.calls.length, 1);
  assert.equal(capture.calls[0].args.some((a) => a.includes("LocalNetworkAccessChecks")), false, "a loopback launch must not carry the LNA-disabling flag");
  await driver.stop(started.qaSessionId);
});

test("GREEN: a qa_start against an allowlisted remote origin launches Chromium with --disable-features=LocalNetworkAccessChecks", async () => {
  const cdp = fakeCDP();
  const root = await mkdtemp(join(tmpdir(), "sassfully-qa-lna-remote-"));
  const directories = { n: 0 };
  const capture = launchArgsCapture();
  const driver = createEmbeddedQADriver({
    allowedOrigins: new Set(["https://staging.kitsoki.dev"]),
    runtime: fakeDriverRuntime(cdp, root, directories, capture),
  });
  const started = await driver.start({ url: "https://staging.kitsoki.dev/tour" });
  assert.equal(capture.calls.length, 1);
  assert.ok(capture.calls[0].args.includes("--disable-features=LocalNetworkAccessChecks"), "a remote-origin launch must carry the LNA-disabling flag");
  await driver.stop(started.qaSessionId);
});

test("qa_start against an allowlisted remote origin carries the LNA flag alongside headed/headless mode, not instead of it", async () => {
  const cdp = fakeCDP();
  const root = await mkdtemp(join(tmpdir(), "sassfully-qa-lna-headed-"));
  const directories = { n: 0 };
  const capture = launchArgsCapture();
  const driver = createEmbeddedQADriver({
    allowedOrigins: new Set(["https://staging.kitsoki.dev"]),
    runtime: fakeDriverRuntime(cdp, root, directories, capture),
  });
  const started = await driver.start({ url: "https://staging.kitsoki.dev/tour", mode: "headed" });
  assert.ok(capture.calls[0].args.includes("--disable-features=LocalNetworkAccessChecks"));
  assert.equal(capture.calls[0].args.some((a) => a === "--headless=new"), false, "headed mode must not add --headless=new");
  await driver.stop(started.qaSessionId);
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

test("qa_start against an allowlisted origin refuses cleanly when the named bearer env var is unset and the Keychain has no matching entry", async () => {
  delete process.env.SASSFULLY_TEST_BEARER_MISSING;
  const cdp = fakeCDPWithFetch();
  const root = await mkdtemp(join(tmpdir(), "sassfully-qa-missing-bearer-"));
  const directories = { n: 0 };
  let keychainCall = null;
  let spawned = false;
  const driver = createEmbeddedQADriver({
    allowedOrigins: new Set(["https://staging.kitsoki.dev"]),
    authBearerEnv: "SASSFULLY_TEST_BEARER_MISSING",
    // Injected fake resolver -- never the real `security` binary in a test.
    runtime: fakeDriverRuntime(cdp, root, directories, {
      spawn: () => { spawned = true; return fakeChild(); },
      resolveKeychainSecret: async (args) => { keychainCall = args; return null; },
    }),
  });
  await assert.rejects(
    driver.start({ url: "https://staging.kitsoki.dev/tour" }),
    /requires env var SASSFULLY_TEST_BEARER_MISSING \(or a Keychain entry -s SASSFULLY_TEST_BEARER_MISSING -a kitsoki-staging\)/,
  );
  // Service defaults to the env var name, account to "kitsoki-staging" --
  // the operator's actual `security find-generic-password -a kitsoki-staging
  // -s KITSOKI_STAGING_SERVICE_TOKEN -w` shape -- when neither flag is set.
  assert.deepEqual(keychainCall, { service: "SASSFULLY_TEST_BEARER_MISSING", account: "kitsoki-staging" });
  assert.equal(spawned, false, "a missing remote bearer must refuse before allocating or launching Chromium");
  assert.equal(directories.n, 0, "a missing remote bearer must not leave disposable profile or evidence directories");
});

test("qa_start falls back to a Keychain-resolved bearer when the named env var is absent, and attaches it identically to the env-var path", async () => {
  delete process.env.SASSFULLY_TEST_BEARER_KEYCHAIN;
  const cdp = fakeCDPWithFetch();
  const root = await mkdtemp(join(tmpdir(), "sassfully-qa-keychain-bearer-"));
  const directories = { n: 0 };
  const driver = createEmbeddedQADriver({
    allowedOrigins: new Set(["https://staging.kitsoki.dev"]),
    authBearerEnv: "SASSFULLY_TEST_BEARER_KEYCHAIN",
    authBearerKeychainService: "custom-service",
    authBearerKeychainAccount: "custom-account",
    runtime: fakeDriverRuntime(cdp, root, directories, {
      resolveKeychainSecret: async ({ service, account }) => (service === "custom-service" && account === "custom-account" ? "k3ychain-staging-token" : null),
    }),
  });
  const started = await driver.start({ url: "https://staging.kitsoki.dev/tour" });
  assert.equal(started.authBearer, "attached");
  cdp.trigger("Fetch.requestPaused", "page-session", { requestId: "req-doc", request: { url: "https://staging.kitsoki.dev/tour", headers: {} } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const continued = cdp.calls.find((c) => c.method === "Fetch.continueRequest" && c.params.requestId === "req-doc");
  assert.equal(continued.params.headers.find((h) => h.name === "Authorization")?.value, "Bearer k3ychain-staging-token");
  await driver.stop(started.qaSessionId);
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

test("the SAME redaction covers a Keychain-resolved bearer end to end: attached via Fetch interception, then redacted on export", async () => {
  delete process.env.SASSFULLY_TEST_BEARER_REDACT_KEYCHAIN;
  const cdp = fakeCDPWithFetch();
  const root = await mkdtemp(join(tmpdir(), "sassfully-qa-redact-keychain-"));
  const directories = { n: 0 };
  const driver = createEmbeddedQADriver({
    allowedOrigins: new Set(["https://staging.kitsoki.dev"]),
    authBearerEnv: "SASSFULLY_TEST_BEARER_REDACT_KEYCHAIN",
    runtime: fakeDriverRuntime(cdp, root, directories, { resolveKeychainSecret: async () => "keychain-only-s3cr3t" }),
  });
  const started = await driver.start({ url: "https://staging.kitsoki.dev/rpc" });
  assert.equal(started.authBearer, "attached");
  await driver.captureStart(started.qaSessionId);
  // Simulate Chrome having actually sent the header the Fetch interceptor
  // attached (rather than re-asserting the interceptor itself, which the
  // earlier allowlist test already covers) -- the point here is redaction.
  cdp.trigger("Fetch.requestPaused", "page-session", { requestId: "req-doc", request: { url: "https://staging.kitsoki.dev/rpc", headers: {} } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const continued = cdp.calls.find((c) => c.method === "Fetch.continueRequest" && c.params.requestId === "req-doc");
  const attachedHeaders = Object.fromEntries(continued.params.headers.map((h) => [h.name, h.value]));
  assert.equal(attachedHeaders.Authorization, "Bearer keychain-only-s3cr3t");
  cdp.events.push(
    { sessionId: "page-session", method: "Network.requestWillBeSent", params: { requestId: "req-doc", request: { method: "GET", url: "https://staging.kitsoki.dev/rpc", headers: attachedHeaders } } },
    { sessionId: "page-session", method: "Network.responseReceived", params: { requestId: "req-doc", response: { status: 200, statusText: "OK", headers: {}, mimeType: "application/json", encodedDataLength: 2 } } },
    { sessionId: "page-session", method: "Network.loadingFinished", params: { requestId: "req-doc" } },
  );
  const evidence = await driver.captureExport(started.qaSessionId);
  const har = await driver.harExport(started.qaSessionId);
  const raw = JSON.stringify(evidence) + JSON.stringify(har);
  assert.doesNotMatch(raw, /keychain-only-s3cr3t/, "a Keychain-sourced bearer must be redacted identically to an env-var-sourced one");
  const entry = har.log.entries.find((e) => e.request.url === "https://staging.kitsoki.dev/rpc");
  assert.equal(entry.request.headers.find((h) => h.name === "Authorization").value, "[REDACTED]");
  await driver.stop(started.qaSessionId);
});

// --- Bounded observation: qa_action snapshot / screenshot -------------------
//
// Measured defect (2026-08-16, a local dev app): `qa_action
// {operation:"snapshot"}` returned 265,507 characters on a SINGLE line. That
// is past the MCP tool-result limit, so it spilled to a temp file whose lines
// were then too long to read back in chunks -- an agent could not read its own
// observation at all, and fell back to screenshots.

// A minimal fake document. The package has zero dependencies on purpose, so
// there is no jsdom here; `querySelectorAll` answers the three selector
// constants the page-side digest builder actually asks for, which is what the
// digest's mapping, naming, selector-generation and caps need to be exercised.
function fakeElement(tag, attributes = {}, textContent = "") {
  return {
    tagName: tag.toUpperCase(),
    id: attributes.id ?? "",
    textContent,
    disabled: attributes.disabled === true,
    children: [],
    parentElement: null,
    hasAttribute: (name) => attributes[name] != null,
    getAttribute: (name) => (attributes[name] == null ? null : String(attributes[name])),
    getClientRects: () => [{}],
  };
}

function fakePage({ interactive = [], headings = [], landmarks = [], htmlChars = 1000, title = "Runboard" } = {}) {
  const body = fakeElement("body");
  const html = fakeElement("html");
  html.children = [body];
  body.parentElement = html;
  body.children = [...interactive, ...headings, ...landmarks];
  for (const node of body.children) node.parentElement = body;
  html.outerHTML = "<".padEnd(htmlChars, "x");
  const all = [html, body, ...body.children];
  const document = {
    title,
    documentElement: html,
    querySelectorAll(selectors) {
      if (selectors === "*") return all;
      if (selectors.startsWith("a[href]")) return interactive;
      if (selectors.startsWith("h1, h2")) return headings;
      return landmarks;
    },
  };
  return { document, location: { href: "http://127.0.0.1:8932/home" }, getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
}

// A CDP fake that serves BOTH shapes of snapshot request, so one test file is
// a valid red proof against the pre-fix driver and a valid green proof after:
// the old driver asks for `document.documentElement.outerHTML` and gets the
// wall; the new one ships a serialized digest builder, which this evaluates
// for real against the fake page.
function fakeCDPWithPage(page, { pngBytes = "png-test-bytes" } = {}) {
  const calls = [];
  const cdp = {
    calls,
    events: [],
    async call(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Target.createTarget") return { targetId: "page-target" };
      if (method === "Target.attachToTarget") return { sessionId: "page-session" };
      if (method === "Page.captureScreenshot") return { data: Buffer.from(pngBytes).toString("base64") };
      if (method === "Runtime.evaluate") {
        const expression = params.expression ?? "";
        if (expression === "document.documentElement.outerHTML") return { result: { value: page.document.documentElement.outerHTML } };
        if (expression.startsWith("(function snapshotDigestInPage")) {
          const build = new Function("document", "location", "getComputedStyle", `return (${expression});`);
          return { result: { value: build(page.document, page.location, page.getComputedStyle) } };
        }
        return { result: { value: true } };
      }
      return { result: { value: true } };
    },
    close() { cdp.closed = true; },
  };
  return cdp;
}

async function startDriverOn(page, options = {}, cdpOverride = null) {
  const cdp = cdpOverride ?? fakeCDPWithPage(page);
  const root = await mkdtemp(join(tmpdir(), "sassfully-qa-snapshot-"));
  const directories = { n: 0 };
  const driver = createEmbeddedQADriver({ ...options, runtime: fakeDriverRuntime(cdp, root, directories, options.runtime ?? {}) });
  const started = await driver.start({ url: "http://127.0.0.1:8932/home" });
  return { driver, cdp, started };
}

function busyPage() {
  const interactive = Array.from({ length: 400 }, (_, index) =>
    fakeElement("button", { "aria-label": `Open the very long accessible name for record number ${index} in the workbench` }, ""));
  const headings = Array.from({ length: 30 }, (_, index) => fakeElement(`h${(index % 6) + 1}`, {}, `Section heading ${index}`));
  const landmarks = [fakeElement("main", { "aria-label": "Runboard" }), fakeElement("nav", { "aria-label": "Primary" })];
  return fakePage({ interactive, headings, landmarks, htmlChars: 265_507 });
}

test("RED: qa_action snapshot returns a BOUNDED structured digest, not the raw document", async () => {
  const page = busyPage();
  const { driver, started } = await startDriverOn(page);
  const snapshot = await driver.action({ qaSessionId: started.qaSessionId, operation: "snapshot" });

  const size = JSON.stringify(snapshot).length;
  assert.ok(size <= 32_768, `a snapshot must be readable in one MCP tool result; this one is ${size} characters (the raw document is ${page.document.documentElement.outerHTML.length})`);
  assert.equal(snapshot.detail, "digest");
  assert.equal(snapshot.html, undefined, "the default snapshot must not carry the raw document at all");
  assert.ok(Array.isArray(snapshot.interactive) && snapshot.interactive.length > 0, "a digest must list interactive elements");
  assert.ok(Array.isArray(snapshot.headings) && snapshot.headings.length > 0, "a digest must list headings");
  assert.ok(Array.isArray(snapshot.landmarks) && snapshot.landmarks.length > 0, "a digest must list landmark regions");
  await driver.stop(started.qaSessionId);
});

test("the digest carries what an agent needs to decide what to click, and says where it was cut", async () => {
  const page = busyPage();
  const { driver, started } = await startDriverOn(page);
  const snapshot = await driver.action({ qaSessionId: started.qaSessionId, operation: "snapshot" });

  assert.equal(snapshot.url, "http://127.0.0.1:8932/home");
  assert.equal(snapshot.title, "Runboard");
  // Counts report the TRUE totals even where the lists are capped -- an agent
  // must never mistake a cap for the page being small.
  assert.equal(snapshot.counts.interactive, 400);
  assert.equal(snapshot.counts.headings, 30);
  assert.equal(snapshot.counts.htmlChars, 265_507);
  assert.equal(snapshot.interactive.length, SNAPSHOT_LIMITS.interactive);
  assert.equal(snapshot.truncated.interactive, true, "a capped list must declare itself truncated");
  assert.equal(snapshot.truncated.headings, false);
  const first = snapshot.interactive[0];
  assert.equal(first.role, "button");
  assert.match(first.name, /^Open the very long accessible name for record number 0/);
  assert.ok(first.name.length <= SNAPSHOT_LIMITS.name, `an accessible name must be capped at ${SNAPSHOT_LIMITS.name}; got ${first.name.length}`);
  assert.equal(first.selector, "html > body:nth-child(1) > button:nth-child(1)");
  assert.deepEqual(snapshot.landmarks.map((entry) => [entry.role, entry.name]), [["main", "Runboard"], ["nav", "Primary"]]);
  assert.deepEqual(snapshot.headings[0], { level: 1, text: "Section heading 0", selector: "html > body:nth-child(1) > h1:nth-child(401)" });
  await driver.stop(started.qaSessionId);
});

test("a data-testid becomes the selector, matching the anchor vocabulary the demo player already resolves", async () => {
  const page = fakePage({
    interactive: [fakeElement("button", { "data-testid": "compose-open" }, "Compose"), fakeElement("input", { type: "checkbox", "aria-disabled": "true", "aria-label": "Archived" })],
    headings: [fakeElement("h2", {}, "Inbox")],
    landmarks: [],
  });
  const { driver, started } = await startDriverOn(page);
  const snapshot = await driver.action({ qaSessionId: started.qaSessionId, operation: "snapshot" });
  assert.deepEqual(snapshot.interactive[0], { role: "button", name: "Compose", selector: '[data-testid="compose-open"]', testid: "compose-open" });
  assert.deepEqual(snapshot.interactive[1], { role: "checkbox", name: "Archived", selector: "html > body:nth-child(1) > input:nth-child(2)", disabled: true });
  assert.deepEqual(snapshot.truncated, { interactive: false, headings: false, landmarks: false });
  await driver.stop(started.qaSessionId);
});

test("RED: detail:\"full\" is an explicit opt-in, is itself bounded, and reports the size it was cut from", async () => {
  const page = busyPage();
  const { driver, started } = await startDriverOn(page);
  const snapshot = await driver.action({ qaSessionId: started.qaSessionId, operation: "snapshot", detail: "full" });

  assert.equal(snapshot.detail, "full");
  assert.equal(snapshot.htmlChars, 265_507, "the true document size must be reported");
  assert.equal(snapshot.returnedChars, SNAPSHOT_FULL_MAX_CHARS);
  assert.equal(snapshot.html.length, SNAPSHOT_FULL_MAX_CHARS, `even the opt-in raw dump is bounded at ${SNAPSHOT_FULL_MAX_CHARS}`);
  assert.equal(snapshot.truncated, true);
  assert.match(snapshot.truncationNote, /265507 characters; the first 65536 are returned/);
  await driver.stop(started.qaSessionId);
});

test("RED: qa_action rejects an unknown snapshot detail, and detail on a non-snapshot operation", () => {
  assert.equal(validateQARequest({ action: "qa_action", qaSessionId: "q", operation: "snapshot", detail: "digest" }), null);
  assert.equal(validateQARequest({ action: "qa_action", qaSessionId: "q", operation: "snapshot", detail: "full" }), null);
  assert.equal(validateQARequest({ action: "qa_action", qaSessionId: "q", operation: "snapshot", detail: "everything" }), "qa_action.detail must be digest or full");
  assert.equal(validateQARequest({ action: "qa_action", qaSessionId: "q", operation: "screenshot", detail: "full" }), "qa_action.detail applies only to snapshot");
});

test("boundSnapshotDigest trims the least decision-relevant list first and never exceeds its ceiling", () => {
  const entry = (index) => ({ role: "button", name: `n${index}`.padEnd(80, "x"), selector: `#s${index}` });
  const digest = {
    url: "http://127.0.0.1:8932/", title: "t",
    counts: { elements: 9, interactive: 60, headings: 60, landmarks: 60 },
    interactive: Array.from({ length: 60 }, (_, i) => entry(i)),
    headings: Array.from({ length: 60 }, (_, i) => ({ level: 2, text: `h${i}`.padEnd(80, "x"), selector: `#h${i}` })),
    landmarks: Array.from({ length: 60 }, (_, i) => ({ role: "main", name: `l${i}`.padEnd(80, "x"), selector: `#l${i}` })),
    truncated: { interactive: false, headings: false, landmarks: false },
  };
  assert.ok(JSON.stringify(digest).length > 4096, "the fixture must actually be over the ceiling under test");
  const bounded = boundSnapshotDigest(digest, 4096);
  assert.ok(JSON.stringify(bounded).length <= 4096, `boundSnapshotDigest must respect its ceiling; got ${JSON.stringify(bounded).length}`);
  assert.equal(bounded.landmarks.length, 0, "landmarks are shed before anything else");
  assert.equal(bounded.truncated.landmarks, true, "every trim is declared");
  assert.equal(bounded.counts.interactive, 60, "counts still report the true totals after trimming");
});

// --- Defect 2: a screenshot must never wait on a reply that cannot arrive ---
//
// Measured: `qa_action {operation:"screenshot"}` against a healthy,
// already-loaded local page blew past a 120s caller budget. Cause: the
// pre-screenshot presenter stop (stdio-server.mjs beforeScreenshot ->
// callEmbeddedPage "embedded-demo:stop") inherited callEmbeddedPage's 120_000
// default. A reloaded or navigated page leaves an open socket with nobody left
// to answer, so that reply never arrives.
//
// This is asserted as STATE, not timing: `delay` is injected to fire the
// driver's bound with no wall-clock wait at all, so the green path performs
// zero waiting and cannot be affected by machine load. The sentinel below
// exists only to turn the pre-fix hang into a legible failure instead of a
// silent stall.
test("RED: a presenter stop that can never be answered does not hold the screenshot; the result names what it stopped waiting for", async () => {
  const page = fakePage({ interactive: [fakeElement("button", {}, "Go")] });
  const { driver, started } = await startDriverOn(page, {
    beforeScreenshot: () => new Promise(() => {}), // a reply that can never arrive
    runtime: { delay: () => Promise.resolve() },   // the driver's bound, fired with no wall-clock wait
  });

  let sentinelTimer;
  const sentinel = new Promise((resolve) => { sentinelTimer = setTimeout(() => resolve("HUNG"), 5_000); });
  const outcome = await Promise.race([driver.action({ qaSessionId: started.qaSessionId, operation: "screenshot" }), sentinel]);
  clearTimeout(sentinelTimer);

  assert.notEqual(outcome, "HUNG", "a screenshot must never wait unboundedly on the presenter-stop hook");
  assert.equal(outcome.presenter, "stop_timed_out");
  assert.match(outcome.presenterDetail, /presenter stop did not settle within \d+ms \(waiting for the bound embedded page to acknowledge embedded-demo:stop\); captured anyway/);
  assert.equal(outcome.chrome, "suppressed", "the capture still happened, and still stripped Kitsoki chrome");
  assert.equal(outcome.bytes, Buffer.from("png-test-bytes").length, "the caller still gets the pixels, not just an error");
  await driver.stop(started.qaSessionId);
});

test("a presenter-stop hook that REJECTS is reported by name and still yields the capture", async () => {
  const page = fakePage({ interactive: [fakeElement("button", {}, "Go")] });
  const { driver, started } = await startDriverOn(page, {
    beforeScreenshot: async () => { throw new Error("embedded bridge phase screenshot_presenter_stop timed out after 10000ms waiting for session s1"); },
  });
  const screenshot = await driver.action({ qaSessionId: started.qaSessionId, operation: "screenshot" });
  assert.equal(screenshot.presenter, "stop_failed");
  assert.match(screenshot.presenterDetail, /phase screenshot_presenter_stop timed out after 10000ms/);
  assert.equal(screenshot.chrome, "suppressed");
  await driver.stop(started.qaSessionId);
});

test("a presenter-stop hook that succeeds keeps today's exact receipt", async () => {
  const page = fakePage({ interactive: [fakeElement("button", {}, "Go")] });
  const { driver, started } = await startDriverOn(page, { beforeScreenshot: async () => ({ presenter: "suppressed" }) });
  const screenshot = await driver.action({ qaSessionId: started.qaSessionId, operation: "screenshot" });
  assert.equal(screenshot.presenter, "suppressed");
  assert.equal(screenshot.presenterDetail, undefined);
  await driver.stop(started.qaSessionId);
});
