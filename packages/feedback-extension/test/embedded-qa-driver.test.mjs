import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddedQADriver } from "../story-bridge/embedded-qa-driver.mjs";

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
